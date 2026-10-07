import { DomainError } from "../shared/errors";
import type { DomainErrorInit } from "../shared/errors";

/**
 * Attachment-module error codes — Roadmap T071, ADR-0012.
 *
 * The shared codes come first, because a module answers the same questions every
 * module does, and each of the rest exists because the *client's next action*
 * differs — which is the same test `ExpenseError`'s own list applies:
 *
 *  - `validation` — a malformed field (a bad checksum, an unsupported type, a
 *    filename that is not one).
 *  - `not_found` — "the caller may not know this exists", rendered `404` rather
 *    than `403` because a distinguishable answer lets a caller enumerate another
 *    tenant's ids (SAD §7.2, PRD T041). A cross-society attachment and a
 *    nonexistent one are the same answer.
 *  - `forbidden` — an active member whose role, or whose relationship to the
 *    record, is not enough. This is where `canOnResource` says no.
 *  - `invalid_transition` — the lifecycle refused it: the parent expense is
 *    `void`, or the upload is already complete. The catalogue's own code
 *    (`INVALID_TRANSITION` → 409).
 *  - `conflict` — the register does not hold what the caller says it does: the
 *    upload has not happened, or the object is not the size that was reserved.
 *    409 because the payload is well formed and the *state* refuses it.
 *  - `content_mismatch` — the stored bytes are not the file the caller declared:
 *    the checksum differs, or the magic number belongs to another type. Its own
 *    code rather than a `validation`, because this is the one refusal the
 *    product's security posture is built on (PRD §11.4: never trust the
 *    extension), a client must not offer "fix your form" for it, and it is the
 *    same fact whether it came from the digest or the signature.
 *  - `quota_exceeded` — the society's plan cap would be passed. Mapped to the
 *    catalogue's existing `PLAN_LIMIT_EXCEEDED` → **402**, which is the code the
 *    ADR fixes on and the one `AppError` already carries (T008).
 *  - `storage_unavailable` — the object store refused or could not be reached.
 *    Its own code because it is the one failure that is *not the caller's fault*
 *    and is worth retrying: a 503, never a 500, so a client's retry logic and a
 *    monitoring alert can both tell it from a bug.
 *  - `unknown` — an adapter failure the classifier could not place.
 *
 * A union per module rather than one global list, exactly as `ExpenseError` and
 * `InvitationError` record: the API's `Record<AttachmentErrorCode, ErrorCode>`
 * mapper then *fails the build* when a code gains no HTTP meaning, which is what
 * keeps a refusal from silently becoming a `500`.
 */
export const ATTACHMENT_ERROR_CODES = [
  "validation",
  "not_found",
  "forbidden",
  "invalid_transition",
  "conflict",
  "content_mismatch",
  "quota_exceeded",
  "storage_unavailable",
  "unknown",
] as const;

export type AttachmentErrorCode = (typeof ATTACHMENT_ERROR_CODES)[number];

/** Extends the shared base so generic middleware recognises it by one `instanceof`. */
export class AttachmentError extends DomainError<AttachmentErrorCode> {
  constructor(
    code: AttachmentErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>> | undefined,
  ) {
    const init: DomainErrorInit<AttachmentErrorCode> = {
      code,
      message,
      details,
    };
    super(init);
    this.name = "AttachmentError";
  }
}

export function isAttachmentError(error: unknown): error is AttachmentError {
  return error instanceof AttachmentError;
}

/** Narrowing helper for `switch` exhaustiveness. */
export function attachmentErrorCode(error: unknown): AttachmentErrorCode {
  return isAttachmentError(error) ? error.code : "unknown";
}

/** Adapter throws → the error type every attachment use case promises. */
export function asAttachmentError(error: unknown): AttachmentError {
  if (isAttachmentError(error)) return error;
  return new AttachmentError(
    "unknown",
    "The attachment operation failed unexpectedly.",
  );
}

/** Shorthand used by the rules. */
export function attachmentError(
  code: AttachmentErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>> | undefined,
): AttachmentError {
  return new AttachmentError(code, message, details);
}
