import { Money, expenseError, systemClock, type Clock } from "@ses/domain";
import type {
  ExpenseEvent,
  ExpenseEventPublisher,
  ExpenseId,
  ExpensePublication,
  ExpensePublicationLookup,
  ExpenseRecalculation,
  ExpenseRecalculationSummary,
  ExpenseRecord,
  ExpenseSplitRepository,
  ExpenseSplitSummary,
  PublishExpenseAllocation,
  PublishExpenseRecordInput,
  RecalculateExpenseRecordInput,
  SocietyId,
  UserId,
} from "@ses/domain";

import type { FakeExpenseRepository } from "./fake-expense-repository";
import type { FakeRevisionRepository } from "./fake-revision-repository";

/**
 * An in-memory `ExpenseSplitRepository` for HTTP-level tests — Roadmap T066.
 *
 * ## Why the expense store is injected rather than duplicated
 *
 * A publication writes *two* things later requests read: the split rows, and the
 * `expenses` row's transition (`status`, `published_at`, `version`). The e2e suite
 * asserts both through the ordinary endpoints — `GET /expenses/:id` must answer
 * `published`, and a second publish must meet `invalid_transition` — so the fake has
 * to write where the suite's `ExpenseRepository` fake reads, because in production
 * those are one table inside one transaction. A second store here would let a suite
 * pass while the transition never happened.
 *
 * ## What it reproduces, because a use case is allowed to rely on it
 *
 *  - a record is looked up by `(actor, key)` — the unique index
 *    `idempotency_records(user_id, idempotency_key)` — so a key another caller used is
 *    not a replay here, exactly as it is not one in SQL;
 *  - a matching key **with the same `requestHash`** answers the stored publication
 *    with `replayed: true` and writes nothing;
 *  - a matching key with a *different* hash is `idempotency_key_reuse` (409), on the
 *    read path and on the write path alike;
 *  - the write path re-checks the record inside `publish`, which is what makes a
 *    concurrent double publish answer the loser with the winner's body instead of a
 *    second bill — the property T066's acceptance states as "replay the same
 *    idempotency key and confirm one publish";
 *  - the four refusals the port promises, in the order the definer function produces
 *    them: `not_found` (absent or another society), `invalid_transition` (not draft or
 *    `pending_approval`), `version_mismatch` (carrying the **current** version), and
 *    `split_mismatch` (allocations that do not sum to the row's amount);
 *  - a successful write advances the version by one and stamps `publishedAt`, because
 *    the definer function and `touch_updated_at()` do exactly that in production.
 *
 * It deliberately does **not** enforce the permission matrix, the reachability of a
 * member, or the reconciliation at COMMIT (`chk_split_total()`). The first two are the
 * guard chain's and the use case's; the last is a database constraint that only the
 * integration suite can prove, and it does.
 */

/** What one committed publication left behind, as a later replay must return it. */
export interface StoredPublication {
  readonly requestHash: string;
  readonly publication: ExpensePublication;
}

/** The registry key — the pair the table's unique index covers. */
export function publicationKeyOf(actor: UserId, key: string): string {
  return `${actor}:${key}`;
}

export interface FakeSplitRepository extends ExpenseSplitRepository {
  readonly state: {
    /** `(actor, idempotency key)` → the response a later replay must receive. */
    readonly records: Map<string, StoredPublication>;
    /** The persisted splits per expense — what the assertions read. */
    readonly splits: Map<ExpenseId, readonly PublishExpenseAllocation[]>;
    readonly calls: string[];
  };
  /**
   * Makes the next `publish` throw **before** writing anything — the suite's
   * stand-in for a mid-transaction failure. Nothing is written, so the suite can
   * assert zero partial writes and that no event was dispatched.
   */
  failNextPublish(error: Error): void;
  /** Runs just before the write path decides — the suite's race window. */
  beforePublish(hook: () => void): void;
}

