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
import { ListApprovalQueueUseCase } from "./list-approval-queue.use-case";

/**
 * List a society's expenses — Roadmap T065's endpoint, SAD §7.4/§7.5.
 *
 * ## One query, one page, one cursor
 *
 * The repository performs a single filtered statement; the query is assembled by
 * `buildExpenseListQuery` (shared with the approval queue, so a filter cannot mean
 * two things) and the page is translated by `toExpenseListResult`, which re-encodes
 * the sort tuple as the opaque cursor. No count query: SAD §7.4 makes `total`
 * optional and it is only cheap from a cache this module does not have.
 *
 * ## Filters are the SAD's, minus the three the schema cannot answer
 *
 * `categoryId`, `status`, `dateFrom`/`dateTo`, `amountPaiseMin`/`amountPaiseMax`,
 * `createdBy` and `q` are implemented. `buildingId`, `hasAttachments` and `cycleId`
 * are refused by the contract's strict schema rather than silently ignored — the
 * columns and tables behind them do not exist yet (T060 withheld `cycle_id`;
 * attachments are T071; the PRD's building scope lives inside `participant_selector`),
 * and a filter that quietly matches everything is worse than one that says it is not
 * there. The gap is recorded in T065's report.
 *
 * ## `status=pending_approval` is the approval queue, and it is served by the queue
 *
 * T070 adds no queue endpoint (ADR-0011 D7): the queue **is** this listing filtered
 * to `pending_approval`, so that one filter value is delegated to
 * `ListApprovalQueueUseCase`. The delegation is here rather than in the controller
 * because it is a statement about *what the two views are* — the controller still
 * calls one method and maps one result, and the queue's own file is the single place
 * its facts (requester, amount, age) are documented.
 */
@Injectable()
export class ListExpensesUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY)
    private readonly expenses: ExpenseRepository,
    private readonly approvalQueue: ListApprovalQueueUseCase,
  ) {}

  async list(
    actor: UserId,
    societyId: SocietyId,
    command: ExpenseListRequest,
  ): Promise<ExpenseListResultPage> {
    if (command.status === "pending_approval") {
      return this.approvalQueue.list(actor, societyId, command);
    }

    // The query is built **outside** the repository's `try`: assembling it can
    // refuse on its own (a malformed cursor is a `validation` `AppError`), and the
    // catch below is the domain-vocabulary seam — feeding an already-mapped
    // `AppError` through it would turn a 422 into a 500.
    const query = buildExpenseListQuery(command);

    let page: ExpensePage;
    try {
      page = await this.expenses.list(societyId, query, actor);
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }

    return toExpenseListResult(page);
  }
}

/** What the route hands the use case — already parsed by the contract schema. */
export type ListExpensesCommand = ExpenseListRequest;

/** The page plus its wire cursor. */
export type ExpenseListResult = ExpenseListResultPage;

// Re-exported from the shared support module so the names this use case has always
// published (the cursor codec, the page-size floor) keep resolving for callers and
// tests that import them from here, while the definitions live in one place.
export {
  DEFAULT_EXPENSE_PAGE_SIZE,
  MAX_EXPENSE_PAGE_SIZE,
  decodeExpenseCursor,
  encodeExpenseCursor,
} from "./expense-draft.support";
