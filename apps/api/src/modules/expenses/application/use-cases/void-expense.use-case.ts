import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  asExpenseError,
  canOnResource,
  createVoidReason,
  expenseError,
  expenseVoidedEvent,
  memberSnapshotOf,
} from "@ses/domain";
import type {
  Clock,
  ExpenseEvent,
  ExpenseEventPublisher,
  ExpenseId,
  ExpenseMembershipReader,
  ExpenseRepository,
  ExpenseSplitRepository,
  ExpenseVoid,
  SocietyId,
  UserId,
} from "@ses/domain";

import { MEMBERSHIP_READER } from "../../../../common/authorization/membership-reader";
import { toAppError } from "../expense-category-error.mapper";
import {
  EXPENSE_CLOCK,
  EXPENSE_EVENT_PUBLISHER,
  EXPENSE_REPOSITORY,
  EXPENSE_SPLIT_REPOSITORY,
} from "../expense.tokens";
import {
  loadExpenseOrNotFound,
  loadMembershipOrNotFound,
  snapshotOf,
  unwrap,
} from "./expense-draft.support";

/**
 * Void a published expense, converting what was already paid into advance credit —
 * Roadmap T069, PRD §3.5, ADR-0010.
 *
 * ## The steps, in the order that decides error precedence
 *
 * ```text
 * void(actor, societyId, expenseId, { expectedVersion, reason })
 *   ├─ membership, then the persisted expense            (not_found for foreign ids)
 *   ├─ canOnResource("expense.void", stored snapshot)     (the 🟡 own-drafts site)
 *   ├─ published? and expectedVersion?                    (the fast refusals)
 *   ├─ createVoidReason(reason)                           (the domain's own rule)
 *   ├─ ExpenseSplitRepository.voidExpense(...)            (one transaction)
 *   └─ dispatch expense.voided — AFTER the commit
 * ```
 *
 * The order is deliberately the **database's** order, not the entity's: the
 * definer function checks membership → capability → lifecycle → version → reason
 * under the row lock, so `createVoidReason` runs *after* the lifecycle and lock
 * pre-checks here as well. A second void carrying a ten-character reason and a
 * second void carrying a five-character one both answer `invalid_transition`,
 * which is the truth about the expense; only a published row can be wrong about
 * its reason. `Expense.void_()` orders it the other way round (reason first)
 * because the entity has no row lock to consult — this layer does.
 *
 * ## What the domain owns here, and what it deliberately does not
 *
 * The **rule** is the domain's and is reused verbatim, never restated:
 * `createVoidReason` — the exact function `Expense.void_()` calls first — decides
 * what a usable reason is (trimmed, ≥ 10 characters, no control characters), and
 * `expenseVoidedEvent` is the constructor `void_()` itself returns. Nothing about
 * the `published → void` edge is re-decided in the application: the fast refusal
 * reads the row's status, and the authoritative decision is the definer
 * function's under the lock.
 *
 * `Expense.void_()` is **not** called, and that is a recorded divergence rather
 * than an oversight. The method lives on an aggregate, and `Expense.reconstitute`
 * re-asserts its invariant that a published expense's splits sum exactly to its
 * amount — so reaching `void_()` means first reading `expense_splits`. Those rows
 * are exactly what `expense_void()` reads under the row lock, one statement
 * later, and the entity built from them would be thrown away the moment the
 * transaction returned (only its event is kept, and the event is built from the
 * reason and the clock, not from the entity's state). Reading them twice to
 * satisfy a check the database already enforces would be ceremony that could also
 * *fail* where the RPC succeeds (a split row whose `snapshot` could not be
 * reconstructed into an allocation). The three things the spec assigns to
 * `void_()` — published → void, reason validation, event creation — are all the
 * domain's, reused one level down.
 *
 * ## What the transaction owns
 *
 * Everything financial: which dues exist, what each carries in `paid_paise`, the
 * exact signed balance deltas, the recomputed `oldest_due_date`, the supersession
 * of every current principal due and the expense's void stamps are one
 * `expense_void()` transaction (ADR-0010). This file never reads a balance, never
 * computes a credit and never touches `dues` or `member_balances` — there is no
 * second reversal path, and no `SELECT balance → JS → UPDATE` to race.
 *
 * ## Not here
 *
 * No idempotency record: void is not a retryable money-moving POST, and a second
 * attempt is a terminal-state refusal (`409 INVALID_TRANSITION`) rather than a
 * replay. No revision row: `expense_revisions` records published *edits*, and a
 * void is not one. No allocation: the credit this creates is consumed by T079,
 * and its due-level attribution order is T079's written contract — inventing it
 * here would ship an untested allocator inside a reversal.
 */
