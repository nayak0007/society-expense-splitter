import { View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';

import type { AttachmentUpload } from '../services/attachment-upload.store';
import { formatAttachmentBytes } from '../schemas/attachment.schemas';

/**
 * One attachment's upload state — Roadmap T076 (audit §7/§12).
 *
 * ## It renders the *step*, not a percentage alone
 *
 * The audit's whole reason for modelling explicit states is recovery, and this component
 * is where that becomes visible: a user whose PUT failed can see that the file is still
 * ready to send, while a user whose *confirmation* failed sees a retry that will not
 * re-upload anything. The label therefore names the step (`Reserving…`, `Uploading…`,
 * `Confirming…`) rather than showing one anonymous spinner.
 *
 * ## The actions are the state machine's own edges
 *
 * | state | actions offered |
 * | --- | --- |
 * | `ready` | **Upload** (the explicit user action) and **Remove** |
 * | `reserving` / `uploading` / `confirming` | **Cancel** |
 * | `failed` | **Retry** — which resumes at the failed step — and **Remove** |
 * | `completed` | none: the row is finished and the server is the record |
 *
 * A `completed` item deliberately keeps its notice visible rather than vanishing: the
 * uploaded file has **not** been security-scanned (no scanner exists — ADR-0012 D3), and
 * a screen that silently replaced the row with a server row would teach the user that
 * "uploaded" means "verified".
 */
export interface UploadProgressProps {
  readonly upload: AttachmentUpload;
  onUpload: (() => void) | undefined;
  onRetry: (() => void) | undefined;
  onCancel: (() => void) | undefined;
  onDiscard: (() => void) | undefined;
}

export function UploadProgress({
  upload,
  onUpload,
  onRetry,
  onCancel,
  onDiscard,
}: UploadProgressProps) {
  const percent = Math.round(upload.progress * 100);
  const barPercent = upload.state === 'completed' ? 100 : percent;
  const inFlight =
    upload.state === 'reserving' || upload.state === 'uploading' || upload.state === 'confirming';

  return (
    <View className="gap-2">
      <Text variant="bodySmall" color={upload.state === 'failed' ? 'error' : 'onSurfaceVariant'}>
        {stateLabel(upload, percent)}
      </Text>

      {inFlight || upload.state === 'completed' ? (
        <View
          className="h-1.5 w-full overflow-hidden rounded-full bg-surface-container-highest"
          accessible
          accessibilityRole="progressbar"
          accessibilityValue={{ now: percent, min: 0, max: 100 }}
        >
          <View
            className={`h-full rounded-full ${upload.state === 'completed' ? 'bg-success' : 'bg-primary'}`}
            style={{ width: `${barPercent}%` }}
          />
        </View>
      ) : null}

      {upload.state === 'failed' && upload.error !== null ? (
        <Text variant="bodySmall" color="error">
          {upload.error}
        </Text>
      ) : null}

      <View className="flex-row flex-wrap gap-2">
        {upload.state === 'ready' && onUpload !== undefined ? (
          <Button variant="tonal" size="sm" onPress={onUpload}>
            Upload
          </Button>
        ) : null}
        {upload.state === 'failed' && onRetry !== undefined ? (
          <Button variant="tonal" size="sm" onPress={onRetry}>
            Retry
          </Button>
        ) : null}
        {inFlight && onCancel !== undefined ? (
          <Button variant="text" size="sm" onPress={onCancel}>
            Cancel
          </Button>
        ) : null}
        {upload.state !== 'completed' && onDiscard !== undefined ? (
          <Button variant="text" size="sm" onPress={onDiscard}>
            Remove
          </Button>
        ) : null}
      </View>

      {upload.state === 'ready' ? (
        <Text variant="bodySmall" color="outline">
          {`${formatAttachmentBytes(upload.sizeBytes)} · nothing is sent until you tap Upload`}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The sentence for one state.
 *
 * Kept in one place so the wording cannot drift between the scanner and the detail
 * screen, and so `completed` can carry its own caveat rather than borrowing the API's
 * `processing` verbatim (which is an internal server state, not a user-facing sentence).
 */
function stateLabel(upload: AttachmentUpload, percent: number): string {
  switch (upload.state) {
    case 'selected':
      return 'Selected';
    case 'preparing':
      return 'Preparing…';
    case 'ready':
      return 'Ready to upload';
    case 'reserving':
      return 'Reserving an upload slot…';
    case 'uploading':
      return `Uploading… ${String(percent)}%`;
    case 'confirming':
      return 'Verifying the upload…';
    case 'completed':
      return 'Uploaded — not yet security-scanned';
    case 'failed':
      return 'Upload failed';
    default:
      return 'Upload';
  }
}
