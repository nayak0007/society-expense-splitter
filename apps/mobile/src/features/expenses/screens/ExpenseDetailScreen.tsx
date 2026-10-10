import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Linking, ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorScreen } from '@/components/ui/ErrorScreen';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';

import { RevisionChip } from '../components/RevisionChip';
import { SplitTable } from '../components/SplitTable';
import { StatusBadge } from '../components/ExpenseCard';
import { UploadProgress } from '../components/UploadProgress';
import {
  useExpense,
  useExpenseAttachments,
  useExpenseComments,
  useExpenseRevisions,
  useExpenseSplits,
  fetchAttachmentDownloadUrl,
} from '../hooks/use-expense';
import { useAttachmentUploader, useAttachmentUploads } from '../hooks/use-attachment-upload';
import { useExpenseCategoryNames } from '../hooks/use-expenses';
import type { ExpenseAttachmentView } from '../repository/expense.repository';
import { formatAttachmentBytes, scanStatusLabel } from '../schemas/attachment.schemas';
import { formatExpenseDate, formatPaise } from '../schemas/expense.schemas';
import { expenseErrorMessage } from '../services/expense.service';
import { selectActiveMembership, useSocietyStore } from '@/stores/society.store';
import { asMemberId, canOnResource, memberSnapshotOf } from '@ses/domain';

/**
 * One expense (PRD §3.5.3, Roadmap T073): amount, category, date, status, the full split
 * table, the revision history behind the chip, the notes, and the bill section.
 *
 * ## The tenant is never the route parameter
 *
 * `id` comes from the URL, but the society comes from the store inside every hook and is sent
 * as `X-Society-Id`; a forged id for another tenant is answered `404` under RLS and rendered
 * as "not available", so the client never decides scope. The route only chooses *which row*,
 * never *whose*.
 *
 * ## The split total is the server's, not a re-pricing
 *
 * `SplitTable` renders the rows `GET /expenses/:id/splits` returned; the detail screen never
 * computes a share. This mirrors the API's own contract — persisted splits, not a fresh
 * calculation from the participant selector and not a revision snapshot.
 *
 * ## Bills are metadata + a download link, never an inline unscanned image
 *
 * ADR-0012 D3 leaves the serving gate inert while no scanner is configured, but the UI must
 * not imply safety it does not have: an attachment is listed with its name, size and **scan
 * status**, and its bytes are fetched only through a short-lived authorized URL when the user
 * taps Download. Nothing renders an original inline, and no thumbnail is generated — the
 * thumbnail acceptance criterion is deferred (there is no scanner and no thumbnail worker; see
 * the milestone report) rather than faked here.
 */
