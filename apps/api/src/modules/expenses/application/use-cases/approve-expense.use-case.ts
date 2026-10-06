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
  ExpenseRecord,
  ExpenseRepository,
  SocietyId,
  UserId,
} from "@ses/domain";

import { MEMBERSHIP_READER } from "../../../../common/authorization/membership-reader";
import { toAppError } from "../expense-category-error.mapper";
import { EXPENSE_REPOSITORY } from "../expense.tokens";
import {
  loadExpenseOrNotFound,
  loadMembershipOrNotFound,
  snapshotOf,
} from "./expense-draft.support";

/**
 * Approve an expense that is waiting for a decision — Roadmap T070, ADR-0011.
 *
 * ## The steps, in the order that decides error precedence
 *
 * ```text
 * approve(actor, societyId, expenseId, { expectedVersion })
 *   ├─ membership, then the persisted expense          (not_found for foreign ids)
 *   ├─ canOnResource("expense.approve", stored row)    (Admin only — a full cell)
 *   ├─ status is pending_approval? and expectedVersion? (the fast refusals)
 *   └─ ExpenseRepository.approve(...)                  (one transaction)
 * ```
 *
 * The order mirrors the definer function's own (membership → capability → row lock →
 * status → version → not-already-approved → stamps): this layer's checks are the
 * cheap refusals, and `expense_approve()` re-checks every one of them under the row
 * lock, which is what makes two concurrent approvals serialise instead of racing.
 *
 * ## Approval is not publication (ADR-0011)
 *
 * Nothing financial happens here. The expense stays `pending_approval`, no split is
 * priced, no due is created, no balance moves, and no `expense.published` event is
 * raised — publication is T066's transaction, reached by `POST /publish`, which
 * re-reads the row and re-evaluates the amount against the **current** threshold.
 * Approving is the Admin's *decision*; publishing is a separate, separately
 * authorised act. That separation is what makes "an approved expense can publish"
 * and "an unapproved high-value expense cannot" two independent facts.
 *
 * ## Who may approve, and who may approve their own
 *
 * `expense.approve` is a **full** Admin cell (PRD §2.1), so a Treasurer, a Committee
 * Member, a Resident, a Tenant and a Guest are each refused — by role, not by a
 * self-approval rule. An Admin **may** approve their own expense: a single-Admin
 * society must not be able to deadlock its own high-value expenses (ADR-0011 D5),
 * and there is deliberately no `approved_by != created_by` check anywhere in this
 * path or in the database.
 *
 * ## No event
 *
 * The domain's event catalogue is closed (ADR-0011 D6) and the transport it would
 * need does not exist yet: creator notification is formally deferred to Phase 6 /
 * T107. The durable record of the decision is the row's
 * `approved_by`/`approved_at`/`version`, which the later notification and audit
 * design reads.
 *
 * ## No idempotency record
 *
 * An approval is not a money-moving POST (SAD §7.7), and a second attempt is a
 * refusal rather than a replay: with a stale version the definer function answers
 * `EXPENSE_VERSION_MISMATCH`, and with a fresh one it answers
 * `EXPENSE_ALREADY_APPROVED` — both `409`, neither a quiet success. A client that
 * lost the response re-reads the expense, which the bumped version makes
 * unambiguous.
 */
@Injectable()
export class ApproveExpenseUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY)
    private readonly expenses: ExpenseRepository,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: ExpenseMembershipReader,
  ) {}

  /** Approves one expense awaiting a decision, or refuses with the reason. */
  async approve(
    actor: UserId,
    societyId: SocietyId,
    expenseId: ExpenseId,
    command: ApproveExpenseCommand,
  ): Promise<ExpenseRecord> {
    // 1 · The subject. No membership and a removed one are one answer (`not_found`,
    //     PRD T041); a `pending` membership is left to the resource decision.
    const membership = await loadMembershipOrNotFound(
      this.memberships,
      actor,
      societyId,
    );

    // 2 · The persisted row — society, status, version and creator all come from
    //     it, never from the caller. A cross-society id is absent, not forbidden
    //     (PRD T041), so an otherwise-authorized Admin of another society gets 404.
    const record = await loadExpenseOrNotFound(
      this.expenses,
      actor,
      societyId,
      expenseId,
    );

    // 3 · The resource decision. `expense.approve` is a full Admin cell, so the
    //     snapshot's facts never narrow it — they are passed for the same reason
    //     every other call site passes them: the decision function is the one place
    //     a role becomes a permission. A Treasurer is refused here, before a write.
    const allowed = canOnResource(
      memberSnapshotOf(membership),
      "expense.approve",
      snapshotOf(record),
    );
    if (!allowed) {
      throw toAppError(expenseError("forbidden", APPROVE_FORBIDDEN));
    }

    // 4 · The lifecycle and the lock, checked here so a hopeless request costs no
    //     more than one read. Both are re-checked under the row lock inside
    //     `expense_approve()`: this is the fast refusal, the database's is the one
    //     that cannot be raced.
    if (record.status !== "pending_approval") {
      throw toAppError(
        expenseError(
          "invalid_transition",
          "Only an expense awaiting approval can be approved.",
          { from: record.status, to: "approved" },
        ),
      );
    }
    if (record.version !== command.expectedVersion) {
      throw toAppError(
        expenseError(
          "version_mismatch",
          "This expense was changed by someone else. Reload it and try again.",
          {
            field: "expectedVersion",
            expectedVersion: command.expectedVersion,
            currentVersion: record.version,
          },
        ),
      );
    }

    // 5 · The decision, atomically, through the one definer transaction that can
    //     write the approval stamps (they are not in the client UPDATE grant, which
    //     is what stops a client from forging an approval).
    try {
      return await this.expenses.approve(
        expenseId,
        societyId,
        { expectedVersion: command.expectedVersion },
        actor,
      );
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }
  }
}

/** What the route hands the use case — the contract has already parsed it. */
export interface ApproveExpenseCommand {
  /** The version the caller read; required, because a lock that can be omitted is not one. */
  readonly expectedVersion: number;
}

/** One wording, so the refusal cannot drift between the route and this file. */
export const APPROVE_FORBIDDEN = "Only a society Admin can approve an expense.";
