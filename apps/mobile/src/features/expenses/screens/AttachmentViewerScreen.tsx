import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorScreen } from '@/components/ui/ErrorScreen';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';
import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';

import { ZoomableImage } from '../components/ZoomableImage';
import type { ExpenseAttachmentDownload } from '../repository/expense.repository';
import { formatAttachmentBytes, scanStatusLabel } from '../schemas/attachment.schemas';
import { expenseErrorMessage, requestAttachmentDownloadUrl } from '../services/expense.service';

type ViewerState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly download: ExpenseAttachmentDownload }
  | { readonly status: 'error'; readonly message: string; readonly retryable: boolean };

/**
 * The attachment viewer — Roadmap T076, PRD screen #34.
 *
 * ## The bytes are always fetched through the authorised flow
 *
 * There is no object key anywhere in this file, and there could not be: the only way to
 * obtain a URL is `GET /attachments/:id/download`, which authorizes with `expense.view`,
 * scopes the read to the caller's society under their own RLS identity, and answers `404`
 * for a foreign or unknown id. A "public URL built from the key" is therefore not a
 * shortcut that was skipped — it is unreachable, because the client is never told the key.
 *
 * ## The URL is a secret with a short life
 *
 * It is held in component state, passed to one image or one in-app browser, and never
 * logged, never stored and never added to the query cache (the detail screen's helper makes
 * the same choice for the same reason). Re-opening the viewer mints a fresh URL rather than
 * reusing a dying one.
 *
 * ## Images zoom and pan in-app; a PDF is handed to the platform viewer
 *
 * An image renders in `ZoomableImage` — pinch to zoom, drag to pan, both bounded. A PDF is
 * the one thing a React Native view cannot decode without a native renderer, and T076's
 * brief says to avoid unnecessary viewer libraries: so a PDF is opened in the platform's
 * document viewer via `expo-web-browser` (an in-app browser on iOS, a Chrome Custom Tab on
 * Android). That viewer supports zoom and pan natively. The acceptance's "viewer supports
 * … PDF" is therefore met by the platform for PDFs and in-app for images, and the difference
 * is stated in the feature README rather than papered over.
 *
 * ## Both themes
 *
 * Every surface uses the app's semantic tokens. A photo sits on the neutral
 * `bg-inverse-surface` backdrop (PRD §12: bill photos render on a neutral backdrop in both
 * themes), and the metadata card uses `bg-surface`/`text-on-surface`, so the screen is
 * correct without a second light/dark branch.
 */
export default function AttachmentViewerScreen({
  attachmentId,
}: {
  /** The attachment to view, or `null` when the route carried no id. */
  readonly attachmentId: string | null;
}) {
  const userId = useAuthStore(selectAuthUser)?.id ?? null;
  const societyId = useSocietyStore(selectActiveSocietyId);
  const [state, setState] = useState<ViewerState>({ status: 'loading' });

  const load = useCallback(async (): Promise<void> => {
    if (attachmentId === null || userId === null || societyId === null) {
      setState({
        status: 'error',
        message: 'That attachment is not available to you.',
        retryable: false,
      });
      return;
    }

    setState({ status: 'loading' });
    try {
      const download = await requestAttachmentDownloadUrl(userId, societyId, attachmentId);
      setState({ status: 'ready', download });
    } catch (error: unknown) {
      // A `404` is the server's "not yours or not there" (PRD T041) and is not worth a
      // retry; anything else may be transient.
      const notFound = isNotFound(error);
      setState({
        status: 'error',
        message: notFound ? 'That attachment is not available to you.' : expenseErrorMessage(error),
        retryable: !notFound,
      });
    }
  }, [attachmentId, societyId, userId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status === 'loading') {
    return <LoadingIndicator message="Opening the bill…" />;
  }

  if (state.status === 'error') {
    return (
      <ErrorScreen
        title="Attachment not available"
        description={state.message}
        retryLabel={state.retryable ? 'Try again' : 'Close'}
        onRetry={state.retryable ? () => void load() : undefined}
      />
    );
  }

  const { download } = state;
  const isPdf = download.mimeType === 'application/pdf';

  return (
    <View className="flex-1 bg-surface">
      {isPdf ? (
        <View className="flex-1 items-center justify-center gap-4 p-lg">
          <Card variant="outlined">
            <View className="items-center gap-2">
              <Text variant="titleSmall" numberOfLines={2} align="center">
                {download.filename}
              </Text>
              <Text variant="bodySmall" color="onSurfaceVariant">
                {`PDF · ${formatAttachmentBytes(download.sizeBytes)} · ${scanStatusLabel(download.scanStatus)}`}
              </Text>
            </View>
          </Card>
          <Button
            variant="filled"
            onPress={() => {
              void WebBrowser.openBrowserAsync(download.url);
            }}
          >
            Open document
          </Button>
          <Text variant="bodySmall" color="outline" align="center">
            The document opens in the system viewer, which adds its own zoom and pan.
          </Text>
        </View>
      ) : (
        <ZoomableImage uri={download.url} accessibilityLabel={download.filename} />
      )}

      <View className="border-t border-outline-variant bg-surface px-lg py-3">
        <Text variant="bodySmall" color="onSurfaceVariant" numberOfLines={1}>
          {`${download.filename} · ${formatAttachmentBytes(download.sizeBytes)}`}
        </Text>
        {/*
          No scanner exists (ADR-0012 D3), so a `pending` file must not be presented as
          verified — the same caveat the expense detail and the grid carry.
        */}
        <Text variant="bodySmall" color="outline">
          {scanStatusLabel(download.scanStatus)}
        </Text>
      </View>
    </View>
  );
}

/** The API's own "not yours, or not there" — never distinguishable, by design. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'NOT_FOUND'
  );
}
