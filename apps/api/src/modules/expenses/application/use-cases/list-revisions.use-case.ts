import { Inject, Injectable } from "@nestjs/common";
import { asExpenseError } from "@ses/domain";
import type {
  ExpenseId,
  ExpenseRevisionRecord,
  ExpenseRevisionRepository,
  ExpenseRepository,
  SocietyId,
  UserId,
} from "@ses/domain";

import { toAppError } from "../expense-category-error.mapper";
import {
  EXPENSE_REPOSITORY,
  EXPENSE_REVISION_REPOSITORY,
} from "../expense.tokens";
import { loadExpenseOrNotFound } from "./expense-draft.support";

/**
 * The revision history of one expense — Roadmap T068, PRD §3.5.3's "edited" chip and
 * its tap-through.
 *
 * ## Why the expense is loaded before its history
 *
 * The revisions are addressed by the expense, so a caller that cannot see the expense
 * must not be able to enumerate its history: this loads the expense first through
 * T065's `loadExpenseOrNotFound`, which answers `not_found` for an unknown or
 * cross-society id under the caller's own RLS identity (PRD T041). Only then is the
 * history read — and the read carries the same `society_id` predicate and runs under
 * the same identity, so the two answers cannot disagree about which tenant the caller
 * is in.
 *
 * ## Why there is no `canOnResource` narrowing here
 *
 * `expense.view` is a green cell for every role but Guest, and the matrix's only
 * question about a read is the tenant one. A loaded-so-far published expense has no
 * conditional cell either: T068 grants the history to the same members the expense
 * itself is visible to, which is what makes the "edited" chip and its tap-through a
 * transparency feature rather than an officer-only audit log.
 *
 * ## The shape of the answer
 *
 * Oldest first (`version` ascending), one entry per successful revision, each carrying
 * the **pre-edit** version and the BEFORE snapshot the database captured — see
 * `ExpenseRevisionRecord`. An expense that has never been revised answers an empty
 * list rather than a 404: it has a history, and that history is empty.
 */
@Injectable()
export class ListRevisionsUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY)
    private readonly expenses: ExpenseRepository,
    @Inject(EXPENSE_REVISION_REPOSITORY)
    private readonly revisions: ExpenseRevisionRepository,
  ) {}

  async list(
    actor: UserId,
    societyId: SocietyId,
    expenseId: ExpenseId,
  ): Promise<readonly ExpenseRevisionRecord[]> {
    // The visibility gate: an invisible expense has an invisible history.
    await loadExpenseOrNotFound(this.expenses, actor, societyId, expenseId);

    try {
      return await this.revisions.listForExpense(expenseId, societyId, actor);
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }
  }
}
