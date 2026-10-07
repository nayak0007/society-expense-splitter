import { ApiErrorResponses } from "../../../common/swagger/zod-openapi";

/**
 * The error responses every attachment route can return — Roadmap T071.
 *
 * The 404 copy is the module's usual indistinguishable-cases sentence, and here it
 * covers four cases that must stay identical: a society the caller has no active
 * membership in, an expense that is not in the named society, an attachment that is
 * not in it, and any of them not existing at all. They are one answer on purpose
 * (PRD T041) — a distinguishable one lets a caller enumerate another tenant's ids —
 * and the guard answers the society case before the handler runs.
 *
 * The 403 names the reused cells explicitly rather than describing a new
 * attachment capability, because there is none: presign and complete reuse
 * `expense.create` (Admin/Treasurer full, Committee Member **draft only**) and
 * delete reuses `expense.void` plus the uploader branch. A client that rendered one
 * disabled state for all of them would hide which rule refused it — and a reader of
 * this document should be able to see that the attachment module introduces no
 * permission of its own (ADR-0012 D5).
 *
 * The 409 copy names the three state refusals, each with the code a client branches
 * on and never the sentence: `INVALID_TRANSITION` (the parent expense is `void`, or
 * the upload is already complete and being completed again in a way that is not the
 * replay path), `ATTACHMENT_STATE_CONFLICT` (the upload has not happened, or the
 * stored object is not the size that was reserved) and `VERSION_MISMATCH` — which
 * this module does **not** produce, because attachments are not versioned content
 * and carry no `expectedVersion` (ADR-0012). Saying so is worth the line: a client
 * should not build a reload-and-retry path for a lock that does not exist.
 */
export function ApiAttachmentErrors(): ClassDecorator & MethodDecorator {
  return ApiErrorResponses({
    notFound:
      "No such society, no such expense, no such attachment — or one the caller is not an active member of. This API deliberately does not distinguish these (PRD T041).",
    forbidden:
      "An active member whose role does not hold the reused expense cell, or whom the resource narrowing refuses. Presign and complete reuse `expense.create` (Admin/Treasurer, or a Committee Member on a draft they own); delete reuses `expense.void` and additionally admits the uploader of the row. The attachment module introduces no permission of its own.",
    conflict:
      "The parent expense is `void`, so it cannot take new bills (`code: INVALID_TRANSITION`); or no uploaded file was found, or the stored object is not the size this upload reserved (`code: ATTACHMENT_STATE_CONFLICT`). There is no version conflict: attachments are not versioned content and carry no `expectedVersion`.",
  });
}

/**
 * Two statuses the attachment routes produce that the shared three do not cover, and
 * one they deliberately do not produce.
 *
 * - **`402 PLAN_LIMIT_EXCEEDED`** — the society's plan cap would be passed. Presign
 *   only: the *reservation* is what counts against the quota, so completion can
 *   never produce this (ADR-0012 D2). The refusal's `details` carry the used,
 *   requested and cap bytes, so a client can show a real progress bar rather than a
 *   generic sentence.
 * - **`422 VALIDATION_ERROR` with `code: CONTENT_MISMATCH`** — the stored bytes are
 *   not the file or the type that was declared: the SHA-256 computed over them
 *   differs, or the magic number belongs to another format. Complete only, and
 *   deliberately a 422 rather than a 409 — the caller's next action is to send a
 *   different file, not to retry the same request.
 * - **`413` is absent on purpose**, and that is worth a line because it is the one
 *   status a client might reasonably expect. The storage layer *does* answer
 *   `413 EntityTooLarge` when the provider enforces a bucket cap (ADR-0012 D1 probe
 *   9 on the hosted provider), but that response comes from the object store on a
 *   direct PUT to the presigned URL — it is never produced by this API, which refuses
 *   an oversized reservation with `422` before any URL is minted. Advertising `413`
 *   in this document would describe a status this service does not emit.
 */
export const ATTACHMENT_EXTRA_STATUS_COPY = {
  planLimit:
    "The society's plan storage would be exceeded. The refusal's `details` carry `usedBytes`, `requestedBytes` and `capBytes`.",
  contentMismatch:
    "The uploaded file's contents are not the declared type, or not the declared file (`code: CONTENT_MISMATCH`). Nothing was written; upload the file again, unchanged.",
} as const;
