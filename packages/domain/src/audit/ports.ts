import type { MemberRole } from "../society/society";
import type { SocietyId, UserId } from "../shared/ids";
import type { AuditCategory, AuditDescriptor, AuditJson } from "./audit";

/**
 * The audit trail's read port — Roadmap T050 Stage E1, ADR-0014 D13.
 *
 * ## Why the read is a port and not a repository call behind a use case
 *
 * The write side has no port: a mutation records through `AuditService.entry` plus
 * `UnitOfWork`'s seam, and the entity that owns the change owns the write. A read has
 * no such owner — the log belongs to the society, not to any module that writes into
 * it — so it needs the interface every other read in this codebase has, and the
 * adapter that satisfies it is the only place that knows the table.
 *
 * ## Every field is already-redacted stored state
 *
 * `before`/`after`/`metadata` are the persisted, redacted values
 * (`redactAuditPayload` runs at the write boundary and again on flush), so nothing
 * here needs a second redaction pass — and nothing here may *add* a field that is not
 * on the row. The one projection the API applies is on the way out
 * (`metadata` minus the internal request facts), which is a disclosure decision and
 * therefore lives at the edge, not here.
 */

/**
 * The keyset position of a page — `(occurred_at, id)` in that order.
 *
 * Both halves are **strings** on purpose. `occurred_at` is a `timestamptz` and the
 * adapter binds it as one; `id` is a `bigint` identity column and a JS `number` cannot
 * hold it, so it travels as its decimal spelling the same way every paise amount in
 * this codebase does.
 *
 * The pair — not `occurred_at` alone — is what makes the order total. Two audit rows
 * can share a timestamp (a batch of imports, a single request writing several
 * entries), and a cursor that named only the timestamp would either skip the rest of
 * that millisecond or repeat it.
 */
export interface AuditLogCursor {
  /** ISO-8601 instant, exactly as the column yields it. */
  readonly occurredAt: string;
  /** The row's `id`, decimal. */
  readonly id: string;
}

/** One page of the log, and where the next one starts. */
export interface AuditLogQuery {
  readonly societyId: SocietyId;
  /**
   * The categories the caller may read — `auditVisibleCategories(member)`.
   *
   * Never empty in practice: an empty set is refused before the query is built,
   * because `category = ANY('{}')` would be a page of nothing rather than an error,
   * and "you may see nothing" must not look like "there is nothing".
   */
  readonly categories: readonly AuditCategory[];
  /**
   * The page size, already clamped by the caller (SAD §7.4: default 20, max 100).
   * The adapter reads one extra row to answer `hasMore` without a count.
   */
  readonly limit: number;
  /** `null` for the first page. */
  readonly cursor: AuditLogCursor | null;
}

/**
 * A persisted audit row, as a reader sees it.
 *
 * ## `action` and `entityType` are `string`, not the domain's unions
 *
 * The write vocabulary (`AuditAction`) is a closed TS union, and the *read* vocabulary
 * deliberately is not. The column is regex-shaped rather than an enum
 * (`20261015120000_audit_logs.sql`), precisely so a later deploy can record an action
 * this build has never heard of — and a reader that typed it as `AuditAction` would be
 * lying about runtime data the moment that happened. Narrowing is the consumer's
 * (`isAuditAction` in the audit vocabulary), so an unknown action renders as an opaque
 * name instead of crashing a screen.
 */
export interface AuditLogRecord {
  /** The row's position, decimal. Gaps are expected; it is not an operation count. */
  readonly id: string;
  /** ISO-8601 instant. */
  readonly occurredAt: string;
  /** `financial | other` — the split a Treasurer's view is narrowed to. */
  readonly category: AuditCategory;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  /** `null` when the actor's account no longer exists (`ON DELETE SET NULL`). */
  readonly actorUserId: string | null;
  /** The actor's role **at the time of the action**. */
  readonly actorRole: MemberRole | null;
  /** The row before the change, redacted. `null` means the entity did not exist. */
  readonly before: AuditJson;
  /** The row after the change, redacted. `null` means the entity was removed. */
  readonly after: AuditJson;
  /** Trusted request facts plus recorded extras. Already redacted. */
  readonly metadata: Readonly<Record<string, AuditJson>>;
}

/** One page: the rows, the cursor for the next page, and whether there is one. */
export interface AuditLogPage {
  readonly records: readonly AuditLogRecord[];
  /** `null` on the last page. */
  readonly nextCursor: AuditLogCursor | null;
  readonly hasMore: boolean;
}

/**
 * Builds the reader-audit entry for a completed read.
 *
 * A **function of the page**, because the two facts the write most needs — how many
 * rows came back, and whether a cursor was used to get them — only exist once the
 * query has run, which is the same reason `UnitOfWork`'s audit seam accepts a
 * function of the result (ADR-0014 D1). It returns a `descriptor`, not an entry: the
 * actor, the IP, the user agent and the `requestId` are filled from the server-side
 * request context by the adapter, exactly as every other call site's are.
 */
export type ReaderAuditPlan = (page: AuditLogPage) => AuditDescriptor;

/**
 * The audit log's read side.
 *
 * ## The reader-audit plan is a required parameter, not an option
 *
 * PRD §11.7: "the log itself records who viewed it". There is deliberately no
 * overload that reads without recording, and no default no-op plan — the whole point
 * of this increment is that a successful read produces a durable reader-audit row,
 * and an optional parameter is how that requirement would silently disappear from a
 * future call site. An adapter is free to write the descriptor through
 * `UnitOfWork`'s seam (which is what the Postgres adapter does), so the row commits
 * with the read or not at all: a read whose audit write fails is rolled back and must
 * not be reported as a successful response.
 *
 * ## Recursion is impossible by construction
 *
 * The reader-audit row is an **entry handed to the transaction's audit seam**, not a
 * trigger on the table: `write_audit_logs` inserts one row for one descriptor and
 * returns, so recording a read cannot fire another read and cannot generate a second
 * reader-audit entry. A trigger or a "log every SELECT" policy would be the shape that
 * recurses; there is deliberately no such trigger in the migration, and this port is
 * the reason none is needed.
 */
export interface AuditLogReader {
  list(
    query: AuditLogQuery,
    actor: UserId,
    readerAudit: ReaderAuditPlan,
  ): Promise<AuditLogPage>;
}
