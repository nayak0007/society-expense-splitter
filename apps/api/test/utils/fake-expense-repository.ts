import { expenseError, systemClock } from "@ses/domain";
import type {
  ApproveExpenseRecordInput,
  Clock,
  CreateExpenseRecordInput,
  ExpenseId,
  ExpenseListQuery,
  ExpensePage,
  ExpenseRecord,
  ExpenseRepository,
  MemberId,
  RejectExpenseRecordInput,
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
  /**
   * Makes the next `approve` throw **before** writing anything — the suite's
   * stand-in for a refused or rolled-back decision. Nothing is stamped, so the
   * suite can assert the row is untouched.
   */
  failNextApprove(error: Error): void;
  /** Makes the next `reject` throw **before** writing anything. */
  failNextReject(error: Error): void;
}

/**
 * How the fake resolves a caller's membership id — the one production fact it
 * cannot derive from the port's arguments.
 *
 * `expense_approve()`/`expense_reject()` stamp the **caller's** membership, which
 * they read through `auth.uid()`; the fake has no `members` table, so a suite that
 * wants the approver recorded faithfully hands it the same resolver the membership
 * fixture uses. Without one the fake falls back to the row's creator, which is the
 * honest answer for the single-member case and is what let the older suites keep
 * calling `createFakeExpenseRepository()` with no argument.
 */
export interface FakeExpenseRepositoryOptions {
  readonly memberIdOf?: (
    societyId: SocietyId,
    actor: UserId,
  ) => MemberId | null;
  /** The clock the approval/rejection stamps are read from; defaults to the system one. */
  readonly clock?: Clock;
}

export function createFakeExpenseRepository(
  options: FakeExpenseRepositoryOptions = {},
): FakeExpenseRepository {
  const records = new Map<ExpenseId, ExpenseRecord>();
  const calls: string[] = [];
  const approveFailures: Error[] = [];
  const rejectFailures: Error[] = [];
  const now = options.clock ?? systemClock;

  const approverOf = (
    record: ExpenseRecord,
    societyId: SocietyId,
    actor: UserId,
  ): MemberId => options.memberIdOf?.(societyId, actor) ?? record.createdBy;

  return {
    state: { records, calls },

    seed(record) {
      records.set(record.id, record);
    },

    failNextApprove(error) {
      approveFailures.push(error);
    },

    failNextReject(error) {
      rejectFailures.push(error);
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
        // T070's workflow stamps. A create always starts clean — the threshold rule
        // may move the row to `pending_approval`, but nothing has been decided yet.
        approvedBy: expense.approvedBy,
        approvedAt: expense.approvedAt,
        rejectedBy: expense.rejectedBy,
        rejectedAt: expense.rejectedAt,
        rejectionReason: expense.rejectionReason,
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
        // The aggregate is the post-edit state, so its stamps are the ones to write:
        // `edit()` has already cleared any approval (D8's invalidation, which the
        // database's BEFORE UPDATE guard enforces for raw writers) and
        // `submitForApproval()` has already cleared the rejection stamps it answers.
        approvedBy: expense.approvedBy,
        approvedAt: expense.approvedAt,
        rejectedBy: expense.rejectedBy,
        rejectedAt: expense.rejectedAt,
        rejectionReason: expense.rejectionReason,
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

    /**
     * T070's approval, in memory — the definer transaction's observable effects.
     *
     * It reproduces the four refusals the port promises, in the order
     * `expense_approve()` produces them: `not_found` (absent or another society),
     * `invalid_transition` (not `pending_approval`), `version_mismatch` carrying the
     * **current** version, and `EXPENSE_ALREADY_APPROVED` as an `invalid_transition`
     * for a row that already carries both stamps — a second approval is a refusal,
     * never a replay. On success it stamps `approvedBy`/`approvedAt`, clears any
     * stale rejection metadata, and bumps the version by one, exactly as the definer
     * function and `touch_updated_at()` do. The status deliberately does **not** move.
     */
    async approve(
      id: ExpenseId,
      societyId: SocietyId,
      input: ApproveExpenseRecordInput,
      actor: UserId,
    ): Promise<ExpenseRecord> {
      calls.push("approve");

      const failure = approveFailures.shift();
      if (failure !== undefined) throw failure;

      const record = records.get(id);
      if (record === undefined || record.societyId !== societyId) {
        throw expenseError(
          "not_found",
          "That expense is not available to you.",
        );
      }
      if (record.status !== "pending_approval") {
        throw expenseError(
          "invalid_transition",
          `A ${record.status} expense cannot be approved.`,
          { from: record.status, to: "approved" },
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
      if (record.approvedBy !== null && record.approvedAt !== null) {
        throw expenseError(
          "invalid_transition",
          "This expense has already been approved.",
          { from: "approved", to: "approved" },
        );
      }

      const approvedAt = now.nowIso();
      const approved: ExpenseRecord = {
        ...record,
        approvedBy: approverOf(record, societyId, actor),
        approvedAt,
        rejectedBy: null,
        rejectedAt: null,
        rejectionReason: null,
        updatedAt: approvedAt,
        version: record.version + 1,
      };
      records.set(id, approved);
      return approved;
    },

    /**
     * T070's rejection, in memory — `pending_approval → draft` with its stamps.
     *
     * The refusals mirror `expense_reject()`'s order (`not_found`,
     * `invalid_transition` for a row that is not awaiting approval, then
     * `version_mismatch`), and on success the row returns to `draft` with the
     * approval cleared and `rejectedBy`/`rejectedAt`/`rejectionReason` recorded. The
     * reason is taken as sent: the domain and the contract have already validated it
     * one level up, and the database re-checks it — the fake claims no rule of its own.
     */
    async reject(
      id: ExpenseId,
      societyId: SocietyId,
      input: RejectExpenseRecordInput,
      actor: UserId,
    ): Promise<ExpenseRecord> {
      calls.push("reject");

      const failure = rejectFailures.shift();
      if (failure !== undefined) throw failure;

      const record = records.get(id);
      if (record === undefined || record.societyId !== societyId) {
        throw expenseError(
          "not_found",
          "That expense is not available to you.",
        );
      }
      if (record.status !== "pending_approval") {
        throw expenseError(
          "invalid_transition",
          `A ${record.status} expense cannot be rejected.`,
          { from: record.status, to: "draft" },
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

      const rejectedAt = now.nowIso();
      const rejected: ExpenseRecord = {
        ...record,
        status: "draft",
        approvedBy: null,
        approvedAt: null,
        rejectedBy: approverOf(record, societyId, actor),
        rejectedAt,
        rejectionReason: input.reason,
        updatedAt: rejectedAt,
        version: record.version + 1,
      };
      records.set(id, rejected);
      return rejected;
    },
  };
}
