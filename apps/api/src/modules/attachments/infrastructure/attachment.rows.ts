import {
  asExpenseId,
  asMemberId,
  asSocietyId,
  attachmentError,
  isAttachmentError,
  isAttachmentEntityType,
  isAttachmentScanStatus,
  AttachmentError,
} from "@ses/domain";
import type {
  AttachmentEntityType,
  AttachmentRecord,
  AttachmentScanStatus,
} from "@ses/domain";
import { z } from "zod";

import {
  asErrorLike,
  SQLSTATE,
} from "../../../common/database/postgres-errors";
import {
  nullableTimestampSchema,
  timestampSchema,
} from "../../../common/database/postgres-rows";

/**
 * The database ⇄ domain boundary for `attachments` — Roadmap T071.
 *
 * Every nullability difference, enum crossing and SQLSTATE the API can receive is
 * decided here, once, rather than across five repository methods. Rows are
 * **validated, not trusted**: a renamed column or a new `NOT NULL` must fail loudly
 * here rather than reach a use case as `undefined`.
 *
 * ## `scan_status` and `entity_type` are refined against the domain's own lists
 *
 * Neither is a Postgres enum (the migration uses `varchar` + `CHECK`, for the
 * reason `packages/db-schema/src/postgres/attachments.ts` records), so nothing
 * stops a hand-written row from carrying a value this module has never heard of.
 * The refine makes that a loud parse failure instead of an `unknown` value flowing
 * into a lifecycle gate — and the gate's whole job is to answer "may this be
 * served / attached to", where a novel value must fail closed rather than default.
 *
 * ## `size_bytes` is coerced and `completed_at` is normalised by the shared helpers
 *
 * `size_bytes` is `integer`, so `postgres.js` may surface it as a number or a
 * string depending on the driver's parsing; `z.coerce.number().int()` accepts both
 * and refuses an `NaN` (which a bare `Number()` would let through, and which would
 * silently never equal a reservation's size). The two timestamps go through
 * `common/database/postgres-rows`, so `AttachmentRecord.completedAt` is the same
 * ISO-8601 shape every other module's timestamps are.
 */
export const attachmentRowSchema = z.object({
  id: z.uuid(),
  society_id: z.uuid(),
  entity_type: z.string().refine(isAttachmentEntityType, {
    message: "Unknown attachment entity type returned by the database.",
  }),
  entity_id: z.uuid(),
  storage_key: z.string(),
  original_filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.coerce.number().int(),
  checksum: z.string(),
  uploaded_by: z.uuid(),
  scan_status: z.string().refine(isAttachmentScanStatus, {
    message: "Unknown attachment scan status returned by the database.",
  }),
  completed_at: nullableTimestampSchema,
  created_at: timestampSchema,
});
export type AttachmentRow = z.infer<typeof attachmentRowSchema>;

export const attachmentRowListSchema = z.array(attachmentRowSchema);

/** The columns every read and write returns, in one place. */
export const ATTACHMENT_COLUMN_EXPRESSIONS: readonly string[] = [
  "id",
  "society_id",
  "entity_type",
  "entity_id",
  "storage_key",
  "original_filename",
  "mime_type",
  "size_bytes",
  "checksum",
  "uploaded_by",
  "scan_status",
  "completed_at",
  "created_at",
];

/**
 * A row that did not match its schema — always a bug on one side of the boundary,
 * never something the user did, so the copy stays generic and the actionable part
 * is a hint for the operator.
 */
export function unexpectedShapeError(what: string): AttachmentError {
  return attachmentError("unknown", "Something went wrong. Please try again.", {
    hint: `Unexpected ${what} shape returned by the database.`,
  });
}

