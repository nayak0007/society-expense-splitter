import type { AttachmentError } from "./errors";
import { attachmentError } from "./errors";
import type { Result } from "../shared/result";

/**
 * The attachment value rules — Roadmap T071, ADR-0012.
 *
 * Everything here is a pure function over values the module already has: a
 * storage key can be built and checked without a bucket, a type can be vetted
 * without a database. That is deliberate — the same functions run in the API's
 * use cases and in the unit suite with no infrastructure, and there is exactly one
 * definition of "which extensions this product accepts".
 *
 * ## The extension is never authoritative
 *
 * SAD §10.4 and the Roadmap's own test list ("A `.jpg` with PDF magic bytes
 * rejected") make the stored bytes the only authority. So this file's
 * `MIME_EXTENSIONS` map has one job — naming the object *after* a type the
 * server has already accepted — and `magic-bytes.ts` has the other, judging the
 * bytes. Nothing reads a client-supplied suffix for a decision. The suffix the
 * device sent survives only as `original_filename`, a display string.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The parent kinds an attachment may hang from. `expense` alone in T071, and the
 * database's own `CHECK` says the same thing — a later multi-entity task widens
 * both in one visible change rather than discovering the difference at runtime.
 */
export const ATTACHMENT_ENTITY_TYPES = ["expense"] as const;
export type AttachmentEntityType = (typeof ATTACHMENT_ENTITY_TYPES)[number];

export function isAttachmentEntityType(
  value: unknown,
): value is AttachmentEntityType {
  return (
    typeof value === "string" &&
    (ATTACHMENT_ENTITY_TYPES as readonly string[]).includes(value)
  );
}

/**
 * SAD §10.7's scan lifecycle. Shipped inert (ADR-0012 D3): no scanner exists, so
 * nothing writes `clean` and the serving gate must not be armed — but the
 * vocabulary is here, not invented later, so arming it is configuration plus a
 * scanner job.
 */
export const ATTACHMENT_SCAN_STATUSES = [
  "pending",
  "clean",
  "infected",
  "failed",
] as const;
export type AttachmentScanStatus = (typeof ATTACHMENT_SCAN_STATUSES)[number];

