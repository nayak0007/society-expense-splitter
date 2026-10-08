import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { isExpenseError } from "@ses/domain";
import type {
  ExpenseCommentDraft,
  ExpenseCommentId,
  ExpenseCommentRecord,
  ExpenseCommentRepository,
  ExpenseId,
  SocietyId,
  UserId,
} from "@ses/domain";

import {
  UnitOfWork,
  type TransactionActor,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import { expenseErrorFromPostgres, unexpectedShapeError } from "./expense.rows";
import { runQuery, type Row } from "./expense.repository";
import {
  EXPENSE_COMMENT_COLUMN_EXPRESSIONS,
  commentFromRow,
  expenseCommentRowSchema,
} from "./comment.rows";

/**
 * `ExpenseCommentRepository` over Postgres, under RLS — Roadmap T072.
 *
 * ## The stream is ordered by the database, and the read is one query
 *
 * `order by public.expense_comments.sequence asc` is the whole ordering contract
 * (D1): the sequence is a monotonic identity, unique per expense, so the list is
 * deterministic under concurrent inserts — two members commenting at once get two
 * distinct positions and both rows survive. A comment is never fetched alone; a
 * stream is.
 *
 * ## Why the `order by` names the column *through the table* (2026-10-08)
 *
 * `sequence` is selected as `sequence::text as sequence` (see `comment.rows.ts`),
 * so this query has an **output** column named `sequence` whose type is `text`.
 * When an ORDER BY expression is a bare name matching both an output column and an
 * input column, PostgreSQL resolves it to the **output** column — the opposite of
 * GROUP BY's rule. A bare `order by sequence asc` therefore sorted the *text*:
 * measured on `postgres:18-alpine`, a stream holding the positions 1, 2, 10, 11
 * came back as 1, 10, 11, 2. The stream is read by members, so that is a wrong
 * thread rather than a slow one, and it is reachable in production because the
 * identity is table-wide: the first expense whose stream crosses a digit-length
 * boundary (9, then 10) is mis-ordered from then on. Qualifying the sort key with
 * the table pins it to the input `bigint`; the integration suite pins the same
 * boundary with a stream seeded across it.
 *
 * ## Appending is the only direct write
 *
 * `add` names only the four columns a client may supply (`society_id`, `expense_id`,
 * `author_id`, `body`); `id`, `sequence` and the timestamps are the database's.
 * There is no `UPDATE` and no `DELETE` statement anywhere in this adapter (D1/D8):
 * the tombstone is `expense_comment_soft_delete()`, a definer function that owns
 * the author-or-Admin rule and the metadata-forging guard. This adapter classifies
 * its refusals; it does not re-implement its rules.
 *
 * ## Visibility is the database's
 *
 * Every statement runs inside `UnitOfWork` as the caller, so the
 * `expense_comments_select_member` policy decides which rows exist: a member of the
 * society reads the stream, a Guest reads nothing, and another tenant's rows are
 * structurally absent. Every failure is classified by `expense.rows.ts`.
 */
@Injectable()
export class ExpenseCommentRepositoryPostgres implements ExpenseCommentRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /** Every comment the caller may see, oldest first, tombstones included. */
  async listForExpense(
    expenseId: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly ExpenseCommentRecord[]> {
    return this.run(actor, "read", async (tx) => {
      const rows = await runQuery(
        tx,
        sql`
          select ${EXPENSE_COMMENT_COLUMNS}
            from public.expense_comments
           where expense_id = ${expenseId}::uuid
             and society_id = ${societyId}::uuid
           order by public.expense_comments.sequence asc
        `,
      );
      return rows.map((row) => parseCommentRow(row));
    });
  }

  /** One comment of one expense, or `null`. */
  async findById(
    commentId: ExpenseCommentId,
    expenseId: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<ExpenseCommentRecord | null> {
    return this.run(actor, "read", async (tx) => {
      const rows = await runQuery(
        tx,
        sql`
          select ${EXPENSE_COMMENT_COLUMNS}
            from public.expense_comments
           where id = ${commentId}::uuid
             and expense_id = ${expenseId}::uuid
             and society_id = ${societyId}::uuid
           limit 1
        `,
      );
      const [row] = rows;
      return row === undefined ? null : parseCommentRow(row);
    });
  }

  /** Append one comment; the database assigns `id` and `sequence`. */
  async add(
    draft: ExpenseCommentDraft,
    actor: UserId,
  ): Promise<ExpenseCommentRecord> {
    return this.run(actor, "write", async (tx) => {
      const rows = await runQuery(
        tx,
        sql`
          insert into public.expense_comments (
            society_id, expense_id, author_id, body
          )
          values (
            ${draft.societyId}::uuid,
            ${draft.expenseId}::uuid,
            ${draft.authorId}::uuid,
            ${draft.body}::text
          )
          returning ${EXPENSE_COMMENT_COLUMNS}
        `,
      );
      return parseSingleCommentRow(rows);
    });
  }

  /** Tombstone one comment through the definer function — author or Admin only. */
  async softDelete(
    commentId: ExpenseCommentId,
    expenseId: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<ExpenseCommentRecord> {
    return this.run(actor, "write", async (tx) => {
      const rows = await runQuery(
        tx,
        sql`
          select ${EXPENSE_COMMENT_COLUMNS}
            from public.expense_comment_soft_delete(
              ${commentId}::uuid,
              ${expenseId}::uuid,
              ${societyId}::uuid
            )
        `,
      );
      return parseSingleCommentRow(rows);
    });
  }

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

const EXPENSE_COMMENT_COLUMNS = sql.raw(
  EXPENSE_COMMENT_COLUMN_EXPRESSIONS.join(", "),
);

function parseCommentRow(row: Row): ExpenseCommentRecord {
  const parsed = expenseCommentRowSchema.safeParse(row);
  if (!parsed.success) {
    throw unexpectedShapeError("expense comment");
  }
  return commentFromRow(parsed.data);
}

function parseSingleCommentRow(rows: readonly Row[]): ExpenseCommentRecord {
  const [row] = rows;
  if (row === undefined) {
    throw unexpectedShapeError("expense comment");
  }
  return parseCommentRow(row);
}