export default function ExpenseDetailScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const router = useRouter();
  const membership = useSocietyStore(selectActiveMembership);
  const expenseId = params.id ?? null;

  const { expense, isLoading, error, refetch } = useExpense(expenseId);
  const { splits } = useExpenseSplits(expenseId);
  const { revisions } = useExpenseRevisions(expenseId);
  const { comments } = useExpenseComments(expenseId);
  const { attachments } = useExpenseAttachments(expenseId);
  const { names } = useExpenseCategoryNames();
  // Bills this device is still sending for this expense (T076). Read from the upload
  // register rather than from a query, so progress is visible here even when the capture
  // happened on the scanner route this screen pushed.
  const { uploads } = useAttachmentUploads(expenseId);
  const uploader = useAttachmentUploader();
  const [showRevisions, setShowRevisions] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  if (isLoading) {
    return <LoadingIndicator message="Loading expense…" />;
  }

  if (expense === null) {
    return (
      <ErrorScreen
        title="Expense not available"
        description={
          error != null
            ? expenseErrorMessage(error)
            : 'This expense may have been removed, or it belongs to another society.'
        }
        retryLabel="Reload"
        onRetry={refetch}
      />
    );
  }

  const download = async (attachment: ExpenseAttachmentView): Promise<void> => {
    setDownloadError(null);
    try {
      const url = await fetchAttachmentDownloadUrl(attachment.id);
      await Linking.openURL(url);
    } catch (caught: unknown) {
      setDownloadError(expenseErrorMessage(caught));
    }
  };

  /*
    The Edit action (T074) — offered only where editing is actually possible.

    Two conditions, and both are load-bearing. The **lifecycle** one keeps the form off a
    published row: a published edit is T068's recalculation, with a diff and a different response
    shape, and this screen has no room for it. The **authorisation** one is the matrix's own cell
    for editing an expense (`expense.void`, scoped to the caller's own drafts for a Committee
    Member) evaluated through `canOnResource` rather than a role comparison — the same rule the
    API's guard applies, so a hidden button and a refused request always agree.
  */
  const snapshot = membership === null ? null : memberSnapshotOf(membership);
  const editable = expense.status === 'draft' || expense.status === 'pending_approval';
  const canEdit =
    editable &&
    snapshot !== null &&
    canOnResource(snapshot, 'expense.void', {
      kind: 'expense',
      societyId: snapshot.societyId,
      createdByMembershipId: asMemberId(expense.createdBy),
      published: false,
    });

  /*
    Whether this screen offers "Add bill".

    The API's presign route narrows `expense.create` against the **stored** expense, with
    `published = status !== 'draft'` — the same snapshot `attachment.support.ts` builds. Mirroring
    it here means the button and the server agree: a Committee Member sees it on their own draft
    and not on someone else's, and a `void` expense refuses everybody (the lifecycle gate runs
    first on the server, and the button is simply absent here).
  */
  const canAttach =
    snapshot !== null &&
    canOnResource(snapshot, 'expense.create', {
      kind: 'expense',
      societyId: snapshot.societyId,
      createdByMembershipId: asMemberId(expense.createdBy),
      published: expense.status !== 'draft',
    });

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen
        options={{
          title: expense.title,
          // Spread rather than `undefined` (the project sets `exactOptionalPropertyTypes`).
          ...(canEdit
            ? {
                headerRight: () => (
                  <Button
                    variant="text"
                    onPress={() =>
                      router.push({
                        pathname: '/(app)/expenses/[id]/edit',
                        params: { id: expense.id },
                      })
                    }
                  >
                    Edit
                  </Button>
                ),
              }
            : {}),
        }}
      />
      <ScrollView>
        <View className="gap-4 p-lg">
          <Card variant="filled">
            <View className="gap-2">
              <View className="flex-row items-start justify-between gap-3">
                <Text variant="titleMedium" numberOfLines={2}>
                  {expense.title}
                </Text>
                <Text variant="headlineSmall">{formatPaise(expense.amountPaise)}</Text>
              </View>
              <Text variant="bodySmall" color="onSurfaceVariant">
                {[
                  formatExpenseDate(expense.expenseDate),
                  names.get(expense.categoryId) ?? 'Uncategorised',
                ]
                  .filter((part): part is string => part !== null && part.length > 0)
                  .join(' · ')}
              </Text>
              {expense.vendorName !== null ? (
                <Text variant="bodySmall" color="onSurfaceVariant">
                  {`Vendor: ${expense.vendorName}`}
                </Text>
              ) : null}
              {expense.description !== null ? (
                <Text variant="bodyMedium">{expense.description}</Text>
              ) : null}
              <View className="flex-row flex-wrap items-center gap-2">
                <StatusBadge status={expense.status} />
                <RevisionChip
                  revisionCount={revisions.length}
                  onPress={() => setShowRevisions((current) => !current)}
                />
              </View>
            </View>
          </Card>

          {showRevisions ? (
            <Section title="Revision history">
              {revisions.length === 0 ? (
                <Text variant="bodyMedium" color="onSurfaceVariant">
                  This expense has not been revised.
                </Text>
              ) : (
                revisions.map((revision) => (
                  <View key={revision.id} className="gap-1 border-b border-outline-variant pb-2">
                    <Text variant="bodyMedium">{`Version ${String(revision.version)} → ${String(
                      revision.version + 1,
                    )}`}</Text>
                    <Text variant="bodySmall" color="onSurfaceVariant">
                      {`${formatExpenseDate(revision.createdAt.slice(0, 10))}${
                        revision.changeNote === null ? '' : ` · ${revision.changeNote}`
                      }`}
                    </Text>
                  </View>
                ))
              )}
            </Section>
          ) : null}

          <Section title="Split">
            <SplitTable splits={splits} amountPaise={expense.amountPaise} />
          </Section>

          <Section title="Bills">
            {canAttach ? (
              <Button
                variant="tonal"
                size="sm"
                onPress={() =>
                  router.push({
                    pathname: '/(app)/expenses/scan',
                    params: { expenseId: expense.id },
                  })
                }
              >
                Add bill
              </Button>
            ) : null}
            {uploads.length === 0 ? null : (
              <View className="gap-3">
                {uploads.map((upload) => (
                  <UploadProgress
                    key={upload.key}
                    upload={upload}
                    onUpload={undefined}
                    onRetry={() => uploader.retryUpload(upload.key)}
                    onCancel={() => uploader.cancelUpload(upload.key)}
                    onDiscard={() => uploader.discardUpload(upload.key)}
                  />
                ))}
              </View>
            )}
            {attachments.length === 0 ? (
              <Text variant="bodyMedium" color="onSurfaceVariant">
                No bills attached yet.
              </Text>
            ) : (
              attachments.map((attachment) => (
                <View
                  key={attachment.id}
                  className="flex-row items-center justify-between gap-3 border-b border-outline-variant pb-2"
                >
                  <View className="flex-1">
                    <Text variant="bodyMedium" numberOfLines={1}>
                      {attachment.originalFilename}
                    </Text>
                    <Text variant="bodySmall" color="onSurfaceVariant">
                      {`${formatAttachmentBytes(attachment.sizeBytes)} · ${scanStatusLabel(attachment.scanStatus)}`}
                    </Text>
                  </View>
                  <Button
                    variant="text"
                    onPress={() =>
                      router.push({
                        pathname: '/(modals)/attachment/[id]',
                        params: { id: attachment.id },
                      })
                    }
                  >
                    View
                  </Button>
                  <Button variant="text" onPress={() => void download(attachment)}>
                    Download
                  </Button>
                </View>
              ))
            )}
            {downloadError !== null ? (
              <Text variant="bodySmall" color="error">
                {downloadError}
              </Text>
            ) : null}
          </Section>

          <Section title="Notes">
            {comments.length === 0 ? (
              <Text variant="bodyMedium" color="onSurfaceVariant">
                No notes yet.
              </Text>
            ) : (
              comments.map((comment) => (
                <View key={comment.id} className="gap-1 border-b border-outline-variant pb-2">
                  <Text
                    variant="bodyMedium"
                    color={comment.deleted ? 'onSurfaceVariant' : 'onSurface'}
                  >
                    {comment.deleted ? 'This comment was removed.' : (comment.body ?? '')}
                  </Text>
                  <Text variant="bodySmall" color="outline">
                    {formatExpenseDate(comment.createdAt.slice(0, 10))}
                  </Text>
                </View>
              ))
            )}
          </Section>
        </View>
      </ScrollView>
    </View>
  );
}

/** A titled card section — keeps the screen's job (composing reads) readable. */
function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Card variant="outlined">
      <View className="gap-2">
        <Text variant="titleSmall">{title}</Text>
        {children}
      </View>
    </Card>
  );
}