export function isAttachmentScanStatus(
  value: unknown,
): value is AttachmentScanStatus {
  return (
    typeof value === "string" &&
    (ATTACHMENT_SCAN_STATUSES as readonly string[]).includes(value)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-type caps (SAD §10.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The expense-bill row of SAD §10.4: **10 MB**, `jpg`/`png`/`heic`/`pdf`. It is
 * the only live row in T071 because `expense` is the only live `entity_type`; the
 * other rows (complaint 8 MB, payment proof 5 MB, profile 3 MB, visitor 2 MB,
 * meter 3 MB) arrive with their own entity types, and inventing their caps here
 * for tables nobody can write would be a second source of truth for a rule that
 * has one.
 *
 * Three places enforce this number and all three are required (ADR-0012 D1): the
 * API refuses at presign time, the exact signed `Content-Length` refuses at the
 * storage layer, and this same map is re-checked at completion against the
 * object's real size. A change to SAD §10.4 is a change here.
 */
export const EXPENSE_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** The global database ceiling (SAD §8.5's `CHECK (size_bytes <= 10485760)`). */
export const ATTACHMENT_ABSOLUTE_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The accepted MIME types for an expense bill, as **declared** metadata. The
 * declaration is what the client's `Content-Type` must be and what the magic
 * bytes are checked *against*; it is never what decides whether a file is
 * accepted.
 *
 * SVG and every executable or archive format are absent on purpose: an image type
 * that can carry script, and a container that can carry anything, are both
 * outside what a bill can be. Absence from this list is the refusal — there is no
 * deny-list to keep in step.
 */
export const EXPENSE_ATTACHMENT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/heic",
  "application/pdf",
] as const;
export type ExpenseAttachmentMime =
  (typeof EXPENSE_ATTACHMENT_MIME_TYPES)[number];

export function isExpenseAttachmentMime(
  value: unknown,
): value is ExpenseAttachmentMime {
  return (
    typeof value === "string" &&
    (EXPENSE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(value)
  );
}

/**
 * The object's suffix, derived from a type the server has already accepted.
 *
 * This is the *only* place a filename suffix is chosen, and it is chosen from a
 * closed map rather than from anything the caller sent — so a declared
 * `bill.pdf` and a declared `application/pdf` produce the same key, and a
 * declared `..%2f..%2fetc%2fpasswd.jpg` produces `.jpg` or nothing at all.
 *
 * `heic` rather than `heif` follows SAD §10.4's own spelling; the two are the same
 * container and the choice is cosmetic, but a map with both would let one file be
 * stored under two names.
 */
export const MIME_EXTENSIONS: Readonly<Record<ExpenseAttachmentMime, string>> =
  {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/heic": "heic",
    "application/pdf": "pdf",
  };

/** The suffix for an accepted MIME type, or `null` — never a caller's string. */
export function extensionForMimeType(mimeType: string): string | null {
  return isExpenseAttachmentMime(mimeType) ? MIME_EXTENSIONS[mimeType] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Size and checksum
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A size the module will reserve against, or a `validation` refusal naming the
 * field. `sizeBytes` is the client's declaration at presign time; it is what the
 * signature pins, so a wrong declaration is not a smaller bill — it is a refusal
 * by the storage layer at upload time.
 */
export function validateAttachmentSize(
  sizeBytes: unknown,
): Result<number, AttachmentError> {
  if (
    typeof sizeBytes !== "number" ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0
  ) {
    return {
      ok: false,
      error: attachmentError(
        "validation",
        "sizeBytes must be a positive whole number of bytes.",
        { field: "sizeBytes" },
      ),
    };
  }

  if (sizeBytes > EXPENSE_ATTACHMENT_MAX_BYTES) {
    return {
      ok: false,
      error: attachmentError(
        "validation",
        `A bill may be at most ${EXPENSE_ATTACHMENT_MAX_BYTES} bytes.`,
        { field: "sizeBytes", maxBytes: EXPENSE_ATTACHMENT_MAX_BYTES },
      ),
    };
  }

  return { ok: true, value: sizeBytes };
}

/** The declared MIME type, or a `validation` refusal naming the field. */
export function validateAttachmentMimeType(
  mimeType: unknown,
): Result<ExpenseAttachmentMime, AttachmentError> {
  if (typeof mimeType !== "string" || !isExpenseAttachmentMime(mimeType)) {
    return {
      ok: false,
      error: attachmentError(
        "validation",
        "Unsupported file type. A bill may be a JPEG, PNG, HEIC or PDF.",
        {
          field: "mimeType",
          allowed: [...EXPENSE_ATTACHMENT_MIME_TYPES],
        },
      ),
    };
  }
  return { ok: true, value: mimeType };
}

/** SHA-256 in lowercase hex, exactly 64 characters (the database's own `CHECK`). */
export const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A checksum, normalised — or a `validation` refusal.
 *
 * Case is **lowered rather than refused**: an uppercase digest is the same digest,
 * and rejecting it would refuse a caller who is right about the content. What is
 * refused is a digest that is not 64 hex characters at all, because that is a
 * client that has not hashed the file — and reserving an upload against it would
 * move the failure to completion, after the bytes had landed.
 */
export function validateChecksum(
  checksum: unknown,
): Result<string, AttachmentError> {
  if (typeof checksum !== "string" || checksum.trim() === "") {
    return {
      ok: false,
      error: attachmentError(
        "validation",
        "A SHA-256 checksum of the file is required.",
        { field: "checksum" },
      ),
    };
  }

  const normalised = checksum.trim().toLowerCase();
  if (!CHECKSUM_PATTERN.test(normalised)) {
    return {
      ok: false,
      error: attachmentError(
        "validation",
        "The checksum must be the file's SHA-256 as 64 hexadecimal characters.",
        { field: "checksum" },
      ),
    };
  }

  return { ok: true, value: normalised };
}

/**
 * The uploaded filename, as display metadata.
 *
 * Path separators and traversal segments are stripped rather than refused: the
 * value is shown in a UI and never used to address anything, so a browser that
 * reports `C:\Users\me\bill.jpg` should store `bill.jpg` rather than fail a
 * request that means the obvious thing. Length is capped at the column's own 200
 * characters, and a name that reduces to nothing falls back to a placeholder so
 * the column's `NOT NULL` has something to hold.
 */
export const ORIGINAL_FILENAME_MAX_LENGTH = 200;

export function sanitiseOriginalFilename(fileName: unknown): string {
  const fallback = "attachment";
  if (typeof fileName !== "string") return fallback;

  // The last path segment, so a browser reporting `C:\Users\me\bill.jpg` or a
  // traversal attempt in the name is reduced to the name.
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // Control characters have no place in a display string and are the one thing
    // that could still confuse a consumer that renders this raw.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    // Leading dots only — a `..` anywhere would already have been cut by the
    // separator split above, so this handles `.bashrc`-shaped names, not traversal.
    .replace(/^\.+/, "")
    .trim()
    .slice(0, ORIGINAL_FILENAME_MAX_LENGTH);
  return cleaned === "" ? fallback : cleaned;
}

// ─────────────────────────────────────────────────────────────────────────────
// The key layout (SAD §10.3)
// ─────────────────────────────────────────────────────────────────────────────

/** The path segment a given `entity_type` occupies — SAD §10.3's `{entityType}`. */
const ENTITY_TYPE_SEGMENTS: Readonly<Record<AttachmentEntityType, string>> = {
  expense: "expenses",
};

/**
 * `societies/{societyId}/expenses/{expenseId}/{attachmentId}.{ext}` — SAD §10.3,
 * built **only** here.
 *
 * The server mints both ids and derives the suffix, so a caller cannot supply any
 * part of a key. That matters more than tidiness: the insert policy constrains the
 * key to the row's own society and entity, so a key built anywhere else would
 * either be refused or drift from the policy that is supposed to protect it. One
 * builder means the two cannot disagree.
 *
 * The `attachmentId` is deliberately in the path (not a random suffix): it makes
 * the object addressable from the row without a lookup, which is what the
 * abandoned-object sweep needs.
 */
export function buildAttachmentStorageKey(input: {
  readonly societyId: string;
  readonly entityType: AttachmentEntityType;
  readonly entityId: string;
  readonly attachmentId: string;
  readonly mimeType: string;
}): Result<string, AttachmentError> {
  const extension = extensionForMimeType(input.mimeType);
  if (extension === null) {
    return {
      ok: false,
      error: attachmentError(
        "validation",
        "Unsupported file type. A bill may be a JPEG, PNG, HEIC or PDF.",
        { field: "mimeType" },
      ),
    };
  }

  const segment = ENTITY_TYPE_SEGMENTS[input.entityType];
  return {
    ok: true,
    value: `societies/${input.societyId}/${segment}/${input.entityId}/${input.attachmentId}.${extension}`,
  };
}

/**
 * The key's shape, re-checked on anything the module reads back from storage or
 * the database.
 *
 * Nothing here trusts the builder having been called: a key that arrives from a
 * row, a request, or a provider response is a string from outside, and the three
 * properties that make a key safe — the server-owned prefix, no traversal
 * segment, and no absolute path — are cheap to assert. The database's `CHECK` and
 * the insert policy assert the same three; this version is the one the use cases
 * can produce a *typed refusal* from, which is the difference between a 422 with a
 * field and a SQLSTATE.
 */
export function isSafeStorageKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= 512 &&
    key.startsWith("societies/") &&
    !key.startsWith("/") &&
    !key.includes("..") &&
    !key.includes("//") &&
    !key.includes("\\")
  );
}

export function assertSafeStorageKey(
  key: unknown,
): Result<string, AttachmentError> {
  if (!isSafeStorageKey(key)) {
    return {
      ok: false,
      error: attachmentError("validation", "The storage key is not valid.", {
        field: "storageKey",
      }),
    };
  }
  return { ok: true, value: key };
}
