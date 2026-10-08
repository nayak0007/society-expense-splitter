import { Inject, Injectable } from "@nestjs/common";
import {
  asExpenseError,
  type ExpenseCommentRecord,
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
import type { ExpenseCommentRepository } from "@ses/domain";
import {
  loadExpenseOrNotFound,
  loadMembershipOrNotFound,
} from "./expense-draft.support";

/**
 * Append one comment to an expense — Roadmap T072, PRD §3.5.3 "Notes", decision D2.
 *
 * ## Authorization is the guard's, and the attribution is the caller's own
 *
 * The route declares `expense.view` (every role but Guest), so a Guest is refused
 * before the handler runs and every member who can see the expense can speak. The
 * use case does not re-check the role: it loads the membership (404 for a
 * non-member, PRD T041) and the expense (404 for a foreign id), then writes
 * **the caller's own membership id** as the author. Accepting an author from the
 * request would be accepting an attribution decision from the client, which is why
 * the command carries only a body.
 *
 * ## No optimistic lock
 *
 * The stream is commutative: two members commenting at once append two rows, and
 * the database assigns each a distinct `sequence`. There is nothing here to
 * conflict, so the command has no `expectedVersion` — an append is not a versioned
 * edit.
 */
@Injectable()
export class AddCommentUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY)
    private readonly expenses: ExpenseRepository,
    @Inject(EXPENSE_COMMENT_REPOSITORY)
    private readonly comments: ExpenseCommentRepository,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: ExpenseMembershipReader,
  ) {}

  async add(
    actor: UserId,
    societyId: SocietyId,
    expenseId: ExpenseId,
    command: AddCommentCommand,
  ): Promise<ExpenseCommentRecord> {
    const membership = await loadMembershipOrNotFound(
      this.memberships,
      actor,
      societyId,
    );

    // Loads the expense so a cross-society or unknown id answers 404 rather than
    // creating a comment against a row the caller cannot see.
    await loadExpenseOrNotFound(this.expenses, actor, societyId, expenseId);

    try {
      return await this.comments.add(
        {
          expenseId,
          societyId,
          authorId: membership.id,
          body: command.body,
        },
        actor,
      );
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }
  }
}

/** The route's validated body — the comment text and nothing else. */
export interface AddCommentCommand {
  readonly body: string;
}
