import { Inject, Injectable } from "@nestjs/common";
import {
  asExpenseError,
  can,
  expenseError,
  isCommentAuthor,
  type ExpenseCommentId,
  type ExpenseCommentRecord,
  type ExpenseCommentRepository,
  type ExpenseId,
  type ExpenseMembershipReader,
  type ExpenseRepository,
  type SocietyId,
  type UserId,
} from "@ses/domain";

import { MEMBERSHIP_READER } from "../../../../common/authorization/membership-reader";
import { toAppError } from "../expense-category-error.mapper";
import {
  EXPENSE_COMMENT_REPOSITORY,
  EXPENSE_REPOSITORY,
} from "../expense.tokens";
import {
  loadExpenseOrNotFound,
  loadMembershipOrNotFound,
} from "./expense-draft.support";

/**
 * Soft-delete one comment — Roadmap T072, PRD §3.5.3, decision D2/D8.
 *
 * ## Two gates, and both must agree with the database
 *
 * The caller must be **the comment's author**, or must hold the Admin-only
 * `expense.approve` capability. That capability is resolved through the permission
 * evaluator (`can(role, "expense.approve")`), never an inline `role === "admin"`
 * string and never `expense.void` — the matrix decides, and the matrix says
 * approval is Admin-only. The database's `expense_comment_soft_delete()` enforces
 * the same two facts; the check here exists so the refusal is the module's typed
 * `forbidden` rather than a raw SQLSTATE, in the same spirit as the draft-delete
 * path's creator check.
 *
 * ## Soft, not hard (D8)
 *
 * The write is the definer function and nothing else. It stamps `deleted_at` and
 * `deleted_by` and leaves the row in the stream; there is no SQL `DELETE` anywhere
 * on this path, and the table grants none. A second delete is idempotent — the
 * function returns the already-tombstoned row unchanged rather than moving the
 * timestamp.
 *
 * ## Why the comment and the expense are both read
 *
 * The expense is loaded for the same 404-not-403 reason every expense route is.
 * The comment is loaded because the author-or-Admin decision needs its `author_id`,
 * and doing that check in the application — against the caller's own membership —
 * is what makes the rule visible here rather than only in SQL.
 */
@Injectable()
export class DeleteCommentUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY)
    private readonly expenses: ExpenseRepository,
    @Inject(EXPENSE_COMMENT_REPOSITORY)
    private readonly comments: ExpenseCommentRepository,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: ExpenseMembershipReader,
  ) {}

  async softDelete(
    actor: UserId,
    societyId: SocietyId,
    expenseId: ExpenseId,
    commentId: ExpenseCommentId,
  ): Promise<ExpenseCommentRecord> {
    const membership = await loadMembershipOrNotFound(
      this.memberships,
      actor,
      societyId,
    );
    await loadExpenseOrNotFound(this.expenses, actor, societyId, expenseId);

    let comment: ExpenseCommentRecord | null;
    try {
      comment = await this.comments.findById(
        commentId,
        expenseId,
        societyId,
        actor,
      );
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }

    if (comment === null) {
      throw toAppError(expenseError("not_found", COMMENT_NOT_FOUND));
    }

    const mayDelete =
      isCommentAuthor(comment, membership.id) ||
      can(membership.role, "expense.approve");
    if (!mayDelete) {
      throw toAppError(expenseError("forbidden", DELETE_COMMENT_FORBIDDEN));
    }

    try {
      return await this.comments.softDelete(
        commentId,
        expenseId,
        societyId,
        actor,
      );
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }
  }
}

/** No such comment, and one the caller may not see, are one answer (PRD T041). */
export const COMMENT_NOT_FOUND = "That comment is not available to you.";

/** The refusal a member who is neither the author nor an Admin reads. */
export const DELETE_COMMENT_FORBIDDEN =
  "Only the comment's author or a society Admin can delete it.";
