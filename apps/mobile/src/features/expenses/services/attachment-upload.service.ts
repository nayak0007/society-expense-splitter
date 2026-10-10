/**
 * The upload runner — Roadmap T076 (audit §6/§7).
 *
 * One function drives one upload through T071's exact sequence and writes every
 * transition into the store, so a screen re-renders from a single source of truth:
 *
 * ```text
 *   reserving  POST /expenses/:id/attachments   -> { attachmentId, uploadUrl, requiredHeaders }
 *   uploading  PUT <presigned url>              -> raw bytes, progress, no API hop
 *   confirming POST /attachments/:id/complete    -> { status: 'processing' }
 *   completed
 * ```
 *
 * ## A successful PUT is not a completed attachment
 *
 * The PUT writes bytes into a bucket; nothing on the server knows about them until the
 * completion call verifies the length, the SHA-256 and the magic bytes. So `uploading`
 * is never treated as done, and the store only reaches `completed` after the API has
 * answered. The Roadmap's acceptance ("upload progress accurate", "upload failure shows
 * a retry affordance") is satisfiable only because the two steps are visible separately.
 *
 * ## Recovery is step-specific, and never re-reserves after a confirmation failure
 *
 * The three steps fail differently, so the retry differs:
 *
 * | failed at    | retry does                                                    |
 * | ------------ | ------------------------------------------------------------- |
 * | `reserve`    | mints a fresh reservation (the previous one never existed)     |
 * | `upload`     | reuses the outstanding URL when it is still live, re-mints when it has expired |
 * | `confirm`    | calls **only** completion again — never the PUT, never a reservation |
 *
 * The last row is the one that matters most: completion replay is a server-side no-op
 * (a `200` that writes nothing), so retrying it cannot duplicate a bill, whereas
 * reserving again would create a second row and a second object. There is therefore no
 * code path from an ambiguous confirmation back to `/attachments` presign.
 *
 * ## Nothing sensitive is logged or persisted
 *
 * The presigned URL and the signature headers travel inside the store's in-memory
 * `reservation` and are handed straight to the transport. They are never written to the
 * store's durable siblings (MMKV), never logged, never rendered and never included in an
 * error message — an object-store error can name the bucket and the key, which names a
 * society.
 */

import { isApiError, isNetworkError } from '@/lib/api/api-client';
import { uploadFileRaw } from '@/lib/storage/files';

import { confirmAttachmentUpload, reserveAttachmentUpload } from './expense.service';
import {
  abortUpload,
  failUpload,
  patchUpload,
  readUpload,
  registerUploadAbort,
  releaseUploadAbort,
  removeUpload,
} from './attachment-upload.store';
import type { AttachmentReservation, AttachmentUploadStep } from './attachment-upload.store';
import { isAttachmentValidationError } from '../schemas/attachment.schemas';

/** The scope key every upload is isolated by — tenant plus session. */
export function attachmentScopeKey(
  societyId: string | null,
  actorId: string | null,
): string | null {
  if (societyId === null || actorId === null) return null;
  return `${societyId}:${actorId}`;
}

/** A non-2xx answer from the object store itself — not from this API. */
export class StorageUploadRefusedError extends Error {
  constructor(readonly status: number) {
    super(storageRefusalMessage(status));
    this.name = 'StorageUploadRefusedError';
  }
}

export interface RunAttachmentUploadContext {
  readonly actorId: string;
  readonly societyId: string;
  /** Called once, after the API has confirmed the upload. Invalidates the query cache. */
  readonly onCompleted?: (attachmentId: string) => void;
}

/**
 * Run (or resume) one upload.
 *
 * Reads the item's current `step` from the store rather than trusting a caller's idea of
 * where it is: a retry is just this function called again, and the item is what remembers
 * how far it got. Returns when the item has reached a terminal state; it never throws for
 * an upload failure — the item carries that — so a caller (an event handler) cannot
 * accidentally surface a rejection React does not expect.
 */