@Injectable()
export class VoidExpenseUseCase {
  private readonly logger = new Logger(VoidExpenseUseCase.name);

  constructor(
    @Inject(EXPENSE_REPOSITORY)
    private readonly expenses: ExpenseRepository,
    @Inject(EXPENSE_SPLIT_REPOSITORY)
    private readonly splits: ExpenseSplitRepository,
    @Inject(EXPENSE_EVENT_PUBLISHER)
    private readonly events: ExpenseEventPublisher,
    @Inject(EXPENSE_CLOCK) private readonly clock: Clock,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: ExpenseMembershipReader,
  ) {}

  /** Voids one published expense, or refuses with the reason the caller can act on. */
  async void(
    actor: UserId,
    societyId: SocietyId,
    expenseId: ExpenseId,
    command: VoidExpenseCommand,
  ): Promise<ExpenseVoid> {
    // 1 · The subject. No membership and a removed one are one answer (`not_found`,
    //     PRD T041); a `pending` membership is left to the resource decision.
    const membership = await loadMembershipOrNotFound(
      this.memberships,
      actor,
      societyId,
    );

    // 2 · The persisted row — society, status, version and creator all come from
    //     it, never from the caller.
    const record = await loadExpenseOrNotFound(
      this.expenses,
      actor,
      societyId,
      expenseId,
    );

    // 3 · The resource decision. `expense.void` is a ✅ cell for Admin and
    //     Treasurer; a Committee Member's grant is *own drafts*, and the stored
    //     row is published, so `canOnResource` refuses them. This is the 🟡
    //     narrowing site the route inventory's `NARROWED_ROUTES` entry names.
    const allowed = canOnResource(
      memberSnapshotOf(membership),
      "expense.void",
      snapshotOf(record),
    );
    if (!allowed) {
      throw toAppError(expenseError("forbidden", VOID_FORBIDDEN));
    }

    // 4 · The lifecycle and the lock, checked here so a hopeless request costs no
    //     more than one read. Both are re-checked under the row lock inside
    //     `expense_void()`: this is the fast refusal, the database's is the one
    //     that cannot be raced — and a second void is a refusal, never a replay.
    if (record.status !== "published") {
      throw toAppError(
        expenseError(
          "invalid_transition",
          "Only a published expense can be voided. A draft is edited or deleted, and a void expense is final.",
          { from: record.status },
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
    //     aggregate's `void_()` calls, so the message and the code a client sees
    //     are the entity's (`void_reason_too_short`, `field: "voidReason"`), and
    //     the definer function's re-check cannot disagree with it.
    const reason = await unwrap(createVoidReason(command.reason));

    // 6 · The whole reversal, atomically: one call to the `expense_void()` definer
    //     transaction. After this returns, the expense is void and the balances
    //     have moved — never before.
    let voided: ExpenseVoid;
    try {
      voided = await this.splits.voidExpense(
        expenseId,
        societyId,
        { expectedVersion: command.expectedVersion, reason },
        actor,
      );
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }

    // 7 · Post-commit, and non-fatal — SAD §3.2's ordering, exactly as the
    //     publication path keeps it: a notification that cannot be sent must never
    //     un-void a bill that has committed.
    await this.dispatchAfterCommit(
      [
        expenseVoidedEvent(
          expenseId,
          societyId,
          membership.id,
          reason,
          this.clock.nowIso(),
        ),
      ],
      expenseId,
      societyId,
    );

    return voided;
  }

  /**
   * Dispatch, after the transaction, without letting a failure undo the void.
   *
   * The catch is the whole point: the bill's reversal is already committed and
   * nothing this method can do will change that, so the failure is logged with the
   * ids an operator needs to find what was not announced.
   */
  private async dispatchAfterCommit(
    events: readonly ExpenseEvent[],
    expenseId: ExpenseId,
    societyId: SocietyId,
  ): Promise<void> {
    if (events.length === 0) return;
    try {
      await this.events.dispatch(events);
    } catch (error: unknown) {
      this.logger.warn(
        `expense.event.dispatch_failed society=${societyId} expense=${expenseId} events=${events
          .map((event) => event.name)
          .join(
            ",",
          )} reason=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** What the route hands the use case — the contract has already parsed it. */
export interface VoidExpenseCommand {
  /** The version the caller read; required, because a lock that can be omitted is not one. */
  readonly expectedVersion: number;
  /** Trimmed and ≥ 10 characters after `createVoidReason`; residents see it. */
  readonly reason: string;
}

/** One wording, so the refusal cannot drift between the route and this file. */
export const VOID_FORBIDDEN =
  "Only a society Admin or Treasurer can void a published expense.";
