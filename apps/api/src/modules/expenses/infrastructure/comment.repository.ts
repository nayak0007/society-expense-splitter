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
  type AuditFlush,
  type TransactionActor,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import { AuditService } from "../../audit/audit.service";
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
 *
 * ## The two writes record audits, and the body is deliberately not among them (T050 Stage D)
 *
 * `add` and `softDelete` are the only mutations here, and each hands one entry to
 * `UnitOfWork`'s audit seam so it commits with the row it describes (ADR-0014 D1). The
 * entry carries the comment's **metadata** — its id, its author, its position in the
 * stream and the length of its text — and never the text itself: PRD §3.5.3 gives a
 * comment no retention or discoverability rule that would need its content in the audit
 * trail, and copying a member's words into a second, append-only table that no delete can
 * reach is a disclosure the narrowest reading does not require. The author and the
 * expense are recorded, so the two questions a dispute asks ("who spoke, and where")
 * are answered without reproducing what was said.
 *
 * ## A tombstone replay writes nothing
 *
 * `expense_comment_soft_delete()` is idempotent by design: a second call returns the
 * already-tombstoned row unchanged. That is a *no-op*, not a second deletion, so the
 * `before` captured in the transaction decides whether an entry is flushed — an already
 * tombstoned row produces none (ADR-0014 D4's "one transition, one record"). The row's
 * own state is the test rather than the call count, because the call count is not
 * knowable from inside the transaction.
 */
@Injectable()
export class ExpenseCommentRepositoryPostgres implements ExpenseCommentRepository {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    // T050 Stage D: builds the audit rows the writer persists, via the transaction seam.
    private readonly audit: AuditService,
  ) {}

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
    return this.run(
      actor,
      "write",
      async (tx) => {
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
      },
      // `category: "other"`: a comment is discussion, not financial state, so it stays out
      // of the half a Treasurer's `audit.view` narrows to (PRD §2.1).
      (added) => [
        this.audit.entry({
          societyId: draft.societyId,
          category: "other",
          action: "expense.comment_added",
          entityType: "expense_comment",
          entityId: added.id,
          before: null,
          after: commentAuditSnapshot(added),
          metadata: { expenseId: draft.expenseId },
        }),
      ],
    );
  }

  /** Tombstone one comment through the definer function — author or Admin only. */
  async softDelete(
    commentId: ExpenseCommentId,
    expenseId: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<ExpenseCommentRecord> {
    // The pre-tombstone state, read inside the transaction that tombstones (T050 Stage
    // D). It is also the replay test: the function returns an already-tombstoned row
    // unchanged, and a row that was already deleted is not a second transition.
    let before: Record<string, unknown> | null = null;
    let wasLive = false;

    return this.run(
      actor,
      "write",
      async (tx) => {
        const current = await runQuery(
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
        const [existing] = current;
        if (existing !== undefined) {
          const parsed = parseCommentRow(existing);
          before = commentAuditSnapshot(parsed);
          wasLive = parsed.deletedAt === null;
        }

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
      },
      // A replay of an already-tombstoned comment is a no-op, not a transition, so it
      // flushes nothing (ADR-0014 D4). A refusal never reaches here at all: the definer
      // function raises before `work` returns.
      (deleted) =>
        wasLive
          ? [
              this.audit.entry({
                societyId,
                category: "other",
                action: "expense.comment_deleted",
                entityType: "expense_comment",
                entityId: deleted.id,
                before,
                after: { deletedAt: true },
                metadata: { expenseId },
              }),
            ]
          : [],
    );
  }

  private async run<T>(
    actor: UserId,
    context: "read" | "write",
    work: (tx: TransactionContext) => Promise<T>,
    /** The audit scope and entries — omitted by every read (T050 Stage D). */
    audit?: AuditFlush<T>,
  ): Promise<T> {
    const identity: TransactionActor = { kind: "user", userId: actor };
    try {
      return await this.unitOfWork.transaction(identity, work, audit);
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

/**
 * The comment facts an audit entry records (T050 Stage D) — and the body is not one.
 *
 * A comment's *content* carries no retention or discoverability rule in the PRD, so the
 * entry records that a comment exists, who wrote it, where it sits in the stream and how
 * long it was — enough to answer "who spoke on this expense, and when", without copying a
 * member's words into an append-only table no delete can reach. See the class note.
 */
function commentAuditSnapshot(
  comment: ExpenseCommentRecord,
): Record<string, unknown> {
  return {
    authorId: comment.authorId,
    sequence: comment.sequence,
    bodyLength: comment.body.length,
    createdAt: comment.createdAt,
  };
}

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
