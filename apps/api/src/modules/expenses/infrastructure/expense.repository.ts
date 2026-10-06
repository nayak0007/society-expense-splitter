import { Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import {
  ExpenseError,
  isExpenseEditableStatus,
  isExpenseError,
  isExpenseStatus,
} from "@ses/domain";
import type {
  ApproveExpenseRecordInput,
  CreateExpenseRecordInput,
  RejectExpenseRecordInput,
  ExpenseId,
  ExpensePage,
  ExpenseRecord,
  ExpenseRepository,
  SocietyId,
  UpdateExpenseRecordInput,
  ExpenseCursor,
  ExpenseListQuery,
  UserId,
} from "@ses/domain";

import {
  UnitOfWork,
  type TransactionActor,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import {
  NO_WORKFLOW_STAMPS,
  enrichVersionMismatch,
  expenseDetailRowListSchema,
  expenseDetailRowSchema,
  expenseErrorFromPostgres,
  expenseFromDetailRow,
  expenseWorkflowRowSchema,
  expenseWorkflowStampsOf,
  unexpectedShapeError,
} from "./expense.rows";
import type { ExpenseWorkflowStamps } from "./expense.rows";

/**
 * `ExpenseRepository` over Postgres, under RLS — Roadmap T065.
 *
 * ## One transaction per operation, with the caller as its identity
 *
 * Every method opens a transaction through `UnitOfWork` with `actor`, which sets
 * `app.user_id` and switches to the `authenticated` role for its duration — so
 * `auth.uid()` inside every committed policy resolves to the caller, and a read or
 * write that forgot the actor would fail closed (no identity, every policy false).
 *
 * ## `society_id` is in every `WHERE`, including the ones keyed by `id`
 *
 * An expense id alone does not say which tenant the caller is acting in, so every
 * statement pairs the two — belt and braces beside RLS, and what makes a
 * cross-society id *unaddressable* as well as unreadable.
 *
 * ## The update is one atomic statement, never read-then-write
 *
 * `WHERE id AND society_id AND version = expectedVersion AND status IN
 * ('draft','pending_approval')` is the optimistic lock T065's acceptance asks for.
 * A stale caller matches zero rows, and the classification that follows is a
 * *re-read of the failed write's cause* — not the write itself: the row moved, was
 * never this status, or does not exist, and each answer maps to its own stable
 * error. There is no window in which a JS comparison's `true` is acted on
 * unconditionally, which is the lost-update bug the acceptance names.
 *
 * ## The list is one query and the cursor is a row comparison
 *
 * `(expense_date, id) < (cursor.expense_date, cursor.id)` with `ORDER BY
 * expense_date DESC, id DESC` is stable against insertion — SAD §7.4's whole
 * reason for cursors over offsets — and rides `idx_expenses_society_date`. Filters
 * are built from named parameters only; the search predicate spells the GIN
 * index's own expression, character for character, or the planner silently
 * seq-scans.
 *
 * ## Deleting is the definer function, and nothing here writes `DELETE`
 *
 * `expense_draft_delete()` (migration `20261004120000`) is the only path: `DELETE`
 * is not granted on `expenses`, and the function enforces creator-only,
 * draft-only and no-splits inside the database. This adapter classifies its
 * refusals; it does not re-implement its rules.
 */
@Injectable()
export class ExpenseRepositoryPostgres implements ExpenseRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /**
   * Insert one row — a draft, or a pending-approval expense the threshold promoted.
   *
   * `id` is deliberately absent from the column list: it is not `INSERT`-granted
   * (T060's grant list is the writable-field model) and the column is
   * `DEFAULT gen_random_uuid()`, which is the convention the category adapter set.
   * The aggregate's own id is its in-memory identity; the row's id is minted by the
   * database and returned here, so a caller can never supply one.
   */
  async create(
    input: CreateExpenseRecordInput,
    actor: UserId,
  ): Promise<ExpenseRecord> {
    return this.run(actor, "write", async (tx) => {
      const { expense, fields } = input;
      const rows = await runQuery(
        tx,
        sql`
          insert into public.expenses (
            society_id, category_id, title, description, amount_paise,
            expense_date, vendor_name, payment_source, paid_by_member_id,
            split_strategy, apartment_basis, split_config, participant_selector,
            status, created_by
          )
          values (
            ${expense.societyId}::uuid,
            ${expense.categoryId}::uuid,
            ${expense.title}::varchar,
            ${fields.description}::text,
            ${expense.amount.paise.toString()}::bigint,
            ${expense.expenseDate}::date,
            ${fields.vendorName}::varchar,
            ${fields.paymentSource}::varchar,
            ${fields.paidByMemberId}::uuid,
            ${fields.splitStrategy}::public.split_strategy,
            ${fields.apartmentBasis}::public.apartment_basis,
            ${JSON.stringify(fields.splitConfig ?? {})}::jsonb,
            ${JSON.stringify(fields.participantSelector ?? {})}::jsonb,
            ${expense.status}::public.expense_status,
            ${expense.createdBy}::uuid
          )
          returning ${EXPENSE_DETAIL_COLUMNS}
        `,
      );
      return expenseFromDetailRow(parseSingleRow(rows, "created expense"));
    });
  }

  /** One expense of one society, `null` when the actor may not see it. */
  async findById(
    id: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<ExpenseRecord | null> {
    return this.run(actor, "read", async (tx) => {
      const rows = await runQuery(
        tx,
        sql`
          select ${EXPENSE_DETAIL_COLUMNS}
            from public.expenses
           where id = ${id}::uuid
             and society_id = ${societyId}::uuid
           limit 1
        `,
      );
      const [row] = parseRows(rows);
      return row === undefined ? null : expenseFromDetailRow(row);
    });
  }

  /**
   * Write the whole post-edit row, locked on `expectedVersion`.
   *
   * The `RETURNING` clause reads back what actually landed — including the version
   * the trigger bumped — so the caller's response never reconstructs state from
   * what it hoped it wrote.
   */
  async update(
    id: ExpenseId,
    societyId: SocietyId,
    expectedVersion: number,
    input: Omit<UpdateExpenseRecordInput, "expectedVersion">,
    actor: UserId,
  ): Promise<ExpenseRecord> {
    return this.run(actor, "write", async (tx) => {
      const { expense, fields } = input;
      const rows = await runQuery(
        tx,
        sql`
          update public.expenses
             set category_id = ${expense.categoryId}::uuid,
                 title = ${expense.title}::varchar,
                 description = ${fields.description}::text,
                 amount_paise = ${expense.amount.paise.toString()}::bigint,
                 expense_date = ${expense.expenseDate}::date,
                 vendor_name = ${fields.vendorName}::varchar,
                 payment_source = ${fields.paymentSource}::varchar,
                 paid_by_member_id = ${fields.paidByMemberId}::uuid,
                 split_strategy = ${fields.splitStrategy}::public.split_strategy,
                 apartment_basis = ${fields.apartmentBasis}::public.apartment_basis,
                 split_config = ${JSON.stringify(fields.splitConfig ?? {})}::jsonb,
                 participant_selector = ${JSON.stringify(fields.participantSelector ?? {})}::jsonb,
                 status = ${expense.status}::public.expense_status
           where id = ${id}::uuid
             and society_id = ${societyId}::uuid
             and version = ${expectedVersion}::int
             and status in ('draft', 'pending_approval')
          returning ${EXPENSE_DETAIL_COLUMNS}
        `,
      );

      const [row] = parseRows(rows);
      if (row !== undefined) return expenseFromDetailRow(row);
      throw await this.classifyFailedUpdate(tx, id, societyId, expectedVersion);
    });
  }

  /** One page of the filtered list, newest first, with the next cursor. */
  async list(
    societyId: SocietyId,
    query: ExpenseListQuery,
    actor: UserId,
  ): Promise<ExpensePage> {
    return this.run(actor, "read", async (tx) => {
      const conditions: SQL[] = [sql`society_id = ${societyId}::uuid`];

      if (query.categoryId !== undefined) {
        conditions.push(sql`category_id = ${query.categoryId}::uuid`);
      }
      if (query.status !== undefined) {
        conditions.push(sql`status = ${query.status}::public.expense_status`);
      }
      if (query.dateFrom !== undefined) {
        conditions.push(sql`expense_date >= ${query.dateFrom}::date`);
      }
      if (query.dateTo !== undefined) {
        conditions.push(sql`expense_date <= ${query.dateTo}::date`);
      }
      if (query.amountPaiseMin !== undefined) {
        conditions.push(
          sql`amount_paise >= ${query.amountPaiseMin.toString()}::bigint`,
        );
      }
      if (query.amountPaiseMax !== undefined) {
        conditions.push(
          sql`amount_paise <= ${query.amountPaiseMax.toString()}::bigint`,
        );
      }
      if (query.createdBy !== undefined) {
        conditions.push(sql`created_by = ${query.createdBy}::uuid`);
      }
      if (query.search !== undefined) {
        // The index's expression verbatim (T060): a re-spelling silently seq-scans.
        conditions.push(
          sql`to_tsvector('english', title || ' ' || coalesce(description, '') || ' ' || coalesce(vendor_name, '')) @@ plainto_tsquery('english', ${query.search})`,
        );
      }

      const cursor =
        query.cursor === undefined
          ? sql``
          : sql`and (expense_date, id) < (${query.cursor.expenseDate}::date, ${query.cursor.id}::uuid)`;

      const rows = await runQuery(
        tx,
        sql`
          select ${EXPENSE_DETAIL_COLUMNS}
            from public.expenses
           where ${sql.join(conditions, sql` and `)}
             ${cursor}
           order by expense_date desc, id desc
           limit ${query.limit + 1}::int
        `,
      );

      const parsed = parseRows(rows);
      const page = parsed
        .slice(0, query.limit)
        .map((row) => expenseFromDetailRow(row));
      const hasMore = parsed.length > query.limit;
      const last = page.at(-1);
      const nextCursor: ExpenseCursor | null =
        hasMore && last !== undefined
          ? { expenseDate: last.expenseDate, id: last.id }
          : null;

      return { expenses: page, nextCursor };
    });
  }

  /** Hard-delete one draft through the definer function — creator only. */
  async deleteDraft(
    id: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<void> {
    await this.run(actor, "write", async (tx) => {
      await runQuery(
        tx,
        sql`select public.expense_draft_delete(${id}::uuid, ${societyId}::uuid)`,
      );
    });
  }

  /**
   * Approve one `pending_approval` expense — T070's decision, ADR-0011.
   *
   * One call to the `expense_approve()` definer transaction, which owns every rule:
   * Admin-only, the row locked, the lifecycle and the caller's version checked, then
   * `approved_by`/`approved_at` stamped and stale rejection metadata cleared, with
   * the version bumped by the shared trigger. This adapter re-implements none of
   * that — it hands over the two facts the function needs (the id pair and the
   * caller's version) and classifies the row back out.
   *
   * Returned through `expenseDetailRowSchema` because the function returns the
   * *whole* row including the workflow stamps: an approval response must describe the
   * approval, not a row that keeps its `null`s.
   */
  async approve(
    id: ExpenseId,
    societyId: SocietyId,
    input: ApproveExpenseRecordInput,
    actor: UserId,
  ): Promise<ExpenseRecord> {
    try {
      return await this.run(actor, "write", async (tx) => {
        const rows = await runQuery(
          tx,
          sql`
            select ${EXPENSE_DECISION_COLUMNS}
              from public.expense_approve(
                ${id}::uuid,
                ${societyId}::uuid,
                ${input.expectedVersion}::int
              )
          `,
        );
        return approvedOrRejectedRow(rows, "approved expense");
      });
    } catch (error: unknown) {
      throw enrichVersionMismatch(error, input.expectedVersion);
    }
  }

  /**
   * Reject one `pending_approval` expense — T070's other decision, ADR-0011.
   *
   * The whole decision is the `expense_reject()` definer transaction:
   * `pending_approval → draft`, the approval cleared, and
   * `rejected_by`/`rejected_at`/`rejection_reason` recorded with a reason validated
   * inside the database as well as here. No financial row is touched, and the
   * function returns the authoritative row — read through the detail schema because
   * it carries the stamps the response must show.
   */
  async reject(
    id: ExpenseId,
    societyId: SocietyId,
    input: RejectExpenseRecordInput,
    actor: UserId,
  ): Promise<ExpenseRecord> {
    try {
      return await this.run(actor, "write", async (tx) => {
        const rows = await runQuery(
          tx,
          sql`
            select ${EXPENSE_DECISION_COLUMNS}
              from public.expense_reject(
                ${id}::uuid,
                ${societyId}::uuid,
                ${input.expectedVersion}::int,
                ${input.reason}::text
              )
          `,
        );
        return approvedOrRejectedRow(rows, "rejected expense");
      });
    } catch (error: unknown) {
      throw enrichVersionMismatch(error, input.expectedVersion);
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Why an `UPDATE` matched no row — resolved from the row itself, never guessed.
   *
   * Three causes, and the caller needs to tell them apart: the row is not there
   * (`not_found`), it is no longer editable (`invalid_transition`), or it moved
   * (`version_mismatch`, carrying the **current** version so a client can reload).
   * The read is scoped by both ids under the same transaction, so it answers with
   * the row the failed statement was looking at — and a row that vanished between
   * the two statements still answers `not_found`.
   */
  private async classifyFailedUpdate(
    tx: TransactionContext,
    id: ExpenseId,
    societyId: SocietyId,
    expectedVersion: number,
  ): Promise<ExpenseError> {
    const rows = await runQuery(
      tx,
      sql`
        select status::text as status, version
          from public.expenses
         where id = ${id}::uuid
           and society_id = ${societyId}::uuid
         limit 1
      `,
    );

    const current = rows[0];
    if (current === undefined) {
      return new ExpenseError(
        "not_found",
        "That expense is not available to you.",
      );
    }

    const status = current["status"];
    if (!isExpenseStatus(status) || !isExpenseEditableStatus(status)) {
      return new ExpenseError(
        "invalid_transition",
        `A ${String(status)} expense cannot be edited as a draft. Only drafts and expenses awaiting approval can be edited.`,
        { from: status },
      );
    }

    const currentVersion = Number(current["version"]);
    return new ExpenseError(
      "version_mismatch",
      "This expense was changed by someone else. Reload it and try again.",
      {
        field: "expectedVersion",
        expectedVersion,
        currentVersion: Number.isFinite(currentVersion)
          ? currentVersion
          : expectedVersion,
      },
    );
  }

  /**
   * Runs `work` as `actor` and classifies any failure into the module's vocabulary.
   *
   * An `ExpenseError` thrown inside passes through untouched — `classifyFailedUpdate`
   * already produced the right answer, and re-classifying it would replace a precise
   * refusal with a generic one.
   */
  private async run<T>(
    actor: UserId,
    context: "read" | "write",
    work: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    const identity: TransactionActor = { kind: "user", userId: actor };
    try {
      return await this.unitOfWork.transaction(identity, work);
    } catch (error: unknown) {
      throw isExpenseError(error)
        ? error
        : expenseErrorFromPostgres(error, context);
    }
  }
}

/**
 * The columns every read and write returns, in one place.
 *
 * Two casts are load-bearing: `amount_paise::text` keeps money out of the driver's
 * numeric handling until `expenseFromRow` converts it exactly, and
 * `expense_date::text` keeps a `date` a date instead of a midnight instant.
 * `version` is returned without a cast — it is the optimistic lock's operand and an
 * `int4`, and the row schema coerces it.
 *
 * Exported as the list of expressions rather than only as the joined fragment,
 * because T066's `expense_publish()` returns the *same* row shape plus one extra
 * column, and the split repository composes its select from this list. Two spellings
 * of the row would be one rename away from a response that silently loses a field —
 * the exact failure `expenseRowSchema` exists to make loud.
 */
export const EXPENSE_COLUMN_EXPRESSIONS: readonly string[] = [
  "id",
  "society_id",
  "category_id",
  "title",
  "description",
  "amount_paise::text as amount_paise",
  "expense_date::text as expense_date",
  "vendor_name",
  "payment_source",
  "paid_by_member_id",
  "split_strategy",
  "apartment_basis",
  "split_config",
  "participant_selector",
  "status",
  "created_by",
  "published_at",
  "voided_at",
  "voided_by",
  "void_reason",
  "version",
  "created_at",
  "updated_at",
];

/**
 * The workflow columns T070 added (migration #31), appended to the base list for
 * every plain `expenses` select.
 *
 * They are a second list rather than five more entries above because the three
 * definer functions (`expense_publish`/`expense_recalculate`/`expense_void`) return
 * the *base* row: T070 deliberately does not change their signatures (ADR-0011 D4
 * adds only the precondition), so the split repository composes its selects from
 * the base list and these columns are read beside those rows instead.
 */
export const EXPENSE_WORKFLOW_COLUMN_EXPRESSIONS: readonly string[] = [
  "approved_by",
  "approved_at",
  "rejected_by",
  "rejected_at",
  "rejection_reason",
];

/** Every column a whole-expense read returns: the base list plus the stamps. */
export const EXPENSE_DETAIL_COLUMN_EXPRESSIONS: readonly string[] = [
  ...EXPENSE_COLUMN_EXPRESSIONS,
  ...EXPENSE_WORKFLOW_COLUMN_EXPRESSIONS,
];

const EXPENSE_DETAIL_COLUMNS = sql.raw(
  EXPENSE_DETAIL_COLUMN_EXPRESSIONS.join(", "),
);

/**
 * The two decision RPCs (`expense_approve`/`expense_reject`) return exactly the
 * detail shape — the base columns followed by the workflow columns, in that order —
 * so they share one column list with the reads rather than a third spelling.
 */
export const EXPENSE_DECISION_COLUMNS = EXPENSE_DETAIL_COLUMNS;

export type Row = Record<string, unknown>;

/** The one `execute` → rows cast, shared with the split repository (T066). */
export async function runQuery(
  tx: TransactionContext,
  statement: SQL,
): Promise<readonly Row[]> {
  const rows = await tx.execute(statement);
  return rows as unknown as readonly Row[];
}

function parseRows(rows: readonly Row[]) {
  const parsed = expenseDetailRowListSchema.safeParse(rows);
  if (!parsed.success) {
    throw unexpectedShapeError("expense");
  }
  return parsed.data;
}

function parseSingleRow(rows: readonly Row[], what: string) {
  const [first] = parseRows(rows);
  if (first === undefined) {
    throw unexpectedShapeError(what);
  }
  const parsed = expenseDetailRowSchema.safeParse(first);
  if (!parsed.success) {
    throw unexpectedShapeError(what);
  }
  return parsed.data;
}

/** One decision RPC's single row → the flat record, or a bad-shape failure. */
function approvedOrRejectedRow(
  rows: readonly Row[],
  what: string,
): ExpenseRecord {
  const [first] = rows;
  if (first === undefined) {
    throw unexpectedShapeError(what);
  }
  const parsed = expenseDetailRowSchema.safeParse(first);
  if (!parsed.success) {
    throw unexpectedShapeError(what);
  }
  return expenseFromDetailRow(parsed.data);
}

/**
 * The workflow stamps of one row, read in the caller's own transaction — T070.
 *
 * The three definer functions that predate T070 (`expense_publish`,
 * `expense_recalculate`, `expense_void`) return the base row, and T070 deliberately
 * does not change their signatures (ADR-0011 D4 adds only the publication
 * precondition). Their responses must still describe the approval state — a
 * published high-value expense **is** approved, and reporting `null` would be a lie
 * a client renders as "not approved" — so the five columns are read back in the same
 * transaction, where the function's own write is already visible. One extra cheap
 * read on a rare operation, and no second row shape.
 *
 * A missing row answers `NO_WORKFLOW_STAMPS` rather than throwing: the caller has
 * just written that row inside this transaction, so its absence is impossible in
 * practice, and a refusal here would turn a successful publish into a 500 over a
 * cosmetic field.
 */
export async function readExpenseWorkflowStamps(
  tx: TransactionContext,
  id: ExpenseId,
  societyId: SocietyId,
): Promise<ExpenseWorkflowStamps> {
  const rows = await runQuery(
    tx,
    sql`
      select approved_by, approved_at, rejected_by, rejected_at, rejection_reason
        from public.expenses
       where id = ${id}::uuid
         and society_id = ${societyId}::uuid
       limit 1
    `,
  );

  const [first] = rows;
  if (first === undefined) return NO_WORKFLOW_STAMPS;

  const parsed = expenseWorkflowRowSchema.safeParse(first);
  if (!parsed.success) {
    throw unexpectedShapeError("expense workflow stamps");
  }
  return expenseWorkflowStampsOf(parsed.data);
}
