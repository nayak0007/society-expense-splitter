import type {
  AuditDescriptor,
  AuditLogCursor,
  AuditLogPage,
  AuditLogQuery,
  AuditLogReader,
  AuditLogRecord,
  ReaderAuditPlan,
  UserId,
} from "@ses/domain";

/**
 * In-memory `AuditLogReader` for the T050 Stage E1 HTTP suite.
 *
 * Only storage is faked. The guard chain, the pipes, the use case's visibility
 * decision, the cursor codec, the response mapper and the envelope all run for real,
 * which is what makes this suite able to fail when any of them regresses.
 *
 * ## It reproduces the *contract*, including the part that is easy to forget
 *
 * The real adapter hands the page it read to the `readerAudit` plan and flushes the
 * resulting descriptor inside the read's own transaction. This fake calls the plan
 * too, for the same reason: the plan is a **required** parameter of the port, and a
 * suite that let a `list()` call without one pass would be the coverage hole the
 * reader audit exists to close. So `state.plans` is non-empty exactly when the route
 * handed one down, and `state.descriptors` holds what the plan produced.
 *
 * ## What it deliberately does not reproduce
 *
 * RLS, the keyset SQL and the persisted row. The fake filters and pages in memory so
 * a cursor test exercises the same tuple the SQL orders by, but the transaction
 * coupling and the write itself are the integration suite's subject — a fake that
 * pretended to write an audit row would be asserting itself.
 */

export interface FakeAuditLogReader extends AuditLogReader {
  readonly state: {
    /** The rows the fake holds — the whole "table". */
    readonly rows: AuditLogRecord[];
    /**
     * Every call, in order: what was asked, and by which verified actor.
     *
     * Mutable arrays behind `readonly` properties — the convention every fake in this
     * directory follows: a suite clears them in `beforeEach` rather than rebuilding the
     * fake, while no test may reassign the property itself.
     */
    readonly calls: { query: AuditLogQuery; actor: UserId }[];
    /** The plans the route supplied — one per call, if the route is wired. */
    readonly plans: ReaderAuditPlan[];
    /** The descriptors those plans produced from the pages the fake served. */
    readonly descriptors: AuditDescriptor[];
    /**
     * Set to make the next read fail, as a rolled-back read can. `list` throws it
     * before the plan is invoked, which is the real order: a page that was never
     * read has no access to record.
     *
     * Typed as `Error` rather than `AuditError` on purpose: the interesting failure
     * is the adapter throwing a raw `PostgresError` (`42501 permission denied for
     * function write_audit_logs`), which the use case's `catch` is what converts.
     * A suite that could only inject an `AuditError` would skip that classification.
     */
    failure: Error | null;
  };
  /** Replaces the fake's rows. */
  seed(records: readonly AuditLogRecord[]): void;
}

export function createFakeAuditLogReader(): FakeAuditLogReader {
  const rows: AuditLogRecord[] = [];
  const calls: { query: AuditLogQuery; actor: UserId }[] = [];
  const plans: ReaderAuditPlan[] = [];
  const descriptors: AuditDescriptor[] = [];
  const state = {
    rows,
    calls,
    plans,
    descriptors,
    failure: null as Error | null,
  };

  return {
    state,

    seed(records: readonly AuditLogRecord[]): void {
      rows.length = 0;
      rows.push(...records);
    },

    async list(
      query: AuditLogQuery,
      actor: UserId,
      readerAudit: ReaderAuditPlan,
    ): Promise<AuditLogPage> {
      calls.push({ query, actor });
      plans.push(readerAudit);

      if (state.failure !== null) {
        throw state.failure;
      }

      const visible = rows
        .filter((row) => query.categories.includes(row.category))
        .sort(byPosition)
        .filter((row) => afterCursor(row, query.cursor));

      // One row more than asked for, like the adapter: that is what answers
      // `hasMore` without a count.
      const hasMore = visible.length > query.limit;
      const page = hasMore ? visible.slice(0, query.limit) : visible;
      const result: AuditLogPage = {
        records: page,
        hasMore,
        nextCursor: hasMore ? cursorOf(page[page.length - 1]!) : null,
      };

      descriptors.push(readerAudit(result));
      return result;
    },
  };
}

/** The production ordering — `occurred_at DESC, id DESC`. */
function byPosition(left: AuditLogRecord, right: AuditLogRecord): number {
  if (left.occurredAt !== right.occurredAt) {
    return left.occurredAt < right.occurredAt ? 1 : -1;
  }
  return BigInt(left.id) < BigInt(right.id) ? 1 : -1;
}

/** The keyset predicate, as `(occurred_at, id) < (…, …)`. */
function afterCursor(
  row: AuditLogRecord,
  cursor: AuditLogCursor | null,
): boolean {
  if (cursor === null) return true;
  if (row.occurredAt < cursor.occurredAt) return true;
  return (
    row.occurredAt === cursor.occurredAt && BigInt(row.id) < BigInt(cursor.id)
  );
}

function cursorOf(row: AuditLogRecord): AuditLogCursor {
  return { occurredAt: row.occurredAt, id: row.id };
}

/**
 * A row builder for seeds.
 *
 * The defaults are an Admin's `expense.published` — a `financial` entry, which is the
 * half both a Treasurer and an Admin can read, so a test that wants the narrowing to
 * matter overrides `category` rather than the fixture hiding it.
 */
export function auditLogRecordFixture(
  overrides: Partial<AuditLogRecord> = {},
): AuditLogRecord {
  return {
    id: "1",
    occurredAt: "2026-10-01T00:00:00.000Z",
    category: "financial",
    action: "expense.published",
    entityType: "expense",
    entityId: "20000000-0000-4000-8000-000000000001",
    actorUserId: "11111111-1111-4111-8111-111111111111",
    actorRole: "admin",
    before: { status: "draft" },
    after: { status: "published" },
    metadata: { requestId: "req-1" },
    ...overrides,
  };
}