export function createFakeSplitRepository(
  expenses: FakeExpenseRepository,
  now: Clock = systemClock,
  revisions?: FakeRevisionRepository,
): FakeSplitRepository {
  const records = new Map<string, StoredPublication>();
  const splits = new Map<ExpenseId, readonly PublishExpenseAllocation[]>();
  const calls: string[] = [];
  const failures: Error[] = [];
  const hooks: (() => void)[] = [];

  function replayOf(
    stored: StoredPublication,
    lookup: ExpensePublicationLookup,
  ): ExpensePublication {
    if (stored.requestHash !== lookup.requestHash) {
      throw expenseError(
        "idempotency_key_reuse",
        "This Idempotency-Key was already used for a different request. Use a new key.",
        { field: "idempotency-key" },
      );
    }
    return { ...stored.publication, replayed: true };
  }

  return {
    state: { records, splits, calls },

    failNextPublish(error) {
      failures.push(error);
    },

    beforePublish(hook) {
      hooks.push(hook);
    },

    async findPublication(
      input: ExpensePublicationLookup,
      actor: UserId,
    ): Promise<ExpensePublication | null> {
      calls.push("findPublication");
      const stored = records.get(publicationKeyOf(actor, input.idempotencyKey));
      return stored === undefined ? null : replayOf(stored, input);
    },

    async publish(
      id: ExpenseId,
      societyId: SocietyId,
      input: PublishExpenseRecordInput,
      actor: UserId,
    ): Promise<ExpensePublication> {
      calls.push("publish");
      for (const hook of hooks) hook();

      const failure = failures.shift();
      if (failure !== undefined) throw failure;

      // The concurrent case: a request that committed between this caller's
      // `findPublication` and this write is answered with that publication.
      const stored = records.get(publicationKeyOf(actor, input.idempotencyKey));
      if (stored !== undefined) return replayOf(stored, input);

      const record = expenses.state.records.get(id);
      if (record === undefined || record.societyId !== societyId) {
        throw expenseError(
          "not_found",
          "That expense is not available to you.",
        );
      }
      if (record.status !== "draft" && record.status !== "pending_approval") {
        throw expenseError(
          "invalid_transition",
          `A ${record.status} expense cannot be published.`,
          { from: record.status, to: "published" },
        );
      }
      if (record.version !== input.expectedVersion) {
        throw expenseError(
          "version_mismatch",
          "This expense was changed by someone else. Reload it and try again.",
          {
            field: "expectedVersion",
            expectedVersion: input.expectedVersion,
            currentVersion: record.version,
          },
        );
      }

      const summary = summarise(input.allocations);
      if (summary.total.paise !== record.amount.paise) {
        throw expenseError(
          "split_mismatch",
          "The split allocations do not sum to the expense amount.",
          { expected: record.amount.paise, actual: summary.total.paise },
        );
      }

      const publishedAt = now.nowIso();
      const published = {
        ...record,
        status: "published" as const,
        publishedAt,
        updatedAt: publishedAt,
        version: record.version + 1,
      };
      expenses.state.records.set(id, published);
      splits.set(id, [...input.allocations]);

      const publication: ExpensePublication = {
        expense: published,
        summary,
        replayed: false,
      };
      records.set(publicationKeyOf(actor, input.idempotencyKey), {
        requestHash: input.requestHash,
        publication,
      });
      return publication;
    },

    /**
     * T068's revision, in memory — the definer transaction's observable effects.
     *
     * It reproduces what a suite must be able to assert through the HTTP surface:
     * the same four refusals the port promises (`not_found`, `invalid_transition`,
     * `version_mismatch`, `split_mismatch`), the row's new version and fields, the
     * persisted allocations, **one** appended revision carrying the PRE-edit version
     * and the BEFORE state, and the signed diff measured between the two split sets.
     * Nothing here decides the due lifecycle, the balance deltas or the
     * paid-obligation block — those are PostgreSQL's and the integration suite's.
     */
    async recalculate(
      id: ExpenseId,
      societyId: SocietyId,
      input: RecalculateExpenseRecordInput,
      _actor: UserId,
    ): Promise<ExpenseRecalculation> {
      calls.push("recalculate");

      const record = expenses.state.records.get(id);
      if (record === undefined || record.societyId !== societyId) {
        throw expenseError(
          "not_found",
          "That expense is not available to you.",
        );
      }
      if (record.status !== "published") {
        throw expenseError(
          "invalid_transition",
          `A ${record.status} expense cannot be recalculated.`,
          { from: record.status, to: "published" },
        );
      }
      if (record.version !== input.expectedVersion) {
        throw expenseError(
          "version_mismatch",
          "This expense was changed by someone else. Reload it and try again.",
          {
            field: "expectedVersion",
            expectedVersion: input.expectedVersion,
            currentVersion: record.version,
          },
        );
      }

      const amount = input.fields.amountPaise ?? record.amount.paise;
      const summary = summarise(input.allocations);
      if (summary.total.paise !== amount) {
        throw expenseError(
          "split_mismatch",
          "The split allocations do not sum to the expense amount.",
          { expected: amount, actual: summary.total.paise },
        );
      }

      const before = record;
      const previous = splits.get(id) ?? [];
      const updatedAt = now.nowIso();
      const recalculated: ExpenseRecord = {
        ...record,
        title: input.fields.title ?? record.title,
        description: input.fields.description ?? record.description,
        vendorName: input.fields.vendorName ?? record.vendorName,
        amount: Money.fromPaise(amount),
        splitStrategy: input.fields.splitStrategy ?? record.splitStrategy,
        apartmentBasis:
          input.fields.apartmentBasis === undefined
            ? record.apartmentBasis
            : input.fields.apartmentBasis,
        splitConfig: input.fields.splitConfig ?? record.splitConfig,
        participantSelector:
          input.fields.participantSelector ?? record.participantSelector,
        updatedAt,
        version: record.version + 1,
      };
      expenses.state.records.set(id, recalculated);
      splits.set(id, [...input.allocations]);

      revisions?.append({
        expenseId: id,
        version: before.version,
        snapshot: revisionSnapshotOf(before, previous),
        changedBy: before.createdBy,
        changeNote: input.changeNote ?? null,
        createdAt: updatedAt,
      });

      return {
        expense: recalculated,
        summary: diffOf(previous, input.allocations, amount),
      };
    },
  };
}

