import { Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { AUDIT_READER_ENTITY } from "@ses/application";
import { auditError, AUDIT_VIEW_REASON } from "@ses/domain";
import type {
  AuditLogCursor,
  AuditLogPage,
  AuditLogQuery,
  AuditLogReader,
  AuditLogRecord,
  ReaderAuditPlan,
  UserId,
} from "@ses/domain";

import {
  UnitOfWork,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import { AuditService } from "../audit.service";
import {
  AUDIT_LOG_COLUMN_EXPRESSIONS,
  auditLogFromRow,
  auditLogRowSchema,
} from "./audit-log.rows";

/** The projection, as one raw fragment so the `select` cannot drift from the schema. */
const AUDIT_LOG_COLUMNS = sql.raw(AUDIT_LOG_COLUMN_EXPRESSIONS.join(", "));

/**
 * Reading `audit_logs` under the caller's own identity — T050 Stage E1, ADR-0014 D13.
 *
 * ## The read and its own audit row share one transaction
 *
 * `UnitOfWork.transaction(actor, work, audit)` is the whole mechanism: the `SELECT`
 * runs as `authenticated` with the caller's `auth.uid()` set, so the
 * `audit_logs_select_authorized` policy decides which rows exist, and the reader-audit
 * entry is handed to the seam's flush, which switches to `ses_api` and calls
 * `write_audit_logs` **in the same transaction**. Two consequences follow, and both are
 * requirements rather than side effects:
 *
 *  - the row commits with the read, so the API cannot report a successful read whose
 *    access was never recorded — a failed flush throws, the transaction rolls back, and
 *    the caller gets an error envelope (never a page);
 *  - **the row is not visible to the read that created it.** It is inserted after the
 *    `SELECT` has run, so the caller's own `audit.viewed` row appears on a *later*
 *    request — the next page, or the next visit. That is the semantics ADR-0014 D13
 *    records, and it is also what keeps the page from shifting under its own cursor.
 *
 * There is deliberately **no** second connection, no post-response write and no
 * read-only transaction: each of those would break exactly one of the two properties
 * above (ADR-0014 D13's failure semantics).
 *
 * ## Recursion is not possible through this path
 *
 * The entry is an explicit descriptor handed to the seam — not a trigger on the table
 * and not a `SELECT` side effect. `write_audit_logs` inserts one row per descriptor and
 * returns, so reading the log cannot generate a second reader-audit entry.
 *
 * ## Ordering and the cursor
 *
 * `order by occurred_at desc, id desc` is a **total** order and matches the table's own
 * `idx_audit_logs_society_occurred (society_id, occurred_at DESC, id DESC)`, so the page
 * boundary is served by an index rather than by a sort. The keyset predicate is a row
 * comparison — `(occurred_at, id) < (…, …)` — rather than two `OR`ed conditions, which
 * is what lets the planner use that index for the continuation too; the tuple carries
 * both columns because a shared timestamp alone would skip or repeat the rest of that
 * instant.
 *
 * The adapter reads **one row more than asked for** to answer `hasMore` honestly
 * without a `COUNT(*)`: a count over the whole log is the unbounded scan the cursor
 * exists to avoid (SAD §7.4 makes `total` optional for exactly this reason).
 */
@Injectable()
export class AuditLogRepositoryPostgres implements AuditLogReader {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    // T050 Stage E1: builds the reader-audit row the writer persists, via the seam.
    private readonly audit: AuditService,
  ) {}

  async list(
    query: AuditLogQuery,
    actor: UserId,
    readerAudit: ReaderAuditPlan,
  ): Promise<AuditLogPage> {
    // An empty set is refused rather than rendered. The use case refuses it first
    // (`forbidden`, before any query is built), so this is the guard against a *future*
    // caller that skips that step: `category in ()` is a syntax error, and the one thing
    // that must never happen here is a query with no category filter at all.
    if (query.categories.length === 0) {
      throw auditError("forbidden", AUDIT_VIEW_REASON);
    }

    // Bound explicitly rather than relying on the driver: the values are the caller's
    // query, and a `$1` left untyped would let Postgres infer `text` for the timestamp
    // and compare it against the index as text.
    const categories = query.categories.map(
      (category) => sql`${category}::varchar`,
    );

    const keyset =
      query.cursor === null
        ? sql``
        : sql`and (occurred_at, id) < (${query.cursor.occurredAt}::timestamptz, ${query.cursor.id}::bigint)`;

    return this.unitOfWork.transaction(
      { kind: "user", userId: actor },
      async (tx) => {
        const rows = await runQuery(
          tx,
          sql`
            select ${AUDIT_LOG_COLUMNS}
              from public.audit_logs
             where society_id = ${query.societyId}::uuid
               and category in (${sql.join(categories, sql`, `)})
               ${keyset}
             order by occurred_at desc, id desc
             limit ${query.limit + 1}
          `,
        );

        const records = parseRows(rows);
        // One extra row is the whole of `hasMore`: if it exists, the page was cut
        // short; if it does not, this was the last page and there is no cursor.
        const hasMore = records.length > query.limit;
        const page = hasMore ? records.slice(0, query.limit) : records;

        return {
          records: page,
          hasMore,
          nextCursor: hasMore ? cursorOf(page[page.length - 1]) : null,
        };
      },
      // The entry is built from the page — the row count and whether a cursor was
      // used only exist once the query has returned — and flushed by `UnitOfWork` as
      // the transaction's actor. `AuditService.entry` fills the actor, the request id,
      // the IP and the user agent from trusted context (ADR-0014 D5).
      (page) => [this.audit.entry(readerAudit(page))],
    );
  }
}

/**
 * The last row's position, as the cursor's sort tuple.
 *
 * The two halves are exactly the ordering's: the instant as the column yields it (ISO
 * 8601 — the row schema's normalisation, so the cursor and the JSON body agree) and the
 * id as its decimal string, which is how the `bigint` crosses back into SQL without
 * ever becoming a JS `number`.
 */
function cursorOf(row: AuditLogRecord | undefined): AuditLogCursor | null {
  return row === undefined ? null : { occurredAt: row.occurredAt, id: row.id };
}

async function runQuery(
  tx: TransactionContext,
  statement: SQL,
): Promise<readonly Record<string, unknown>[]> {
  const rows = await tx.execute(statement);
  return rows as unknown as readonly Record<string, unknown>[];
}

/**
 * Rows → records, or a refusal.
 *
 * A row that does not match `auditLogRowSchema` is never the caller's fault, so the
 * error keeps the module's fixed sentence and puts the actionable part in `details`,
 * where a log line can carry it without it reaching the response body.
 */
function parseRows(rows: readonly Record<string, unknown>[]): AuditLogRecord[] {
  return rows.map((row) => {
    const parsed = auditLogRowSchema.safeParse(row);
    if (!parsed.success) {
      throw auditError("unknown", "The audit log could not be read.", {
        hint: `Unexpected ${AUDIT_READER_ENTITY} shape returned by the database.`,
      });
    }
    return auditLogFromRow(parsed.data);
  });
}
