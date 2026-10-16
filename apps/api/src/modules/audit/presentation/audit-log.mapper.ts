import { auditLogEntrySchema, auditLogPageSchema } from "@ses/contracts";
import type { AuditLogEntryDto, AuditLogPageDto } from "@ses/contracts";
import type { AuditJson, AuditLogPage, AuditLogRecord } from "@ses/domain";

import { encodeAuditCursor } from "../application/audit-cursor";

/**
 * The persisted row → the wire DTO — T050 Stage E1.
 *
 * ## This file is where disclosure is decided
 *
 * The row carries more than a client needs, and the difference is not a mapping
 * detail: it is the one place in the read path where "what may leave the server" is
 * answered. Everything here is an **allowlist** of stored values plus two deliberate
 * removals, rather than "the row, as JSON":
 *
 *  - `ip` and `userAgent` are dropped from `metadata`, for everybody including an
 *    Admin. They exist so that an investigator reading the database can answer "from
 *    where", and shipping every society's Admin the addresses and browsers of their
 *    members would widen the disclosure surface for no product benefit (ADR-0014 D13).
 *    Dropping them *here* rather than in SQL keeps one list of internal keys, next to
 *    the contract that documents the exclusion.
 *  - `requestId` is **lifted out** of `metadata` into its own field and removed from
 *    the object, so a client reads it in one place rather than two. SAD §7.10 makes it
 *    the identifier support asks a user for, and it is already public by construction —
 *    it is echoed on every response and in the `X-Request-Id` header.
 *
 * What is deliberately *not* done here: resolving `actorUserId` into a display name.
 * That would join `members`/`auth.users` on every row of every page and would make this
 * endpoint a PII surface; a client that wants a name already has the member list.
 *
 * The response is validated through the contract's own schema before it is returned,
 * so a field the contract does not describe cannot leak by accident — the pattern every
 * mapper in this codebase follows.
 */

/** `metadata` keys that are stored for investigators and never returned. */
const INTERNAL_METADATA_KEYS: readonly string[] = ["ip", "userAgent"];

/** `metadata` keys that are lifted to a field of their own. */
const LIFTED_METADATA_KEYS: readonly string[] = ["requestId"];

/** One page → the wire page: rows projected, the cursor re-encoded. */
export function auditLogPageToDto(page: AuditLogPage): AuditLogPageDto {
  return auditLogPageSchema.parse({
    entries: page.records.map(auditLogRecordToDto),
    // The cursor is the tuple, re-encoded. A client never sees its contents — and
    // the string it echoes back is the only thing that identifies a position.
    nextCursor:
      page.nextCursor === null ? null : encodeAuditCursor(page.nextCursor),
    hasMore: page.hasMore,
  });
}

/** One persisted record → one DTO. */
export function auditLogRecordToDto(record: AuditLogRecord): AuditLogEntryDto {
  // Read from the stored row, then projected: the public copy has already dropped this
  // key (it is in `LIFTED_METADATA_KEYS`), so taking it from the copy would always be
  // `undefined` — the bug this line's predecessor shipped in draft.
  const requestId = record.metadata["requestId"];
  const metadata = publicMetadata(record.metadata);

  return auditLogEntrySchema.parse({
    id: record.id,
    occurredAt: record.occurredAt,
    category: record.category,
    action: record.action,
    entityType: record.entityType,
    entityId: record.entityId,
    actorUserId: record.actorUserId,
    actorRole: record.actorRole,
    // Already redacted at the write boundary and again on flush; a third pass here
    // would be a third reading of the same rule, and the fields are not re-shaped.
    before: record.before,
    after: record.after,
    requestId: typeof requestId === "string" ? requestId : null,
    metadata,
  });
}

/**
 * The metadata a client may read: the stored object minus the internal request facts
 * and minus the key lifted to a field of its own.
 *
 * A copy rather than the row's object: `metadata` is persisted JSON that the caller
 * must not be able to mutate, and the two `delete`s below are exactly that mutation.
 */
function publicMetadata(
  metadata: Readonly<Record<string, AuditJson>>,
): Record<string, AuditJson> {
  const copy: Record<string, AuditJson> = { ...metadata };
  for (const key of [...INTERNAL_METADATA_KEYS, ...LIFTED_METADATA_KEYS]) {
    delete copy[key];
  }
  return copy;
}
