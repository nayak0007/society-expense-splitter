import { Inject, Injectable } from "@nestjs/common";
import {
  asExpenseError,
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
 * The comment stream of one expense, oldest first — Roadmap T072, PRD §3.5.3.
 *
 * The expense is loaded first so a cross-society or unknown id answers 404 rather
 * than an empty stream: an empty stream would be indistinguishable from "the
 * expense exists and nobody has commented", and telling those apart would let a
 * caller probe another tenant (PRD T041). Once the expense is visible, the
 * database's `expense_comments_select_member` policy decides which comments exist —
 * this use case re-checks no row.
 *
 * Soft-deleted comments are returned with their position and their deletion
 * metadata; the mapper, not this use case, decides that their body is not
 * published.
 */
@Injectable()
export class ListCommentsUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY)
    private readonly expenses: ExpenseRepository,
    @Inject(EXPENSE_COMMENT_REPOSITORY)
    private readonly comments: ExpenseCommentRepository,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: ExpenseMembershipReader,
  ) {}

  async list(
    actor: UserId,
    societyId: SocietyId,
    expenseId: ExpenseId,
  ): Promise<readonly ExpenseCommentRecord[]> {
    await loadMembershipOrNotFound(this.memberships, actor, societyId);
    await loadExpenseOrNotFound(this.expenses, actor, societyId, expenseId);

    try {
      return await this.comments.listForExpense(expenseId, societyId, actor);
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }
  }
}
