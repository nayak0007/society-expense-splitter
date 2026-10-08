import { ok } from "../shared/result";
import type { Result } from "../shared/result";
import type { ExpenseId, MemberId, SocietyId, UserId } from "../shared/ids";
import type { SocietyMembership } from "../society/society";
import type { AttachmentEntityType, AttachmentScanStatus } from "./attachment";
import type { AttachmentError } from "./errors";
import { attachmentError } from "./errors";

/**
 * The attachment module's ports — Roadmap T071, ADR-0012, SAD §10.2.
 *
 * Two ports, because there are two genuinely different dependencies: an object
 * store (bytes, no idea what a society is) and a table (rows, no idea what a
 * signature is). Keeping them apart is what lets the whole use-case layer be
 * tested against a fake store with no bucket and no database, and it is also why
 * the provider types below are *project-owned*: an `@aws-sdk/client-s3` type may
 * not appear on this side of the boundary, or the domain would depend on a vendor
 * SDK and Hermes could not compile it.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The object store — SAD §10.2's `IStorageProvider`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a presign request must say.
 *
 * `contentLength` is the load-bearing field and the reason this is not a generic
 * "presign a PUT". The URL's signature pins the **exact** byte count, which
 * appears as `X-Amz-SignedHeaders=content-length;host` — measured working on the
 * hosted provider and on the local store alike (ADR-0012 D1, probes 10 and 16–18,
 * 29–35: a larger body `403 SignatureDoesNotMatch`, a smaller body `403`, an omitted
 * `Content-Length` `403` as well — the length is *signed*, so it cannot simply be
 * dropped — and no object created in any of the cases). A URL minted *without* the pin
 * is a different instrument entirely: the same measurements accepted a 2 MB body and
 * stored a zero-byte object for an unframed one. A range cannot be expressed by a
 * presigned PUT, and the one
 * mechanism that can — a POST policy — was measured failing open on the provider
 * we ship on, so exactness is the mechanism rather than a compromise.
 *
 * `ttlSeconds` is passed in rather than defaulted here: the 15 minutes is a
 * product rule (SAD §10.1, the Roadmap's acceptance) and belongs where product
 * rules live, not inside an adapter.
 */
export interface PresignUploadRequest {
  readonly storageKey: string;
  readonly contentType: string;
  readonly contentLength: number;
  readonly ttlSeconds: number;
}

/**
 * A presigned PUT, as the client receives it.
 *
 * `requiredHeaders` is part of the *contract*, not a convenience: the signature
 * covers `content-length` and `host`, so a client that omits or changes
 * `Content-Length` is refused by the storage layer. Returning them means the
 * refusal happens in a developer's first integration attempt rather than in
 * production, and it keeps the one fact that enforces the size gate visible in the
 * API's own response shape.
 */
export interface PresignedUpload {
  readonly url: string;
  readonly storageKey: string;
  /** ISO-8601 instant. The API's own clock's answer, surfaced for the client. */
  readonly expiresAt: string;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

/** What `HEAD` answers — SAD §10.2's `ObjectMetadata`. */
export interface StorageObjectMetadata {
  readonly contentLength: number;
  readonly contentType: string | null;
  readonly etag: string | null;
}

/**
 * What a read answers: the bytes plus the same metadata `HEAD` would have given.
 *
 * ## Why this exists beside `head`, when SAD §10.2 lists only five capabilities
 *
 * §10.2's sketch is `presignUpload · presignDownload · head · copy · delete`, and
 * completion verification cannot be expressed by any of them: SAD §10.1 requires
 * the checksum to be verified *against the stored object*, so something has to
 * return the object. `head` cannot (an `ETag` is not a SHA-256 — it is an MD5 for
 * a single-part upload and not even that for a multipart one, which is precisely
 * the confusion the ADR forbids). `presignDownload` cannot either: it hands a URL
 * to a client, and verification happens server-side against bytes the *server*
 * needs.
 *
 * So this is one documented addition to the port rather than a reinterpretation of
 * an existing member. It is used for exactly two things — the SHA-256 and the
 * magic-number prefix — and the integration suite asserts that a wrong checksum
 * and a wrong signature are both refused through it.
 */
export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentLength: number;
  readonly contentType: string | null;
  readonly etag: string | null;
}