/** One row → the flat record the use cases read and return. */
export function attachmentFromRow(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    societyId: asSocietyId(row.society_id),
    entityType: row.entity_type as AttachmentEntityType,
    entityId: asExpenseId(row.entity_id),
    storageKey: row.storage_key,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    checksum: row.checksum,
    uploadedBy: asMemberId(row.uploaded_by),
    scanStatus: row.scan_status as AttachmentScanStatus,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

/**
 * The named exceptions this module's own SQL raises.
 *
 * Two of them are the migration's (`EXPENSE_NOT_FOUND`, `SOCIETY_NOT_FOUND` from
 * `attachment_presign_lock`'s membership assertion) and one is a state the
 * completion path can meet without any exception being raised at all. A table for
 * the reason the expense module keeps one: every `P0001`/`P0002`/`P0003` refusal
 * arrives on a shared SQLSTATE and they mean different things, so the stable
 * discriminator is the exception's name — never the interpolated sentence.
 */
export const ATTACHMENT_RAISED_EXCEPTION = {
  societyNotFound: "SOCIETY_NOT_FOUND",
  expenseNotFound: "EXPENSE_NOT_FOUND",
} as const;

/**
 * Postgres failure → this module's error vocabulary.
 *
 * `context` decides how a `42501` reads, exactly as in the expense classifier: on
 * a **read** it is `not_found` (PRD T041 — a non-member cannot tell a foreign
 * society from an absent row), while on a **write** the caller has already passed
 * `SocietyGuard` and the resource decision, so the only thing RLS can be refusing
 * is their role.
 *
 * The two constraint branches are the ones this table's own verification makes
 * reachable: a violated composite FK means `uploaded_by` names a member from
 * another society (a `validation` naming the field, since the caller's own
 * membership is what the API writes and a mismatch is a wiring bug rather than
 * theirs), and two different objects cannot claim one `storage_key`
 * (`uniqueViolation` — a `conflict`, because it means a key was minted twice, which
 * is the one thing the key builder's determinism is supposed to prevent).
 */
export function attachmentErrorFromPostgres(
  error: unknown,
  context: "read" | "write",
): AttachmentError {
  if (isAttachmentError(error)) return error;

  const candidate = asErrorLike(error);
  const code = candidate.code ?? "";
  const message = candidate.message ?? "";
  const haystack = [message, candidate.detail ?? "", candidate.hint ?? ""]
    .join(" ")
    .toUpperCase();

  if (haystack.includes(ATTACHMENT_RAISED_EXCEPTION.societyNotFound)) {
    return attachmentError(
      "not_found",
      "That society is not available to you.",
    );
  }

  if (haystack.includes(ATTACHMENT_RAISED_EXCEPTION.expenseNotFound)) {
    return attachmentError(
      "not_found",
      "That expense is not available to you.",
    );
  }

  if (code === SQLSTATE.uniqueViolation) {
    return attachmentError(
      "conflict",
      "That attachment address is already in use.",
      { constraint: candidate.constraint ?? candidate.constraint_name },
    );
  }

  if (code === SQLSTATE.foreignKeyViolation) {
    return attachmentError(
      "validation",
      "The uploader does not belong to this society.",
      { field: "uploadedBy" },
    );
  }

  if (code === SQLSTATE.checkViolation) {
    return attachmentError(
      "validation",
      "The attachment does not satisfy the storage rules.",
      { constraint: candidate.constraint ?? candidate.constraint_name },
    );
  }

  if (code === SQLSTATE.insufficientPrivilege) {
    return context === "read"
      ? attachmentError("not_found", "That attachment is not available to you.")
      : attachmentError(
          "forbidden",
          "Your role does not allow that attachment operation.",
        );
  }

  // A 5xx from the store, a socket error, a statement timeout. Not the caller's
  // fault and worth retrying, so the mapper's answer is the catalogue's
  // `DEPENDENCY_UNAVAILABLE` → 503 rather than the 500 an `unknown` would give.
  if (typeof candidate.code === "string" && candidate.code.startsWith("08")) {
    return attachmentError(
      "storage_unavailable",
      "The file store is temporarily unavailable. Try again in a moment.",
    );
  }

  return attachmentError(
    "unknown",
    "The attachment operation failed unexpectedly.",
  );
}
