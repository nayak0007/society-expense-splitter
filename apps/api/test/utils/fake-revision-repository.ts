import type {
  ExpenseId,
  ExpenseRevisionRecord,
  ExpenseRevisionRepository,
  SocietyId,
  UserId,
} from "@ses/domain";

/**
 * An in-memory `ExpenseRevisionRepository` — Roadmap T068's read seam.
 *
 * ## Why the store is written from outside
 *
 * Revisions are append-only and their only writer in production is the
 * `expense_recalculate()` definer transaction — so a *separate* fake that created its
 * own revision rows would be a second writer nothing exercises. Instead the split
 * repository fake appends to this store when its `recalculate` succeeds, exactly as
 * the definer function writes the row inside the revision's transaction, and this fake
 * only *reads*: a suite that swapped the read and left the write real would otherwise
 * pass while the two disagreed about whether a revision exists.
 *
 * ## What it deliberately does not reproduce
 *
 * The database's visibility rule (`expense_revisions_select_member` →
 * `can_view_expenses`) and the uniqueness of `(expense_id, version)` are constraints
 * only PostgreSQL can prove, and the integration suite does. The e2e suite exercises
 * the route's authorization and response shape, where the fake's job is to answer the
 * records it was handed.
 */
export interface FakeRevisionRepository extends ExpenseRevisionRepository {
  readonly state: {
    /** The appended rows, in write order — one per committed revision. */
    readonly records: ExpenseRevisionRecord[];
  };
  /** The definer transaction's write, as the split fake performs it. */
  append(
    record: Omit<ExpenseRevisionRecord, "id"> & { readonly id?: string },
  ): ExpenseRevisionRecord;
  reset(): void;
}

export function createFakeRevisionRepository(): FakeRevisionRepository {
  const records: ExpenseRevisionRecord[] = [];

  return {
    state: { records },

    append(record) {
      const stored: ExpenseRevisionRecord = {
        ...record,
        id: record.id ?? `revision-${String(records.length + 1)}`,
      };
      records.push(stored);
      return stored;
    },

    reset() {
      records.length = 0;
    },

    listForExpense(
      expenseId: ExpenseId,
      _societyId: SocietyId,
      _actor: UserId,
    ): Promise<readonly ExpenseRevisionRecord[]> {
      return Promise.resolve(
        records.filter((record) => record.expenseId === expenseId),
      );
    },
  };
}
