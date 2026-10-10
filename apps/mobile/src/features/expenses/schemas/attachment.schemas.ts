/**
 * The attachment rules the client enforces before it spends a round trip —
 * Roadmap T076 (audit §5/§9).
 *
 * ## These are T071's numbers, not new ones
 *
 * Every limit is imported from `@ses/domain`, the same module the API and the shared
 * contracts build their schemas from: the 10 MB ceiling, the four accepted MIME
 * types, the 64-hex checksum shape and the 200-character filename. A literal
 * `10 * 1024 * 1024` here would be a second source of truth for a rule that already
 * has one, and its failure mode is silent — the client would refuse a file the
 * server accepts, or accept one it refuses.
 *
 * ## Why the client checks at all, when the server does
 *
 * Not as an authorization or integrity gate — the server owns both — but to turn a
 * wasted upload into an immediate sentence. A 12 MB PDF refused locally costs the
 * user nothing; the same file refused by the API costs a round trip and a presign
 * reservation. The client check is the *earlier* one, never the only one.
 *
 * ## The compression targets are the Roadmap's, and are targets
 *
 * `≤1600 px`, `q0.7`, "target under 400 KB with a second pass at 0.55" come from
 * T076's acceptance line and SAD §10.5's pipeline. `400 KB` is deliberately a
 * **target and not a cap**: the hard limit is the server's 10 MB, and a dense scan
 * that lands at 430 KB after both passes is still a valid bill. Treating the target
 * as a gate would refuse a readable receipt for being too honest about its detail.
 */

import {
  EXPENSE_ATTACHMENT_MAX_BYTES,
  EXPENSE_ATTACHMENT_MIME_TYPES,
  ORIGINAL_FILENAME_MAX_LENGTH,
  isExpenseAttachmentMime,
  sanitiseOriginalFilename,
  validateAttachmentMimeType,
  validateAttachmentSize,
} from '@ses/domain';

/** The server's hard ceiling (SAD §10.4's expense-bill row). */
export const ATTACHMENT_MAX_BYTES = EXPENSE_ATTACHMENT_MAX_BYTES;

/** The four types the API accepts, in the order the contract lists them. */
export const ATTACHMENT_MIME_TYPES = EXPENSE_ATTACHMENT_MIME_TYPES;

/** The filename length the API accepts (it sanitises and truncates the same value). */
export const ATTACHMENT_FILENAME_MAX_LENGTH = ORIGINAL_FILENAME_MAX_LENGTH;

/** SAD §10.5's longest edge, in pixels. */
export const IMAGE_MAX_EDGE_PX = 1600;

/** SAD §10.5's first-pass quality. */
export const IMAGE_PRIMARY_QUALITY = 0.7;

/** SAD §10.5's second-pass quality, applied only when the first pass overshoots. */
export const IMAGE_SECOND_PASS_QUALITY = 0.55;

/** SAD §10.5's soft target for a compressed bill image. */
export const IMAGE_TARGET_BYTES = 400_000;

/** The one document type a bill may be, passed through byte-for-byte. */
export const ATTACHMENT_DOCUMENT_MIME = 'application/pdf';

/** Why a picked file was refused — a stable code, never the sentence alone. */
export type AttachmentValidationReason =
  'unsupported_type' | 'too_large' | 'empty_file' | 'unreadable_file';

/**
 * A locally-refused file.
 *
 * `reason` is what a screen branches on (to choose copy or an icon); `message` is the
 * sentence a user reads. Both are needed: a caller should not parse prose, and a user
 * should not be shown a code.
 */
export class AttachmentValidationError extends Error {
  constructor(
    readonly reason: AttachmentValidationReason,
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentValidationError';
  }
}

export function isAttachmentValidationError(error: unknown): error is AttachmentValidationError {
  return error instanceof AttachmentValidationError;
}

/** True for one of the four accepted types. */
export function isAcceptedMimeType(mimeType: string): boolean {
  return isExpenseAttachmentMime(mimeType);
}

/**
 * The MIME type to declare for a picked file, or `null` when it cannot be one of the
 * four.
 *
 * The suffix is consulted only when the picker reported no type — never as the
 * authority on the content, which is the server's magic-byte check's job. This is the
 * same precedence the API's contract records: the declared type is metadata, the bytes
 * decide.
 */
export function resolvePickerMimeType(
  reported: string | null | undefined,
  fileName: string,
): string | null {
  if (typeof reported === 'string' && reported.length > 0) {
    const normalised = reported.toLowerCase();
    // `image/heif` is the same container as `image/heic`; the product stores the
    // latter's spelling (SAD §10.4), and an iOS picker emits either.
    const candidate = normalised === 'image/heif' ? 'image/heic' : normalised;
    return isExpenseAttachmentMime(candidate) ? candidate : null;
  }

  const extension = extensionOf(fileName);
  switch (extension) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'heic':
    case 'heif':
      return 'image/heic';
    case 'pdf':
      return ATTACHMENT_DOCUMENT_MIME;
    default:
      return null;
  }
}

/** The lowercase extension of a filename, without the dot. */
export function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

/** True when a resolved type is one the client re-encodes to JPEG. */
export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/**
 * Refuse an unsupported or oversized candidate before anything is read or written.
 *
 * Throws `AttachmentValidationError`; the size check is the contract's own
 * `validateAttachmentSize`, so the boundary (exactly 10 MB is allowed) is the
 * server's boundary rather than a re-derived one.
 */
export function assertAcceptableUpload(input: {
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}): void {
  const mime = validateAttachmentMimeType(input.mimeType);
  if (!mime.ok) {
    throw new AttachmentValidationError('unsupported_type', mime.error.message);
  }

  const size = validateAttachmentSize(input.sizeBytes);
  if (!size.ok) {
    throw new AttachmentValidationError(
      input.sizeBytes <= 0 ? 'empty_file' : 'too_large',
      size.error.message,
    );
  }
}

/**
 * The display name to send for an image, after compression.
 *
 * The uploaded bytes are always JPEG (that is the same step that converts HEIC and
 * drops EXIF), so declaring `IMG_4021.HEIC` would be a name that contradicts its own
 * contents. The name is display metadata — never a path, and never an authority on the
 * type — but it should not lie about what was uploaded.
 */
export function jpegDisplayName(originalName: string): string {
  const safe = sanitiseOriginalFilename(originalName);
  const dot = safe.lastIndexOf('.');
  const stem = dot <= 0 ? safe : safe.slice(0, dot);
  return sanitiseOriginalFilename(`${stem === '' ? 'bill' : stem}.jpg`);
}

/** The stored/display name to send for a document, sanitised the same way the API does. */
export function documentDisplayName(originalName: string): string {
  return sanitiseOriginalFilename(originalName);
}

/**
 * The scan-status line for one attachment.
 *
 * `pending` is deliberately **not** rendered as "scanned" or "safe": no scanner exists
 * (ADR-0012 D3), so nothing writes `clean`, and a client that implied verification would
 * be making a security claim the system does not make. Shared rather than duplicated so
 * the expense detail and the attachment grid cannot drift apart on the one line that
 * carries that caveat.
 */
export function scanStatusLabel(scanStatus: string): string {
  switch (scanStatus) {
    case 'clean':
      return 'Scan: clean';
    case 'infected':
      return 'Scan: infected — do not open';
    case 'failed':
      return 'Scan: could not be completed';
    default:
      return 'Not yet security-scanned';
  }
}

/** KB/MB for the size line under a grid item — integer arithmetic, no money involved. */
export function formatAttachmentBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