/**
 * The object store, as the application sees it.
 *
 * One adapter satisfies this for both providers (ADR-0012, "One S3-compatible
 * adapter remains valid"): endpoint, region, credentials, bucket and
 * `forcePathStyle` differ by configuration, and nothing else does. There is
 * deliberately no `provider` field and no per-vendor branch in any signature —
 * a second implementation strategy would be the drift the ADR's D1 measurement
 * was taken to avoid.
 *
 * `presignDownload` ships with no route in T071 (ADR-0012 D4: "No list route ships
 * in T071", and the download route is deferred with it). It is on the port because
 * the capability is part of §10.2 and because the consumers that need it — T073's
 * expense detail, T132's OCR — must not have to change this interface to get it.
 */
export interface StorageProvider {
  presignUpload(request: PresignUploadRequest): Promise<PresignedUpload>;
  presignDownload(storageKey: string, ttlSeconds: number): Promise<string>;
  /** `null` when the object does not exist — never a throw for a 404. */
  head(storageKey: string): Promise<StorageObjectMetadata | null>;
  /** `null` when the object does not exist. */
  readObject(storageKey: string): Promise<StoredObject | null>;
  copy(fromStorageKey: string, toStorageKey: string): Promise<void>;
  delete(storageKey: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The parent expense, as authorisation sees it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The four facts every attachment operation needs about the expense it hangs from.
 *
 * A projection, not an `Expense` aggregate — the same shape and the same reasoning
 * as `ExpenseResourceSnapshot`: no rule here reads an amount, a category or a
 * vendor, and carrying them would invite one to. `createdBy` is nullable because
 * the column is, and because a null must fail an ownership comparison rather than
 * pass it.
 *
 * `status` is the raw stored value rather than the domain's union so that a status
 * the domain does not know is *visible* here and refused by the lifecycle gate
 * (fail closed) instead of being silently coerced.
 */
export interface AttachmentExpenseSnapshot {
  readonly id: ExpenseId;
  readonly societyId: SocietyId;
  readonly status: string;
  readonly createdBy: MemberId | null;
}

/** The statuses an expense may hold and still acquire an attachment (ADR-0012 D6.1). */
export const ATTACHABLE_EXPENSE_STATUSES = [
  "draft",
  "pending_approval",
  "published",
] as const;

/** `void` is the one refusal, and it is a refusal rather than an omission. */
export function isAttachableExpenseStatus(status: string): boolean {
  return (ATTACHABLE_EXPENSE_STATUSES as readonly string[]).includes(status);
}

// ─────────────────────────────────────────────────────────────────────────────
// The rows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One `attachments` row, as it crosses out of the adapter.
 *
 * `completedAt` is an ISO string rather than a `Date` for the same reason every
 * other record in this codebase is: a `Date` from a driver is a `Date` in a test
 * and a string on the wire, and one shape is easier to assert against than two.
 */
export interface AttachmentRecord {
  readonly id: string;
  readonly societyId: SocietyId;
  readonly entityType: AttachmentEntityType;
  readonly entityId: ExpenseId;
  readonly storageKey: string;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly uploadedBy: MemberId;
  readonly scanStatus: AttachmentScanStatus;
  readonly completedAt: string | null;
  readonly createdAt: string;
}

/**
 * A reservation to write, plus the cap it must fit inside.
 *
 * `planCapBytes` arrives as a **number, not a plan name**, and that is the seam
 * between the two halves of the quota rule: the plan → byte map is product
 * configuration and lives in the API's config layer (ADR-0012 D2), while the
 * "read used bytes and insert atomically under a lock" step is SQL and lives in
 * the adapter. Handing the adapter a resolved number means it never has to know
 * what a plan is, and the map has exactly one definition.
 *
 * ## Why `id` is supplied rather than left to the column default
 *
 * The storage key ends in `{attachmentId}.{ext}` (SAD §10.3), so the id in the key
 * and the id in the row have to be the same value. Minting one and letting
 * `gen_random_uuid()` mint another would leave every key naming a row that does not
 * exist — invisible to the application, but exactly the kind of divergence that
 * makes a bucket un-auditable later. The caller generates the id (it needs it for
 * the key before this call exists), and the insert writes it explicitly.
 */
export interface ReserveAttachmentInput {
  readonly id: string;
  readonly societyId: SocietyId;
  readonly entityType: AttachmentEntityType;
  readonly entityId: ExpenseId;
  readonly storageKey: string;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly uploadedBy: MemberId;
  readonly planCapBytes: number;
}

/**
 * The `attachments` table's port.
 *
 * ## Why `reserve` is one method and not three
 *
 * The quota check is a read-then-write: sum what is used, compare against the cap,
 * insert if it fits. Split into `lock()` + `usedBytes()` + `insert()` at the port,
 * three separate calls from a use case would run in three transactions and be
 * exactly the over-reservation bug the lock exists to prevent. One method means the
 * lock, the sum and the insert are one transaction by construction, and the caller
 * cannot get it wrong.
 *
 * It returns a `Result` because *refusing* is a normal answer here: the cap is a
 * product rule and "you have run out of space" is a `402`, not an exception. The
 * adapter is where the atomicity lives; the decision's inputs (the plan's cap)
 * come from the caller.
 *
 * ## Why the reads are separate methods
 *
 * `findExpenseForAttachment` and `readSocietySubscriptionPlan` are projections over
 * tables this module does not own (`expenses`, `societies`), and they are declared
 * here rather than reached for through another module's port because the two
 * modules would then have a cycle: attachments needs the expense read, and the
 * expenses module needs the attachment keys for its draft-deletion cleanup. A
 * projection with a documented owner is the smaller cost — the same call
 * `ExpenseCategoryRepositoryPostgres` makes when it reads `expenses`, recorded in
 * `expenses.module.ts` as "reads `expenses` too, until T065/T066's adapter lands".
 * Neither method writes, and neither returns a column no rule reads.
 */
export interface AttachmentRepository {
  /** The parent expense, or `null` when it is not visible to this caller. */
  findExpenseForAttachment(
    expenseId: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<AttachmentExpenseSnapshot | null>;

  /**
   * The society's stored `subscription_plan`, verbatim.
   *
   * Verbatim, and not mapped to the domain's `SubscriptionPlan`, on purpose: the
   * two vocabularies genuinely disagree (the column's enum is
   * `free | premium | society_pro | enterprise`; the domain type is
   * `free | pro | enterprise`), and T071's brief is explicit that this divergence
   * must not be silently resolved. Returning the raw string means the quota map
   * keys on what the database actually holds, and an unrecognised value fails
   * closed instead of being coerced into a plan that grants 5 GB.
   */
  readSocietySubscriptionPlan(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<string | null>;

  /**
   * Lock the society, sum what it is using, and insert the reservation — or refuse.
   *
   * The whole quota rule's concurrency half lives inside this call (ADR-0012 D2):
   * `attachment_presign_lock()` takes the society row `FOR UPDATE` first, so two
   * concurrent presigns serialize and the second one's sum already includes the
   * first one's row.
   */
  reserve(
    input: ReserveAttachmentInput,
    actor: UserId,
  ): Promise<Result<AttachmentRecord, AttachmentError>>;

  /** One attachment of one society, or `null` when the caller may not see it. */
  findById(
    attachmentId: string,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<AttachmentRecord | null>;

  /**
   * The **completed** attachments of one expense, oldest first — T073's read.
   *
   * `completed_at IS NOT NULL` is the whole filter and it is not negotiable: a row
   * with a null `completedAt` is an outstanding presign reservation — an upload that
   * has not arrived — and listing it would put a bill in the expense detail that does
   * not exist in the bucket. Deleted attachments are simply absent, because the row was
   * removed (ADR-0012 D6.3 removes the row, not the object).
   *
   * Scoped by `entity_id` **and** `society_id`, and run under the caller's RLS
   * identity, so another tenant's expense lists nothing and a foreign id is structurally
   * absent rather than filtered here. Ordered oldest first — the order a bill list is
   * read in — and unpaginated: an expense has a handful of bills (PRD §3.4's cap is
   * five).
   */
  listCompletedForExpense(
    expenseId: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly AttachmentRecord[]>;

  /**
   * Stamp `completed_at` on a still-`pending` row and return what landed.
   *
   * `RETURNING` rather than a read-back, so a concurrent completion cannot be
   * reported as this caller's success — the caller sees the row the statement
   * actually wrote, and a statement that matched nothing (already completed, or
   * the parent expense moved to `void`) is classified from the re-read the same way
   * `ExpenseRepositoryPostgres` classifies a failed optimistic update.
   */
  markComplete(
    attachmentId: string,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<Result<AttachmentRecord, AttachmentError>>;

  /** Remove one row. The object is the caller's next step (ADR-0012 D6.3). */
  deleteById(
    attachmentId: string,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<void>;

  /**
   * The storage keys of a draft's attachments, read **before** the draft is
   * deleted — the object half of D6.5's cleanup.
   *
   * A read and not a delete: the authoritative removal of those rows belongs to
   * `expense_draft_delete()`, inside the same transaction that locks and removes
   * the draft. This method exists only so the caller knows *which objects* to clean
   * afterwards, and it is deliberately the caller's responsibility to tolerate an
   * empty answer.
   */
  listStorageKeysForExpense(
    expenseId: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly string[]>;
}

/**
 * The ADR's quota comparisons, expressed once.
 *
 * `used + requested <= cap` is allowed; `used + requested > cap` is refused. Kept
 * here rather than inline in the adapter so the boundary is a *named* rule with a
 * test on the exact equality — the case a `<` would get wrong, and the case the
 * brief calls out ("used/reserved + requested == cap -> allowed").
 */
/**
 * The caller's own membership in one society — the one tenancy read the attachment
 * use cases need.
 *
 * Declared a third time in this package rather than importing the expense or
 * structure module's identical port, for the reason `ExpenseMembershipReader`
 * records in full: the two existing copies exist because importing one module's
 * port from another makes a change to one feature's review require reading the
 * other's file, which is the cross-feature edge SAD §18.2 forbids. The duplication
 * is structural, not textual — nobody implements this interface by hand. Both it and
 * its two siblings are satisfied by the *societies* module's Postgres repository
 * through the API's single `MEMBERSHIP_READER` token, so a second implementation
 * cannot exist to drift, which is the only thing that would make duplicating a port
 * dangerous.
 *
 * It returns the membership rather than a role because a role alone cannot
express "there is no membership" distinctly from "the membership is pending", and
 * both must be refused differently from an active member's insufficient role.
 */
export interface AttachmentMembershipReader {
  /**
   * The caller's membership in `societyId`, including a `pending` or `removed` one,
   * or `null` when the caller has no row there at all.
   */
  findMembership(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyMembership | null>;
}

export function quotaVerdict(
  usedBytes: number,
  requestedBytes: number,
  capBytes: number,
): Result<number, AttachmentError> {
  const total = usedBytes + requestedBytes;
  if (total > capBytes) {
    return {
      ok: false,
      error: attachmentError(
        "quota_exceeded",
        "Your society's attachment storage is full. Delete an old bill or upgrade the plan to upload another.",
        {
          usedBytes,
          requestedBytes,
          capBytes,
        },
      ),
    };
  }
  return ok(total);
}
