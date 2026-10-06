import { Inject, Injectable } from "@nestjs/common";
import {
  asExpenseError,
  canOnResource,
  createExpenseRejectionReason,
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
  unwrap,
} from "./expense-draft.support";

/**
 * Reject an expense that is waiting for a decision — Roadmap T070, ADR-0011.
 *
 * ## The steps, in the order that decides error precedence
 *
 * ```text
 * reject(actor, societyId, expenseId, { expectedVersion, reason })
 *   ├─ membership, then the persisted expense          (not_found for foreign ids)
 *   ├─ canOnResource("expense.approve", stored row)    (Admin only — a full cell)
 *   ├─ status is pending_approval? and expectedVersion? (the fast refusals)
 *   ├─ createExpenseRejectionReason(reason)            (the domain's own rule)
 *   └─ ExpenseRepository.reject(...)                   (one transaction)
 * ```
 *
 * The order is deliberately the **database's** order, not the entity's: the definer
 * function checks membership → capability → row lock → lifecycle → version → reason,
 * so `createExpenseRejectionReason` runs *after* the lifecycle and lock pre-checks
 * here as well — exactly as `VoidExpenseUseCase` orders `createVoidReason`. A second
 * rejection carrying a ten-character reason and a second rejection carrying a
 * five-character one both answer `invalid_transition`, which is the truth about the
 * expense; only a row still awaiting approval can be wrong about its reason.
 * `Expense.reject()` orders it the other way round (reason first) because the entity
 * has no row lock to consult — this layer does.
 *
 * ## Rejection is `pending_approval → draft` (D1)
 *
 * There is no `rejected` status. The expense goes back to being a draft its creator
 * may correct and submit again, and the Admin's decision survives as the
 * `rejected_by`/`rejected_at`/`rejection_reason` stamps — which is what the creator
 * reads, and which a resubmission clears (`Expense.submitForApproval()` and the
 * definer function both clear them). The reason is therefore required, and its rule
 * is the domain's, reused verbatim: `createExpenseRejectionReason` is the same
 * function the entity calls, so the message and the code a client sees are the
 * entity's (`void_reason_too_short`, `field: "reason"`) and the definer function's
 * re-check cannot disagree with it.
 *
 * ## What the transaction owns, and what it does not
 *
 * One `expense_reject()` transaction owns the whole decision: the row is locked, the
 * lifecycle and the caller's version are re-checked under that lock, the approval is
 * cleared, the rejection stamps are written and the version is bumped by the shared
 * trigger. Nothing financial happens — no split is priced, no due is created, no
 * balance moves and no `expense.published` event is raised. A rejection is a workflow
 * decision, not a reversal.
 *
 * ## Who may reject, and who may reject their own
 *
 * `expense.approve` is a **full** Admin cell (PRD §2.1), so a Treasurer, a Committee
 * Member, a Resident, a Tenant and a Guest are each refused — by role, not by a
 * self-approval rule. An Admin **may** reject their own expense for the same reason
 * they may approve it: a single-Admin society must not be able to deadlock its own
 * high-value expenses (ADR-0011 D5).
 *
 * ## No event, and no idempotency record
 *
 * The domain's event catalogue is closed (ADR-0011 D6) and the transport it would
 * need does not exist yet: creator notification is formally deferred to Phase 6 /
 * T107. And a rejection is not a retryable money-moving POST — a second attempt meets
 * a row that is no longer `pending_approval` with `409 INVALID_TRANSITION` rather
 * than being replayed as a success.
 */
@Injectable()
export class RejectExpenseUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY)
    private readonly expenses: ExpenseRepository,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: ExpenseMembershipReader,
  ) {}

  /** Rejects one expense awaiting a decision, or refuses with the reason. */
  async reject(
    actor: UserId,
    societyId: SocietyId,
    expenseId: ExpenseId,
    command: RejectExpenseCommand,
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
      throw toAppError(expenseError("forbidden", REJECT_FORBIDDEN));
    }

    // 4 · The lifecycle and the lock, checked here so a hopeless request costs no
    //     more than one read. Both are re-checked under the row lock inside
    //     `expense_reject()`: this is the fast refusal, the database's is the one
    //     that cannot be raced.
    if (record.status !== "pending_approval") {
      throw toAppError(
        expenseError(
          "invalid_transition",
          "Only an expense awaiting approval can be rejected.",
          { from: record.status, to: "draft" },
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

    // 5 · The reason, through the domain's own rule — the same function the
    //     aggregate's `reject()` calls, so the message and the code a client sees
    //     are the entity's (`void_reason_too_short`, `field: "reason"`), and the
    //     definer function's re-check cannot disagree with it.
    const reason = await unwrap(createExpenseRejectionReason(command.reason));

    // 6 · The decision, atomically, through the one definer transaction that can
    //     write the rejection stamps (they are not in the client UPDATE grant, which
    //     is what stops a client from forging a rejection).
    try {
      return await this.expenses.reject(
        expenseId,
        societyId,
        { expectedVersion: command.expectedVersion, reason },
        actor,
      );
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }
  }
}

/** What the route hands the use case — the contract has already parsed it. */
export interface RejectExpenseCommand {
  /** The version the caller read; required, because a lock that can be omitted is not one. */
  readonly expectedVersion: number;
  /** Trimmed and ≥ 10 characters after `createExpenseRejectionReason`; the creator sees it. */
  readonly reason: string;
}

/** One wording, so the refusal cannot drift between the route and this file. */
export const REJECT_FORBIDDEN = "Only a society Admin can reject an expense.";