/**
 * The BEFORE snapshot the definer function stores — the state the revision replaced.
 *
 * `amount_paise` travels as a digit string and the splits carry the four facts that
 * priced them, which is exactly what a tap-through screen reconstructs a bill from.
 */
function revisionSnapshotOf(
  record: ExpenseRecord,
  splits: readonly PublishExpenseAllocation[],
): {
  readonly expense: Readonly<Record<string, unknown>>;
  readonly splits: readonly Readonly<Record<string, unknown>>[];
} {
  return {
    expense: {
      id: record.id,
      societyId: record.societyId,
      categoryId: record.categoryId,
      title: record.title,
      description: record.description,
      amountPaise: record.amount.paise.toString(),
      expenseDate: record.expenseDate,
      vendorName: record.vendorName,
      paymentSource: record.paymentSource,
      paidByMemberId: record.paidByMemberId,
      splitStrategy: record.splitStrategy,
      apartmentBasis: record.apartmentBasis,
      splitConfig: record.splitConfig ?? {},
      participantSelector: record.participantSelector ?? {},
      status: record.status,
      version: record.version,
    },
    splits: splits.map((split) => ({
      memberId: split.memberId,
      apartmentId: split.apartmentId,
      amountPaise: split.amount.paise.toString(),
      weight: split.weight.toString(),
    })),
  };
}

