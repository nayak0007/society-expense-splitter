import type { ErrorCode, ErrorDetail } from "@ses/contracts";
import type { AttachmentError, AttachmentErrorCode } from "@ses/domain";

import { AppError } from "../../../common/errors/app-error";

/**
 * The attachment module's error vocabulary → the API's catalogue (SAD §7.10).
 *
 * `Record<AttachmentErrorCode, ErrorCode>` rather than a `switch`: adding a domain
 * code fails the build here until someone decides what it means over HTTP. A
 * `switch` with `default: "INTERNAL"` would silently answer 500 for a rule that
 * deserved a 402 — the same bug the expense module's record exists to prevent.
 *
 * Two of the mappings are product decisions rather than translations, and both are
 * worth naming:
 *
 * - **`quota_exceeded` → `PLAN_LIMIT_EXCEEDED` → 402.** The ADR fixes on the code
 *   that already exists (`common/errors/app-error.ts` maps it to 402, and
 *   `packages/contracts/src/common/errors.ts` declares it), because running out of
 *   plan storage is the same class of refusal as any other plan limit and a client
 *   already branches on it to show an upgrade prompt.
 * - **`storage_unavailable` → `DEPENDENCY_UNAVAILABLE` → 503.** A store that is
 *   down is not this API's bug and is worth retrying; answering 500 would make an
 *   outage look like a defect and would defeat a client's retry logic and a
 *   monitor's alerting, which is the whole reason the catalogue has the code.
 *
 * `content_mismatch` is deliberately **not** `CONFLICT`. The stored bytes are not
 * the file the caller declared, and there is nothing about the server's state for
 * them to change and retry — a 422 with a field is the answer that lets a client
 * say "that file is not the type it claims to be" rather than "try again later".
 * The stable detail code (`CONTENT_MISMATCH`) is what a client branches on, never
 * the sentence.
 */
export const ERROR_CODE_BY_ATTACHMENT_CODE: Readonly<
  Record<AttachmentErrorCode, ErrorCode>
> = {
  validation: "VALIDATION_ERROR",
  // "The caller may not know this exists" — rendered 404 rather than 403, because a
  // distinguishable answer lets a caller enumerate another tenant's ids (SAD §7.2,
  // PRD T041). A cross-society attachment and a nonexistent one are one answer.
  not_found: "NOT_FOUND",
  forbidden: "FORBIDDEN",
  // The lifecycle refused it: the parent expense is `void`, or the upload is already
  // complete. The catalogue's own code, and the same one T065/T069 use for a
  // transition the machine does not have.
  invalid_transition: "INVALID_TRANSITION",
  // The state refuses a well-formed request: the upload has not happened, or the
  // object is not the size that was reserved. 409, not 422, for the reason
  // `category_has_expenses` is — the same request succeeds once the state changes.
  conflict: "CONFLICT",
  // T071's security refusal, and the only one the product's posture is built on
  // (PRD §11.4: never trust the extension). 422 with a field, because the caller's
  // next action is to send a different file.
  content_mismatch: "VALIDATION_ERROR",
  quota_exceeded: "PLAN_LIMIT_EXCEEDED",
  storage_unavailable: "DEPENDENCY_UNAVAILABLE",
  // SAD §10.7's two serving-gate refusals, and their two statuses: a file awaiting a
  // scan is retryable once the scan lands, so 409; a quarantined file is terminal for
  // the caller, so 403. Both are shaped-but-unreachable while no scanner is configured
  // (ADR-0012 D3) — the *codes* exist so arming one later needs no new mapping.
  scan_pending: "CONFLICT",
  file_quarantined: "FORBIDDEN",
  // Not the caller's fault, not the store's: a shape this module could not place.
  unknown: "INTERNAL",
};

/**
 * Codes worth preserving verbatim on the wire.
 *
 * `ErrorDetail.code` is a free-form string by design (the validation pipe puts
 * Zod's issue codes there), so a client can branch on `CONTENT_MISMATCH` or
 * `ATTACHMENT_QUOTA_EXCEEDED` without the shared catalogue growing a code only one
 * module emits — the same arrangement `BUILDING_NAME_TAKEN` and
 * `CATEGORY_NAME_TAKEN` have.
 */
const DETAIL_CODES: Readonly<Partial<Record<AttachmentErrorCode, string>>> = {
  content_mismatch: "CONTENT_MISMATCH",
  quota_exceeded: "ATTACHMENT_QUOTA_EXCEEDED",
  conflict: "ATTACHMENT_STATE_CONFLICT",
  scan_pending: "SCAN_PENDING",
  file_quarantined: "FILE_QUARANTINED",
};

/**
 * Translates a domain failure into the exception the filter renders.
 *
 * The domain attaches per-field context as `{ field: 'checksum' }` for validation
 * failures, and that field is carried through so a form highlights the input the
 * user typed instead of parsing a message. Only a non-empty string is used:
 * forwarding an empty one would produce `field: ""`, which a client renders as an
 * error attached to nothing.
 */
export function toAppError(error: AttachmentError): AppError {
  const code = ERROR_CODE_BY_ATTACHMENT_CODE[error.code];
  const field = fieldOf(error);
  const details = detailsFor(error, field);

  return new AppError(code, error.message, {
    ...(field === undefined ? {} : { field }),
    ...(details === undefined ? {} : { details }),
  });
}

function detailsFor(
  error: AttachmentError,
  field: string | undefined,
): readonly ErrorDetail[] | undefined {
  const detailCode = DETAIL_CODES[error.code];
  if (detailCode === undefined) return undefined;

  return [
    {
      field: field ?? "code",
      code: detailCode,
      message: error.message,
    },
  ];
}

function fieldOf(error: AttachmentError): string | undefined {
  const candidate: unknown = error.details?.field;
  return typeof candidate === "string" && candidate !== ""
    ? candidate
    : undefined;
}