export async function runAttachmentUpload(
  key: string,
  context: RunAttachmentUploadContext,
): Promise<void> {
  const item = readUpload(key);
  if (item === null) return;
  if (item.expenseId === null) {
    // A staged file has no parent to attach to yet; the form binds it after saving.
    return;
  }
  if (item.checksum === null) {
    failUpload(key, 'prepare', 'That file was not prepared correctly. Choose it again.');
    return;
  }

  const expenseId = item.expenseId;
  const controller = new AbortController();
  registerUploadAbort(key, controller);

  try {
    // ── Resume at `confirm`: the PUT already landed and only the stamp is missing. ──
    if (item.step === 'confirm' && item.attachmentId !== null) {
      patchUpload(key, { state: 'confirming', step: 'confirm', error: null, progress: 1 });
      await confirmAttachmentUpload(
        context.actorId,
        context.societyId,
        item.attachmentId,
        item.checksum,
      );
      patchUpload(key, { state: 'completed', progress: 1, error: null });
      context.onCompleted?.(item.attachmentId);
      return;
    }

    // ── Reserve, unless a live reservation of ours is already outstanding. ──
    let reservation: AttachmentReservation | null =
      item.step === 'upload' &&
      item.reservation !== null &&
      item.attachmentId !== null &&
      !isPresignedUrlExpired(item.reservation.expiresAt)
        ? item.reservation
        : null;

    let attachmentId: string | null = reservation === null ? null : item.attachmentId;

    if (reservation === null) {
      patchUpload(key, {
        state: 'reserving',
        step: 'reserve',
        error: null,
        progress: 0,
        reservation: null,
        attachmentId: null,
      });

      const target = await reserveAttachmentUpload(context.actorId, context.societyId, expenseId, {
        fileName: item.fileName,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        checksum: item.checksum,
      });

      reservation = {
        uploadUrl: target.uploadUrl,
        expiresAt: target.expiresAt,
        requiredHeaders: target.requiredHeaders,
      };
      attachmentId = target.attachmentId;

      patchUpload(key, {
        state: 'uploading',
        step: 'upload',
        attachmentId,
        reservation,
        progress: 0,
      });
    } else {
      patchUpload(key, { state: 'uploading', step: 'upload', error: null, progress: 0 });
    }

    // Both halves are set by now, in either branch. Asserted rather than cast: an item that
    // reached here without a reservation or an id is a bug this function must not paper over
    // by sending bytes to an unknown URL.
    if (reservation === null || attachmentId === null) {
      failUpload(key, 'reserve', 'The upload could not be started. Try again.');
      return;
    }
    const activeReservation = reservation;
    const activeAttachmentId = attachmentId;

    // A cancel (or a tenant switch) that landed while the reservation was in flight: the row
    // exists, but the user asked for it to stop, so no bytes are sent. The reservation simply
    // ages out of the plan quota.
    if (controller.signal.aborted) {
      removeUpload(key);
      return;
    }

    // ── The bytes, straight to storage. The signature pins the exact length. ──
    const result = await uploadFileRaw(item.uri, {
      url: activeReservation.uploadUrl,
      headers: activeReservation.requiredHeaders,
      mimeType: item.mimeType,
      signal: controller.signal,
      onProgress: ({ bytesSent, totalBytes }) => {
        patchUpload(key, {
          progress: totalBytes > 0 ? Math.min(1, bytesSent / totalBytes) : 0,
        });
      },
    });

    if (result.status < 200 || result.status >= 300) {
      throw new StorageUploadRefusedError(result.status);
    }

    // ── Confirm. Until this answers, the bytes are in a bucket and nothing else. ──
    patchUpload(key, { state: 'confirming', step: 'confirm', progress: 1 });
    await confirmAttachmentUpload(
      context.actorId,
      context.societyId,
      activeAttachmentId,
      item.checksum,
    );

    patchUpload(key, { state: 'completed', progress: 1, error: null });
    context.onCompleted?.(activeAttachmentId);
  } catch (error: unknown) {
    if (isAbortError(error)) {
      // A cancel or a society switch: the item is not a failure, it is gone.
      removeUpload(key);
      return;
    }
    const current = readUpload(key);
    failUpload(key, failedStepOf(current?.state, item.step), uploadFailureMessage(error));
  } finally {
    releaseUploadAbort(key);
  }
}

/** Cancel an in-flight upload for one item. */
export function cancelAttachmentUpload(key: string): void {
  abortUpload(key);
}

/**
 * True when a presigned URL is at or past its expiry.
 *
 * A 30-second guard band is subtracted so a PUT is never started against a URL that will
 * die mid-flight — the failure mode that looks like a network problem and is really an
 * expired credential.
 */
export function isPresignedUrlExpired(expiresAt: string, now: number = Date.now()): boolean {
  const deadline = Date.parse(expiresAt);
  if (Number.isNaN(deadline)) return true;
  return deadline - 30_000 <= now;
}

/**
 * The copy a user reads for a refused PUT.
 *
 * `403` is the signature saying no — the URL expired, or the body did not match the
 * pinned length — and is actionable ("try again", which re-reserves). A `5xx` is the
 * store being unwell and is worth retrying. Everything else is refused as-is, with a
 * sentence that names no bucket, key or credential.
 */
function storageRefusalMessage(status: number): string {
  if (status === 403 || status === 400) {
    return 'The upload link was refused or has expired. Try again to send the file.';
  }
  if (status === 411) {
    return 'The file store refused the upload because its size was missing. Try again.';
  }
  if (status >= 500 || status === 408 || status === 429) {
    return 'The file store is temporarily unavailable. Try again in a moment.';
  }
  return 'The file store refused this upload. Try again, or choose a different file.';
}

/** Which step's retry is the right one, from the state the item was in when it threw. */
function failedStepOf(
  state: string | undefined,
  fallback: AttachmentUploadStep,
): AttachmentUploadStep {
  if (state === 'reserving') return 'reserve';
  if (state === 'confirming') return 'confirm';
  if (state === 'uploading') return 'upload';
  return fallback;
}

/**
 * A failure → the sentence a screen renders.
 *
 * Order matters: a refusal from the object store and a local validation failure are the most
 * specific things available, and the API's own catalogue message (a 402 names the plan, a 409
 * names the lifecycle) is equally so. Everything else — a native module throwing, a socket
 * error with no classification — gets a **generic** line rather than its own `message`,
 * because an unclassified `Error.message` from a filesystem or uploader native module can
 * name an absolute path or a bucket key, and neither belongs on a user's screen. That is a
 * deliberate departure from `expenseErrorMessage`, which renders the API's sentence verbatim
 * precisely because the API's sentences are written for users.
 */
export function uploadFailureMessage(error: unknown): string {
  if (error instanceof StorageUploadRefusedError) return error.message;
  if (isAttachmentValidationError(error)) return error.message;
  if (isApiError(error)) return error.message;
  if (isNetworkError(error))
    return 'Could not reach the server. Check your connection and try again.';
  return 'The upload could not be completed. Please try again.';
}

/** An abort is not a failure — it is a cancel or a tenant switch. */
function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}
