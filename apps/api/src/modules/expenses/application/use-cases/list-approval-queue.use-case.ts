import { Inject, Injectable } from "@nestjs/common";
import { asExpenseError } from "@ses/domain";
import type {
  ExpensePage,
  ExpenseRepository,
  SocietyId,
  UserId,
} from "@ses/domain";

import { toAppError } from "../expense-category-error.mapper";
import { EXPENSE_REPOSITORY } from "../expense.tokens";
import {
  buildExpenseListQuery,
  toExpenseListResult,
} from "./expense-draft.support";
import type {
  ExpenseListRequest,
  ExpenseListResultPage,
} from "./expense-draft.support";

/**
 * The approval queue — Roadmap T070's `list-approval-queue`, ADR-0011 D7.
 *
 * ## The queue is a filter, not an address
 *
 * The product decision explicitly authorizes **no** `/approval-queue` route: the
 * queue is `GET /v1/expenses?status=pending_approval`, and this use case is what
 * serves that view. `ListExpensesUseCase` delegates its `pending_approval` branch
 * here, so the queue's definition lives in one file and the general listing keeps
 * working unchanged. Nothing about the wire changes: the same `expenseListResponse`
 * envelope, the same base64 cursor, the same `expenseSchema` entries.
 *
 * ## The facts the Roadmap asks for are already on the DTO
 *
 * "Approval queue listed with the requester, amount and age" needs three things, and
 * every one of them is a field `expenseSchema` already carries — so no second,
 * queue-shaped DTO is invented (which would be a fourth model of an expense and a
 * fourth place for a rename to go stale):
 *
 * | Roadmap | DTO field | Notes |
 * | --- | --- | --- |
 * | requester | `createdBy` | the membership that raised the expense |
 * | amount | `amountPaise` | integer paise, range-checked at the boundary |
 * | age | `createdAt` | ISO instant; "age" is `now - createdAt` and is deliberately *not* stored, because a stored age is wrong one second later |
 *
 * The entry also carries `approvedBy`/`approvedAt`, so an Admin can see at a glance
 * which entries of the queue have already been decided — the queue is a work list,
 * not only a to-do list.
 *
 * ## Ordering and the status filter
 *
 * The repository's own ordering (`expense_date DESC, id DESC`) and the shared
 * `buildExpenseListQuery` are reused, and the status is **forced** rather than
 * defaulted: a caller cannot ask the queue for drafts, which is what makes "the
 * queue shows everything awaiting a decision" a property of the code instead of of
 * the client. Every other filter still applies (category, dates, amounts, creator,
 * `q`), so an Admin can narrow the queue with the same parameters the list has.
 *
 * ## Why it does not check a permission
 *
 * Reading expenses is `expense.view` — every role but Guest — and the route declares
 * it, exactly as the general listing does. The *decisions* the queue exists for are
 * Admin-only, and that is enforced on the approve/reject routes, in the domain's
 * permission matrix, and again inside the two definer functions: a Treasurer who
 * opens the queue sees the work and cannot act on it, which is the product's design
 * (ADR-0011 D5) rather than a leak.
 */
@Injectable()
export class ListApprovalQueueUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY)
    private readonly expenses: ExpenseRepository,
  ) {}

  /** One page of `pending_approval` expenses, newest first, with its cursor. */
  async list(
    actor: UserId,
    societyId: SocietyId,
    request: ExpenseListRequest,
  ): Promise<ExpenseListResultPage> {
    // Built outside the repository's `try`, for the reason `ListExpensesUseCase`
    // records: a malformed cursor refuses as a `validation` `AppError`, and the
    // catch is the domain-vocabulary seam — it must not see an already-mapped one.
    const query = buildExpenseListQuery(request, "pending_approval");

    let page: ExpensePage;
    try {
      page = await this.expenses.list(societyId, query, actor);
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }

    return toExpenseListResult(page);
  }
}
