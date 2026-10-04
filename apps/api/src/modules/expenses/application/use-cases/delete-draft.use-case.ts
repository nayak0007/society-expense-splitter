import { Inject, Injectable } from "@nestjs/common";
import {
  asExpenseError,
  canOnResource,
  expenseError,
  memberSnapshotOf,
} from "@ses/domain";
import type {
  ExpenseId,
  ExpenseMembershipReader,
  ExpenseRepository,
  SocietyId,
  UserId,
} from "@ses/domain";

import { MEMBERSHIP_READER } from "../../../../common/authorization/membership-reader";
import { toAppError } from "../expense-category-error.mapper";
import { EXPENSE_REPOSITORY } from "../expense.tokens";
import {
  DELETE_FORBIDDEN,
  loadExpenseOrNotFound,
  loadMembershipOrNotFound,
  snapshotOf,
} from "./expense-draft.support";

/**
 * Hard-delete a draft — Roadmap T065, PRD §3.5's one delete.
 *
 * ## Creator only, and that is narrower than the matrix's ✅ cell on purpose
 *
 * The Roadmap's acceptance is "Drafts hard-deletable by their creator only" — not
 * "by their creator or a manager". A Treasurer who could delete somebody's draft
 * would erase their work rather than refuse it, and the PRD's own sentence names the
 * creator. So the flow is two gates: `canOnResource("expense.void", snapshot)` — the
 * 🟡 narrowing site the route inventory requires, which already refuses a Committee
 * Member another member's draft — and then an explicit `createdBy === membership.id`
 * check that narrows Admin and Treasurer too. The definer function enforces the same
 * thing inside the database; this layer's version exists to answer with a typed
 * refusal rather than a SQLSTATE.
 *
 * ## Hard, not soft
 *
 * There is no void event, no tombstone and no `deleted_at`: `expenses` has no such
 * columns (SAD §8.1's "never deleted — voided instead" tier), `DELETE` is not
 * granted, and the one path is `expense_draft_delete()` (migration
 * `20261004120000`), which locks the row and checks creator, draft-ness and the
 * absence of splits before removing it. A published expense is refused with
 * `invalid_transition` — its door is T069's void.
 */
@Injectable()
export class DeleteDraftUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY)
    private readonly expenses: ExpenseRepository,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: ExpenseMembershipReader,
  ) {}

  async delete(
    actor: UserId,
    societyId: SocietyId,
    expenseId: ExpenseId,
  ): Promise<void> {
    const membership = await loadMembershipOrNotFound(
      this.memberships,
      actor,
      societyId,
    );

    const record = await loadExpenseOrNotFound(
      this.expenses,
      actor,
      societyId,
      expenseId,
    );

    const allowed = canOnResource(
      memberSnapshotOf(membership),
      "expense.void",
      snapshotOf(record),
    );
    if (!allowed || record.createdBy !== membership.id) {
      throw toAppError(expenseError("forbidden", DELETE_FORBIDDEN));
    }

    if (record.status !== "draft") {
      throw toAppError(
        expenseError(
          "invalid_transition",
          "Only a draft can be deleted. A published expense is voided instead.",
          { from: record.status },
        ),
      );
    }

    try {
      await this.expenses.deleteDraft(record.id, societyId, actor);
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }
  }
}
