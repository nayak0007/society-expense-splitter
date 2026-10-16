import {
  asAuditError,
  auditError,
  auditVisibleCategories,
  AUDIT_VIEW_REASON,
  err,
  ok,
} from "@ses/domain";
import type {
  AuditCategory,
  AuditDescriptor,
  AuditError,
  AuditLogCursor,
  AuditLogPage,
  AuditLogReader,
  MemberSnapshot,
  Result,
  UserId,
} from "@ses/domain";

/**
 * Read one page of a society's audit log — Roadmap T050 Stage E1, PRD §11.7.
 *
 * ## What this use case decides, and what it does not
 *
 * It decides **which half of the log the caller may read** (via the matrix, through
 * `auditVisibleCategories`) and **what the reader-audit row records**. It does not
 * decide the ordering, the page size or the cursor encoding: those belong to the
 * repository and the contract respectively, exactly as they do on every other list in
 * this codebase.
 *
 * ## The visibility filter is a query input, not a post-filter
 *
 * `categories` travels into the query. Filtering after the fetch would be wrong in two
 * ways at once: a Treasurer's page would come back short (the cursor's whole contract
 * is "a full page or the last one"), and rows they may not see would still have been
 * read into the process. The database is the second half of the same decision — the
 * `audit_logs_select_authorized` policy narrows through `can_view_audit` — so the two
 * layers agree by construction rather than by convention.
 *
 * ## The read records itself, through the reader-audit plan
 *
 * PRD §11.7: "the log itself records who viewed it". The plan handed to the reader
 * describes the access — the visible categories, the page size, whether a cursor was
 * used and how many rows came back — and never the cursor's contents, the query's raw
 * parameters or the page's payload. The **adapter** runs it inside the read's own
 * transaction through `UnitOfWork`'s audit seam, so the row commits with the read or
 * the whole thing rolls back: a read whose audit write fails is an error response, not
 * a silent success (ADR-0014 D13).
 *
 * The descriptor carries `before: null` and `after: null` deliberately. A read
 * transitions nothing, and the pair is how the log says so — the alternative (an
 * `after` describing the response) would put page content into an append-only table
 * nobody can delete from.
 *
 * ## Why `forbidden` is the refusal, and why it cannot be reached over HTTP
 *
 * A subject whose visible set is empty is refused **before** the query is built, so an
 * empty set can never become `category = ANY('{}')` — a page of nothing, which reads
 * like an empty society rather than like a refusal. Over HTTP the guard chain refuses
 * that caller first (403 `FORBIDDEN` for a role the matrix does not grant, 403
 * `MEMBER_INACTIVE` for a membership that is not active), so this answer is the
 * fail-closed default for a direct caller rather than a live path.
 */

/** Use-case dependencies: one read port, injected — never imported as a singleton. */
export interface AuditDeps {
  readonly logs: AuditLogReader;
}

/**
 * The entity type a reader-audit row names.
 *
 * The entity is the *log*, not a row of it: a read addresses a page of an
 * append-only stream, and there is no single `entity_id` that would be true. It
 * matches the column's own shape constraint (`^[a-z][a-z0-9_]*$`).
 */
export const AUDIT_READER_ENTITY = "audit_log";

/** What the caller asked for: who they are, how big a page and from where. */
export interface ListAuditLogsCommand {
  /**
   * The verified caller, from the token — the read runs *as* this user, which is what
   * makes `auth.uid()` and the `audit_logs_select_authorized` policy answer for them.
   */
  readonly actor: UserId;
  /**
   * The caller's membership, resolved by `SocietyGuard` from `X-Society-Id` — never
   * from a request body, and never a role a client named. It is a snapshot rather
   * than a `SocietyMembership` because the matrix reads four facts and nothing else.
   */
  readonly member: MemberSnapshot;
  /** Page size, already clamped by the contract (SAD §7.4: default 20, max 100). */
  readonly limit: number;
  /** `null` for the first page. */
  readonly cursor: AuditLogCursor | null;
}

/** The page, plus the visibility that produced it (what the reader audit records). */
export interface AuditLogList {
  readonly page: AuditLogPage;
  /** The categories the caller may read — `["financial","other"]` or `["financial"]`. */
  readonly categories: readonly AuditCategory[];
}

export async function listAuditLogs(
  deps: AuditDeps,
  command: ListAuditLogsCommand,
): Promise<Result<AuditLogList, AuditError>> {
  const categories = auditVisibleCategories(command.member);

  if (categories.length === 0) {
    // Fail closed, and before the query: an empty filter is a read of everything or a
    // page of nothing, and neither is an answer to "you may not read this".
    return err(auditError("forbidden", AUDIT_VIEW_REASON));
  }

  try {
    const page = await deps.logs.list(
      {
        societyId: command.member.societyId,
        categories,
        limit: command.limit,
        cursor: command.cursor,
      },
      command.actor,
      (read: AuditLogPage) => readerAuditDescriptor(command, categories, read),
    );

    return ok({ page, categories });
  } catch (error: unknown) {
    return err(asAuditError(error));
  }
}

/**
 * The access, described for the log.
 *
 * Every fact here is about **this read**: the visibility that applied, the page size,
 * whether the caller continued a scroll, and how many rows came back. None of it is a
 * secret, and none of it is the response — `returned: 0` on an empty last page is a
 * recorded fact rather than a missing row, which is what makes "somebody looked and
 * found nothing" distinguishable from "somebody never looked".
 *
 * The cursor's *contents* are deliberately absent: it names a position, and a stored
 * copy would be a second, unreachable copy of a query parameter. `usedCursor` is the
 * only part with audit meaning.
 */
function readerAuditDescriptor(
  command: ListAuditLogsCommand,
  categories: readonly AuditCategory[],
  page: AuditLogPage,
): AuditDescriptor {
  return {
    societyId: command.member.societyId,
    // `other`, not `financial`: reading the log is an access event, not financial
    // state, and a Treasurer does not get to see who read what — including, as it
    // happens, their own read (ADR-0014 D13).
    category: "other",
    action: "audit.viewed",
    entityType: AUDIT_READER_ENTITY,
    entityId: null,
    before: null,
    after: null,
    metadata: {
      categories: [...categories],
      limit: command.limit,
      usedCursor: command.cursor !== null,
      returned: page.records.length,
    },
  };
}