/**
 * The signed diff between the two split sets, in the shape the RPC reports.
 *
 * A flat in both sets with a different amount is a **retained** due that moved (an
 * equal amount is not an update — that is what makes a title-only revision report
 * zero); a flat only in the old set is superseded; a flat only in the new set is
 * created. `totalPaise` is `SUM(new) − SUM(old)`, so the sign is the direction members
 * moved. **No** paid-obligation block is modelled: the fake has no payments, and the
 * real refusal is PostgreSQL's.
 */
function diffOf(
  previous: readonly PublishExpenseAllocation[],
  next: readonly PublishExpenseAllocation[],
  amount: bigint,
): ExpenseRecalculationSummary {
  const before = new Map(previous.map((split) => [split.apartmentId, split]));
  const after = new Map(next.map((split) => [split.apartmentId, split]));

  let duesUpdated = 0;
  let duesSuperseded = 0;
  let duesCreated = 0;
  const members = new Set<string>();

  for (const [apartmentId, split] of before) {
    members.add(split.memberId);
    const replacement = after.get(apartmentId);
    if (replacement === undefined) {
      if (split.amount.paise > 0n) duesSuperseded += 1;
      continue;
    }
    if (replacement.amount.paise !== split.amount.paise) duesUpdated += 1;
  }
  for (const [apartmentId, split] of after) {
    members.add(split.memberId);
    if (!before.has(apartmentId) && split.amount.paise > 0n) duesCreated += 1;
  }

  const previousTotal = previous.reduce(
    (sum, split) => sum + split.amount.paise,
    0n,
  );

  return {
    duesUpdated,
    duesSuperseded,
    duesCreated,
    totalDelta: Money.fromPaise(amount - previousTotal),
    affectedMembers: members.size,
    blockedByPaidSplits: 0,
  };
}

/** The PRD §8.3 summary, measured over the allocations the write received. */
export function summarise(
  allocations: readonly PublishExpenseAllocation[],
): ExpenseSplitSummary {
  const amounts = allocations.map((allocation) => allocation.amount.paise);
  const fold = (pick: (left: bigint, right: bigint) => bigint): bigint =>
    amounts.reduce(
      (carried, amount) => pick(carried, amount),
      amounts[0] ?? 0n,
    );

  return {
    participantCount: allocations.length,
    total: Money.fromPaise(amounts.reduce((sum, amount) => sum + amount, 0n)),
    min: Money.fromPaise(fold((low, amount) => (amount < low ? amount : low))),
    max: Money.fromPaise(
      fold((high, amount) => (amount > high ? amount : high)),
    ),
  };
}

/**
 * A capturing `ExpenseEventPublisher` — the post-commit seam, observed.
 *
 * `dispatched` keeps every call (one per fresh publication), so a suite can assert
 * *when* dispatch happened by inspecting the world inside `onDispatch` — the bill is
 * already published there, which is the whole meaning of "after commit".
 * `failNextDispatch` makes the next dispatch throw, which must leave the publication
 * committed and the request successful: SAD §3.2's "a failed notification never rolls
 * back the bill".
 */
export interface FakeEventPublisher extends ExpenseEventPublisher {
  readonly dispatched: (readonly ExpenseEvent[])[];
  /** Runs at dispatch time, before the failure queue is consulted. */
  onDispatch?: (events: readonly ExpenseEvent[]) => void;
  failNextDispatch(error: Error): void;
  reset(): void;
}

export function createFakeEventPublisher(): FakeEventPublisher {
  const dispatched: (readonly ExpenseEvent[])[] = [];
  const failures: Error[] = [];

  return {
    dispatched,

    failNextDispatch(error) {
      failures.push(error);
    },

    reset() {
      dispatched.length = 0;
      failures.length = 0;
    },

    dispatch(events) {
      this.onDispatch?.(events);
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      dispatched.push([...events]);
      return Promise.resolve();
    },
  };
}
