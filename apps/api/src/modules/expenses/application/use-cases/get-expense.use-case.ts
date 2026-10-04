import { Inject, Injectable } from "@nestjs/common";
import { asExpenseError, expenseError } from "@ses/domain";
import type {
  ExpenseId,
  ExpenseRecord,
  ExpenseRepository,
  SocietyId,
  UserId,
} from "@ses/domain";

import { toAppError } from "../expense-category-error.mapper";
import { EXPENSE_REPOSITORY } from "../expense.tokens";
import { EXPENSE_NOT_FOUND } from "./expense-draft.support";

/**
 * Read one expense — Roadmap T065's `get-expense`.
 *
 * The read half of the draft lifecycle: a member of the society sees any of its
 * expenses, draft or not, which is PRD §2.2's "Residents see everything by default"
 * and the module's transparency principle — the draft state is not a secrecy state.
 * The route declares `expense.view`, a green cell for every role but Guest, so there
 * is no resource narrowing here and no `NARROWED_ROUTES` entry: the only question
 * the matrix can ask about a read is the tenant one, and the `society_id` predicate
 * plus RLS answer it.
 *
 * A cross-society or absent id is `not_found`, never `forbidden` (PRD T041): the
 * repository's read is scoped by both ids under the caller's RLS identity, so the
 * two cases are structurally the same row-invisibility.
 */
@Injectable()
export class GetExpenseUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY)
    private readonly expenses: ExpenseRepository,
  ) {}

  async get(
    actor: UserId,
    societyId: SocietyId,
    expenseId: ExpenseId,
  ): Promise<ExpenseRecord> {
    let record: ExpenseRecord | null;
    try {
      record = await this.expenses.findById(expenseId, societyId, actor);
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }

    if (record === null) {
      throw toAppError(expenseError("not_found", EXPENSE_NOT_FOUND));
    }
    return record;
  }
}
