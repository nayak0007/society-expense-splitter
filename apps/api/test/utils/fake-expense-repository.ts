import { expenseError } from "@ses/domain";
import type {
  CreateExpenseRecordInput,
  ExpenseId,
  ExpenseListQuery,
  ExpensePage,
  ExpenseRecord,
  ExpenseRepository,
  SocietyId,
  UpdateExpenseRecordInput,
  UserId,
} from "@ses/domain";

/**
 * An in-memory `ExpenseRepository` for HTTP-level tests — Roadmap T065.
 *
 * ## What is faked, and what is emphatically not
 *
 * Only the *storage* and the version comparison — the two things that need a Postgres
 * connection in production. Everything between the request and this object runs for
 * real: the global auth guard verifies a real signature, `SocietyGuard` resolves
 * `X-Society-Id` to a membership, `PermissionGuard` asks the domain's matrix, the Zod
 * pipes parse the real contracts, the five use cases run, and the mapper parses its
 * output against the same contract the mobile client does. A fake at *this* boundary
 * therefore still fails when a rule regresses; a fake at the controller boundary would
 * not.
 *
 * ## The semantics it reproduces, because a use case is allowed to rely on them
 *
 *  - a record is addressable only by the pair `(expense id, society id)`, so a row
 *    belonging to another society is *unreachable*, not merely unauthorised — the
 *    `404`-not-`403` rule (PRD T041);
 *  - `update` answers `version_mismatch` carrying the **current** version when the
 *    stored row moved, `not_found` when it is absent, and `invalid_transition` when a
 *    row that is neither draft nor pending is written — the three refusals the port
 *    promises, in the order the SQL's `WHERE` produces them;
 *  - a successful write is one version older-than-plus-one: `version = stored + 1`,
 *    which is exactly T061's `touch()` as observed through the row;
 *  - `deleteDraft` removes the row or refuses it; there is no tombstone.
 *
 * It deliberately does **not** enforce roles, creator-only deletion or lifecycle
 * transitions beyond what the port itself promises. Those are what the guard chain, the
 * use cases and the domain are under test for, and a fake that decided them too would
 * let a broken one pass. The creator check that lives *inside the database*
 * (`expense_draft_delete`, migration `20261004120000`) is not reproduced here at all —
 * only the integration suite can prove it, and it does.
 */

export interface FakeExpenseRepository extends ExpenseRepository {
  readonly state: {
    readonly records: Map<ExpenseId, ExpenseRecord>;
    readonly calls: string[];
  };
  /** Inserts a record out of band, bypassing every rule. */
  seed(record: ExpenseRecord): void;
}

