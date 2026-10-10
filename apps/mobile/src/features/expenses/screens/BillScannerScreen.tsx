import { useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';

import { AttachmentGrid } from '../components/AttachmentGrid';
import { useExpenseAttachments } from '../hooks/use-expense';
import {
  useAttachmentUploader,
  useAttachmentUploads,
  useStagedAttachments,
} from '../hooks/use-attachment-upload';
import type { ExpenseAttachmentView } from '../repository/expense.repository';

/**
 * The bill scanner — Roadmap T076, PRD screen #31.
 *
 * ## Two entry points, one screen, and the difference is the parent
 *
 * `expenseId` is optional, and that is the whole unsaved-expense design (audit §8):
 *
 *  - **With an id** (from the expense detail, or an edit form): a captured file becomes a
 *    `ready` upload on that expense and can be sent from here.
 *  - **Without an id** (from the create form): the presign route needs a persisted parent,
 *    so the file is *staged* — prepared, hashed and held locally — and the form adopts it
 *    the moment the expense is created. Nothing is reserved against a nonexistent expense,
 *    and no temporary server-side attachment API is invented.
 *
 * ## A capture is not an upload
 *
 * The picker produces a **prepared** file; the user then taps **Upload**. The Roadmap's
 * "require an explicit user action" is why, and it is also why the prepared size and a
 * preview are shown first: the file may be 380 KB or 8 MB, and the user is entitled to
 * know before a reservation exists.
 *
 * ## Nothing here claims a scan happened
 *
 * A completed upload is labelled "not yet security-scanned" (ADR-0012 D3: no scanner
 * exists). Stored bills carry their own `scanStatus` from the server.
 */
export default function BillScannerScreen({
  expenseId,
}: {
  /** The parent expense, or `null` when this capture belongs to an unsaved draft. */
  readonly expenseId: string | null;
}) {
  const router = useRouter();
  const uploader = useAttachmentUploader();
  const { uploads } = useAttachmentUploads(expenseId);
  const { staged } = useStagedAttachments();
  const { attachments } = useExpenseAttachments(expenseId);

  const visibleUploads = expenseId === null ? staged : uploads;
  const hasReady = visibleUploads.some((item) => item.state === 'ready');

  const openAttachment = (attachment: ExpenseAttachmentView): void => {
    router.push({
      pathname: '/(modals)/attachment/[id]',
      params: { id: attachment.id },
    });
  };

  return (
    <View className="flex-1 bg-surface">
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        <View className="gap-4 p-lg">
          <Card variant="filled">
            <View className="gap-1">
              <Text variant="titleSmall">Capture a bill</Text>
              <Text variant="bodySmall" color="onSurfaceVariant">
                {expenseId === null
                  ? 'The bill is prepared now and attached when you save the expense.'
                  : 'Photos are cropped, resized to 1600 px and compressed before they are sent.'}
              </Text>
            </View>
          </Card>

          {uploader.error !== null ? (
            <Card variant="filled">
              <Text variant="bodyMedium" color="error">
                {uploader.error}
              </Text>
            </Card>
          ) : null}

          {uploader.notice !== null ? (
            <Card variant="outlined">
              <Text variant="bodyMedium" color="onSurfaceVariant">
                {uploader.notice}
              </Text>
            </Card>
          ) : null}

          {uploader.isPreparing ? (
            <View className="items-center gap-2 py-6">
              <LoadingIndicator message="Preparing the file…" />
            </View>
          ) : null}

          <View className="gap-2">
            <Button
              variant="filled"
              disabled={uploader.isPreparing}
              onPress={() => void uploader.takePhoto(expenseId)}
            >
              Take photo
            </Button>
            <Button
              variant="outlined"
              disabled={uploader.isPreparing}
              onPress={() => void uploader.chooseImage(expenseId)}
            >
              Choose from gallery
            </Button>
            <Button
              variant="outlined"
              disabled={uploader.isPreparing}
              onPress={() => void uploader.chooseDocument(expenseId)}
            >
              Choose a PDF
            </Button>
          </View>

          {expenseId !== null && hasReady ? (
            <Button variant="tonal" onPress={() => uploader.uploadAllForExpense(expenseId)}>
              Upload all ready files
            </Button>
          ) : null}

          <View className="gap-2">
            <Text variant="titleSmall">Bills</Text>
            <AttachmentGrid
              attachments={attachments}
              uploads={visibleUploads}
              onOpenAttachment={openAttachment}
              onUpload={uploader.upload}
              onRetry={uploader.retryUpload}
              onCancel={uploader.cancelUpload}
              onDiscard={uploader.discardUpload}
              emptyMessage={
                expenseId === null
                  ? 'No bill prepared yet. Capture or choose a file above.'
                  : 'No bills attached yet.'
              }
            />
          </View>

          <Button variant="text" onPress={() => router.back()}>
            Done
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}
