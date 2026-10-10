import { Ionicons } from '@expo/vector-icons';
import { Image, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Text } from '@/components/ui/Text';

import type { ExpenseAttachmentView } from '../repository/expense.repository';
import type { AttachmentUpload } from '../services/attachment-upload.store';
import { formatAttachmentBytes, scanStatusLabel } from '../schemas/attachment.schemas';

import { UploadProgress } from './UploadProgress';

/**
 * The bill grid — Roadmap T076.
 *
 * Two kinds of cell, drawn from two different sources, and keeping them visually distinct
 * is the component's one job:
 *
 *  - **Local uploads** (`uploads`) are files this device is holding. They render from their
 *    own `file://` URI, so a thumbnail is free and always correct, and their
 *    `UploadProgress` row says exactly which step they are on.
 *  - **Stored bills** (`attachments`) are server rows. They are rendered from **metadata
 *    only** — name, size, scan status — and their bytes are fetched only when the user
 *    opens the viewer, which mints one short-lived authorised URL. That is deliberate:
 *    minting a URL per cell on mount would be N credentials for a screenful of icons, and
 *    the existing expense detail already made this decision for the same reason.
 *
 * ## Why React Native's own `Image` is used rather than `expo-image`
 *
 * Every cell here draws a **local** `file://` URI or a static glyph, with no remote fetch,
 * no placeholder and no transition. React Native's `Image` does that exactly, and it is
 * the one image component the component tests can render without a native-module mock.
 * `expo-image` earns its place where remote decoding and `contentFit` matter, which is not
 * this grid.
 *
 * ## The scan status travels with every stored cell
 *
 * `pending` is not `clean` (no scanner exists), so the label says so on the tile rather
 * than only inside the viewer. A user deciding whether to open a bill should know it is
 * unscanned before they open it, not after.
 */
export interface AttachmentGridProps {
  readonly attachments: readonly ExpenseAttachmentView[];
  readonly uploads: readonly AttachmentUpload[];
  /** Open one stored bill in the viewer (which mints the authorised URL). */
  readonly onOpenAttachment: (attachment: ExpenseAttachmentView) => void;
  onUpload: ((key: string) => void) | undefined;
  onRetry: ((key: string) => void) | undefined;
  onCancel: ((key: string) => void) | undefined;
  onDiscard: ((key: string) => void) | undefined;
  /** Shown when there is nothing at all — the empty state copy differs per screen. */
  readonly emptyMessage: string;
}

export function AttachmentGrid({
  attachments,
  uploads,
  onOpenAttachment,
  onUpload,
  onRetry,
  onCancel,
  onDiscard,
  emptyMessage,
}: AttachmentGridProps) {
  if (attachments.length === 0 && uploads.length === 0) {
    return (
      <View className="gap-2">
        <Text variant="bodyMedium" color="onSurfaceVariant">
          {emptyMessage}
        </Text>
      </View>
    );
  }

  return (
    <View className="gap-3">
      {uploads.map((upload) => (
        <Card key={upload.key} variant="outlined">
          <View className="gap-3">
            <View className="flex-row items-center gap-3">
              <UploadThumbnail upload={upload} />
              <View className="flex-1">
                <Text variant="bodyMedium" numberOfLines={1}>
                  {upload.fileName}
                </Text>
                <Text variant="bodySmall" color="onSurfaceVariant">
                  {formatAttachmentBytes(upload.sizeBytes)}
                </Text>
              </View>
            </View>
            <UploadProgress
              upload={upload}
              onUpload={onUpload === undefined ? undefined : () => onUpload(upload.key)}
              onRetry={onRetry === undefined ? undefined : () => onRetry(upload.key)}
              onCancel={onCancel === undefined ? undefined : () => onCancel(upload.key)}
              onDiscard={onDiscard === undefined ? undefined : () => onDiscard(upload.key)}
            />
          </View>
        </Card>
      ))}

      {attachments.map((attachment) => (
        <Card key={attachment.id} variant="outlined">
          <View className="flex-row items-center justify-between gap-3">
            <View className="flex-1 flex-row items-center gap-3">
              <View className="h-12 w-12 items-center justify-center rounded-md bg-surface-container-highest">
                <Ionicons
                  name={
                    attachment.mimeType === 'application/pdf'
                      ? 'document-text-outline'
                      : 'image-outline'
                  }
                  size={22}
                  color="currentColor"
                />
              </View>
              <View className="flex-1">
                <Text variant="bodyMedium" numberOfLines={1}>
                  {attachment.originalFilename}
                </Text>
                <Text variant="bodySmall" color="onSurfaceVariant">
                  {`${formatAttachmentBytes(attachment.sizeBytes)} · ${scanStatusLabel(attachment.scanStatus)}`}
                </Text>
              </View>
            </View>
            <Button variant="text" onPress={() => onOpenAttachment(attachment)}>
              View
            </Button>
          </View>
        </Card>
      ))}
    </View>
  );
}

/** The local thumbnail for an in-flight item — a real preview, or a document icon. */
function UploadThumbnail({ upload }: { readonly upload: AttachmentUpload }) {
  if (upload.isImage) {
    return (
      <Image
        source={{ uri: upload.uri }}
        accessibilityLabel={upload.fileName}
        resizeMode="cover"
        className="h-12 w-12 rounded-md bg-surface-container-highest"
      />
    );
  }
  return (
    <View className="h-12 w-12 items-center justify-center rounded-md bg-surface-container-highest">
      <Ionicons name="document-text-outline" size={22} color="currentColor" />
    </View>
  );
}