export function createFakeExpenseRepository(): FakeExpenseRepository {
  const records = new Map<ExpenseId, ExpenseRecord>();
  const calls: string[] = [];

  return {
    state: { records, calls },

    seed(record) {
      records.set(record.id, record);
    },

    async create(
      input: CreateExpenseRecordInput,
      _actor: UserId,
    ): Promise<ExpenseRecord> {
      calls.push("create");
      const { expense, fields } = input;
      const record: ExpenseRecord = {
        ...fields,
        id: expense.id,
        societyId: expense.societyId,
        categoryId: expense.categoryId,
        title: expense.title,
        amount: expense.amount,
        expenseDate: expense.expenseDate,
        createdBy: expense.createdBy,
        status: expense.status,
        // One INSERT is version 1, whatever the object's in-memory version became
        // through a threshold promotion — the row is written once.
        version: 1,
        publishedAt: null,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
        createdAt: expense.createdAt,
        updatedAt: expense.updatedAt,
      };
      records.set(record.id, record);
      return record;
    },

    async findById(
      id: ExpenseId,
      societyId: SocietyId,
      _actor: UserId,
    ): Promise<ExpenseRecord | null> {
      calls.push("findById");
      const record = records.get(id);
      if (record === undefined || record.societyId !== societyId) {
        return null;
      }
      return record;
    },

    async update(
      id: ExpenseId,
      societyId: SocietyId,
      expectedVersion: number,
      input: Omit<UpdateExpenseRecordInput, "expectedVersion">,
      _actor: UserId,
    ): Promise<ExpenseRecord> {
      calls.push("update");
      const stored = records.get(id);
      if (stored === undefined || stored.societyId !== societyId) {
        throw expenseError(
          "not_found",
          "That expense is not available to you.",
        );
      }
      if (stored.version !== expectedVersion) {
        throw expenseError(
          "version_mismatch",
          "This expense was changed by someone else. Reload it and try again.",
          {
            field: "expectedVersion",
            expectedVersion,
            currentVersion: stored.version,
          },
        );
      }
      if (stored.status !== "draft" && stored.status !== "pending_approval") {
        throw expenseError(
          "invalid_transition",
          `A ${stored.status} expense cannot be edited as a draft.`,
          { from: stored.status },
        );
      }

      const { expense, fields } = input;
      const record: ExpenseRecord = {
        ...fields,
        id: stored.id,
        societyId: stored.societyId,
        categoryId: expense.categoryId,
        title: expense.title,
        amount: expense.amount,
        expenseDate: expense.expenseDate,
        createdBy: stored.createdBy,
        status: expense.status,
        version: stored.version + 1,
        publishedAt: stored.publishedAt,
        voidedAt: stored.voidedAt,
        voidedBy: stored.voidedBy,
        voidReason: stored.voidReason,
        createdAt: stored.createdAt,
        updatedAt: expense.updatedAt,
      };
      records.set(record.id, record);
      return record;
    },

    async list(
      societyId: SocietyId,
      query: ExpenseListQuery,
      _actor: UserId,
    ): Promise<ExpensePage> {
      calls.push("list");
      let rows = [...records.values()]
        .filter((record) => record.societyId === societyId)
        .filter(
          (record) =>
            query.categoryId === undefined ||
            record.categoryId === query.categoryId,
        )
        .filter(
          (record) =>
            query.status === undefined || record.status === query.status,
        )
        .filter(
          (record) =>
            query.dateFrom === undefined ||
            record.expenseDate >= query.dateFrom,
        )
        .filter(
          (record) =>
            query.dateTo === undefined || record.expenseDate <= query.dateTo,
        )
        .filter(
          (record) =>
            query.createdBy === undefined ||
            record.createdBy === query.createdBy,
        )
        .filter(
          (record) =>
            query.amountPaiseMin === undefined ||
            record.amount.paise >= query.amountPaiseMin,
        )
        .filter(
          (record) =>
            query.amountPaiseMax === undefined ||
            record.amount.paise <= query.amountPaiseMax,
        )
        .filter(
          (record) =>
            query.search === undefined ||
            record.title.toLowerCase().includes(query.search.toLowerCase()),
        )
        // The production ordering — `expense_date DESC, id DESC` — so a cursor test
        // exercises the same tuple the SQL orders by.
        .sort((left, right) =>
          left.expenseDate === right.expenseDate
            ? left.id < right.id
              ? 1
              : -1
            : left.expenseDate < right.expenseDate
              ? 1
              : -1,
        );

      if (query.cursor !== undefined) {
        const cursor = query.cursor;
        rows = rows.filter(
          (record) =>
            record.expenseDate < cursor.expenseDate ||
            (record.expenseDate === cursor.expenseDate &&
              record.id < cursor.id),
        );
      }

      const page = rows.slice(0, query.limit);
      return {
        expenses: page,
        nextCursor:
          rows.length > query.limit && page.length > 0
            ? {
                expenseDate: page[page.length - 1]!.expenseDate,
                id: page[page.length - 1]!.id,
              }
            : null,
      };
    },

    async deleteDraft(
      id: ExpenseId,
      societyId: SocietyId,
      _actor: UserId,
    ): Promise<void> {
      calls.push("deleteDraft");
      const stored = records.get(id);
      if (stored === undefined || stored.societyId !== societyId) {
        throw expenseError(
          "not_found",
          "That expense is not available to you.",
        );
      }
      if (stored.status !== "draft") {
        throw expenseError(
          "invalid_transition",
          "Only a draft can be deleted. A published expense is voided instead.",
          { from: stored.status },
        );
      }
      records.delete(id);
    },
  };
}
