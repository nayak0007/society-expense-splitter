import { Inject, Injectable } from "@nestjs/common";
import { asExpenseError, expenseError } from "@ses/domain";
import type {
  ExpenseId,
  ExpenseRepository,
  ExpenseSplitRecord,
  ExpenseSplitsReader,
  SocietyId,
  UserId,
} from "@ses/domain";

import { toAppError } from "../expense-category-error.mapper";
import { EXPENSE_REPOSITORY, EXPENSE_SPLITS_READER } from "../expense.tokens";
import { EXPENSE_NOT_FOUND } from "./expense-draft.support";

/**
 * The current split table of one expense — Roadmap T073, PRD §3.5.3.
 *
 * ## Why this is a read of persisted rows and not a calculation
 *
 * The rows returned are the `expense_splits` the publish/recalculation path wrote, read
 * verbatim. Two shortcuts are explicitly rejected:
 *
 *  - **recomputing from the participant selector** would call the split engine a second
 *    time on the read path, and a bill whose displayed table disagreed with what was
 *    charged is the Sev-1 the split engine's own docstring names;
 *  - **reading `expense_revisions.snapshot`** would show *history* — a prior version's
 *    splits — as if it were the current allocation.
 *
 * A `draft` or `pending_approval` expense has no split rows, so the answer is an empty
 * list: the bill has not been allocated yet, which is a fact rather than an error.
 *
 * ## Authorization is the expense's own read
 *
 * The route declares `expense.view` (every role but Guest), so there is no resource
 * narrowing to perform — the only question the matrix can ask about this read is the
 * tenant one. Loading the expense first is what makes a cross-society or unknown id a
 * `not_found` (404), identical to `GET /expenses/:expenseId` (PRD T041: a caller cannot
 * tell a foreign society's expense from an absent one). Only then are the splits read,
 * under the same caller identity and RLS. No financial row is written anywhere on this
 * path.
 */
@Injectable()
export class ListSplitsUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY)
    private readonly expenses: ExpenseRepository,
    @Inject(EXPENSE_SPLITS_READER)
    private readonly splits: ExpenseSplitsReader,
  ) {}

  async list(
    actor: UserId,
    societyId: SocietyId,
    expenseId: ExpenseId,
  ): Promise<readonly ExpenseSplitRecord[]> {
    let expense: Awaited<ReturnType<ExpenseRepository["findById"]>>;
    try {
      expense = await this.expenses.findById(expenseId, societyId, actor);
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }

    if (expense === null) {
      throw toAppError(expenseError("not_found", EXPENSE_NOT_FOUND));
    }

    try {
      return await this.splits.listForExpense(expenseId, societyId, actor);
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }
  }
}
