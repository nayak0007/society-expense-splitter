import { Inject, Injectable } from "@nestjs/common";
import {
  asExpenseError,
  canOnResource,
  createParticipantSelector,
  expenseError,
  memberSnapshotOf,
} from "@ses/domain";
import type {
  ApartmentBasis,
  ExpenseId,
  ExpenseMemberNameReader,
  ExpenseMembershipReader,
  ExpenseRecalculation,
  ExpenseRecalculationFields,
  ExpenseRepository,
  ExpenseSplitRepository,
  SocietyId,
  SplitStrategy,
  UserId,
} from "@ses/domain";
import { computeSplit } from "@ses/split-engine";

import { MEMBERSHIP_READER } from "../../../../common/authorization/membership-reader";
import {
  assertAllAssignable,
  persistableAllocations,
} from "../expense-allocation.support";
import { toAppError } from "../expense-category-error.mapper";
import {
  EXPENSE_MEMBER_NAME_READER,
  EXPENSE_REPOSITORY,
  EXPENSE_SPLIT_REPOSITORY,
} from "../expense.tokens";
import { ParticipantResolverService } from "../participant-resolver.service";
import {
  loadExpenseOrNotFound,
  loadMembershipOrNotFound,
  snapshotOf,
  unwrap,
} from "./expense-draft.support";
import {
  buildSplitInput,
  fromSplitError,
  resolveSplitPlan,
  verifyConservation,
} from "./preview-split.use-case";
import type { PreviewSplitConfig } from "./preview-split.use-case";

/**
 * Revise a **published** expense — Roadmap T068, PRD §3.5.3, ADR-0009.
 *
 * ## The same calculation as publication, and that is the whole point
 *
 * A recalculation is a publication that already happened. The strategy, the
 * participants, the configuration and the conservation check are therefore read and
 * run through **exactly** the pipeline T066 publishes through — `resolveSplitPlan` →
 * `ParticipantResolverService.resolve` → `buildSplitInput` → `computeSplit` →
 * `verifyConservation` → `persistableAllocations` — with nothing recomputed, re-rounded
 * or re-derived here. A "revision algorithm" beside the publish algorithm would be the
 * second implementation whose drift T064's shared preview path exists to prevent, so
 * this file inherits the authority rather than restating it:
 *
 * ```
 * recalculate(actor, societyId, expenseId, patch)
 *   ├─ membership, then canOnResource("expense.publish", stored record)
 *   ├─ the persisted expense (never a client copy)
 *   ├─ published? and expectedVersion?                        (fail fast)
 *   ├─ strategy/basis from the patch, falling back to the row (never a category)
 *   ├─ the selector: the patch's, or the stored one
 *   ├─ resolveParticipantsForExpense(...)                     (T063 — the resolver)
 *   ├─ refuse while any billable flat has nobody to charge
 *   ├─ buildSplitInput → computeSplit → verifyConservation     (T064's own path)
 *   ├─ the participant snapshots (one bounded name read)
 *   └─ ExpenseSplitRepository.recalculate(...)                (one transaction)
 * ```
 *
 * ## The patch is a patch, and its absent keys mean "unchanged"
 *
 * Only the fields the caller sent travel to the database (`RecalculateExpenseRecordInput`,
 * whose type *is* the allow-list), so a title-only revision leaves the money alone and
 * a strategy change writes the basis the plan resolved — including `null` when the new
 * strategy never reads one, which is what stops a stale basis from surviving a strategy
 * move. `expenseDate`, `dueDate`, `categoryId`, `paidByMemberId`, `paymentSource` and
 * every lifecycle field are absent from that type by construction, refused by the route
 * with a field error rather than dropped, and refused again by the definer function's
 * whitelist if a caller ever reaches it outside this path: three layers, none of which
 * silently ignores a forbidden edit.
 *
 * ## What the database owns, and why nothing here duplicates it
 *
 * The revision snapshot, the due lifecycle (retained amounts in place, removed
 * participants' dues superseded and never deleted, added dues created), the exact
 * balance deltas, the recomputed `oldest_due_date` and the single `expense_revisions`
 * row are all the `expense_recalculate()` transaction's — see ADR-0009. This use case
 * never reads a balance, never computes a delta and never touches `dues`: the one
 * write is the repository call, and what comes back is the row and the diff the
 * database measured over the rows that committed.
 *
 * ## The paid-obligation block
 *
 * A revision that would put an obligation below an already-verified payment is
 * refused **whole** by the database, with no writes at all (ADR-0009 §13). The
 * refusal travels as `paid_obligation` — `409 CONFLICT` with
 * `DUE_PAID_EXCEEDS_NEW_AMOUNT` — and the caller is told to issue a credit
 * adjustment instead. T068 deliberately does not create that credit (T086 owns
 * adjustments); refusing here is what keeps a payment from becoming an overpayment.
 *
 * ## Not here
 *
 * No idempotency record: a published revision is an optimistic-locked `PATCH` keyed on
 * `expectedVersion`, and a retry with a stale version is refused rather than replayed
 * (`version_mismatch` carries the row's current version, which makes reload-and-retry
 * unambiguous). No event is dispatched: the catalogue has none for a revision, and
 * T068's observable side effects are the revision row and the database's own diff.
 */
@Injectable()
export class RecalculateExpenseUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY)
    private readonly expenses: ExpenseRepository,
    @Inject(EXPENSE_SPLIT_REPOSITORY)
    private readonly splits: ExpenseSplitRepository,
    @Inject(EXPENSE_MEMBER_NAME_READER)
    private readonly names: ExpenseMemberNameReader,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: ExpenseMembershipReader,
    private readonly participants: ParticipantResolverService,
  ) {}

  /** Revises one published expense, or refuses with the reason the caller can act on. */
  async recalculate(
    actor: UserId,
    societyId: SocietyId,
    expenseId: ExpenseId,
    patch: RecalculateExpenseCommand,
  ): Promise<ExpenseRecalculation> {
    // 1 · Membership and the resource decision. The revision moves money, so it is
    //     the same `expense.publish` cell publication uses — a published expense is
    //     not a draft, so a Committee Member's draft-only grant does not reach it.
    const membership = await loadMembershipOrNotFound(
      this.memberships,
      actor,
      societyId,
    );

    // 2 · The persisted row, for the same reason publication reads it: society,
    //     creator, amount, category, strategy, config, selector, status and version
    //     all come from it, and a cross-society or unknown id is `not_found`.
    const record = await loadExpenseOrNotFound(
      this.expenses,
      actor,
      societyId,
      expenseId,
    );

    const allowed = canOnResource(
      memberSnapshotOf(membership),
      "expense.publish",
      snapshotOf(record),
    );
    if (!allowed) {
      throw toAppError(expenseError("forbidden", RECALCULATE_FORBIDDEN));
    }

    // 3 · Lifecycle and lock, the fast refusals; the definer function re-checks both
    //     under the row lock, where they cannot be raced. A draft is edited through
    //     T065's PATCH and a void expense is final (T069 owns reversal by voiding).
    if (record.status !== "published") {
      throw toAppError(
        expenseError(
          "invalid_transition",
          "Only a published expense can be recalculated. Drafts are edited, and void expenses are final.",
          { from: record.status },
        ),
      );
    }
    if (record.version !== patch.expectedVersion) {
      throw toAppError(
        expenseError(
          "version_mismatch",
          "This expense was changed by someone else. Reload it and try again.",
          {
            field: "expectedVersion",
            expectedVersion: patch.expectedVersion,
            currentVersion: record.version,
          },
        ),
      );
    }

    // 4 · The effective strategy and basis. The stored values are the baseline and
    //     the patch may move either; **no category is consulted**, because
    //     `category_id` is immutable after publication (ADR-0009 §4) — a published
    //     revision has no category default to fall through to, and inventing one
    //     would let an unrelated category edit re-price a bill behind the caller's
    //     back. `resolveSplitPlan` is the one authority for "what strategy and basis
    //     is this", so it is called rather than re-implemented; it drops a basis the
    //     effective strategy never reads, which is what clears a stale one.
    const plan = await unwrap(
      resolveSplitPlan(
        {
          amountPaise: patch.amountPaise ?? record.amount.paise,
          selector: record.participantSelector,
          categoryId: record.categoryId,
          splitStrategy: patch.splitStrategy ?? record.splitStrategy,
          apartmentBasis:
            patch.apartmentBasis !== undefined
              ? patch.apartmentBasis
              : record.apartmentBasis,
          splitConfig: configOf(patch, record.splitConfig),
        },
        null,
      ),
    );

    // 5 · The selector: the patch's when it sent one — re-validated through the same
    //     `createParticipantSelector` a stored selector replays through, so the wire
    //     and the database cannot disagree about what a selector is — or the stored
    //     one, which the resolver re-validates anyway.
    let selector = record.participantSelector;
    if (patch.participantSelector !== undefined) {
      selector = await unwrap(
        createParticipantSelector(patch.participantSelector ?? {}),
      );
    }

    // 6 · Resolution — T063's own use case, called once with the expense's own
    //     category (owner routing still applies). Nothing here re-derives eligibility.
    const resolution = await this.participants.resolve(actor, societyId, {
      selector,
      categoryId: record.categoryId,
    });

    // 7 · Fail closed while a billable flat has nobody to charge, before the engine
    //     runs: the revision cannot orphan a flat any more than a publication can.
    assertAllAssignable(resolution.unassigned);

    // 8 · The engine input, the engine, conservation — T064's exported path. The
    //     amount is the patch's exact bigint, or the row's.
    const amount: bigint =
      patch.amountPaise === undefined
        ? record.amount.paise
        : BigInt(patch.amountPaise);
    const input = await unwrap(
      buildSplitInput(
        resolution,
        plan,
        amount,
        configOf(patch, record.splitConfig),
      ),
    );
    const computed = computeSplit(input);
    if (!computed.ok) throw toAppError(fromSplitError(computed.error));
    const verified = await unwrap(verifyConservation(computed.value));

    // 9 · The engine's allocations, plus the two facts only this layer has — the
    //     same mapping publication writes, so a revised split row is
    //     indistinguishable in shape from a published one.
    const allocations = await persistableAllocations(
      this.names,
      actor,
      societyId,
      verified.allocations,
      resolution.participants,
      plan.strategy,
    );

    // 10 · The whole revision, atomically — revision row, split and due lifecycle,
    //      balance deltas and the expense's editable fields, all inside
    //      `expense_recalculate()`. A refusal here (including the paid-obligation
    //      block) leaves the published state exactly as it was.
    try {
      return await this.splits.recalculate(
        expenseId,
        societyId,
        {
          expectedVersion: patch.expectedVersion,
          fields: recalculationFields(
            patch,
            plan.strategy,
            plan.basis,
            amount,
            selector,
          ),
          allocations,
          changeNote: patch.changeNote ?? null,
        },
        actor,
      );
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }
  }
}

/**
 * What the route hands the use case — the patch, already parsed by the contract.
 *
 * The fields mirror `updateExpenseSchema` minus the four a published revision may not
 * change (`expenseDate`, `categoryId`, `paymentSource`, `paidByMemberId`), which the
 * dispatcher refuses by name before this type is built. `changeNote` is T068's own:
 * it is stored on the revision row and never on the expense.
 */
export interface RecalculateExpenseCommand {
  readonly expectedVersion: number;
  readonly title?: string | undefined;
  readonly description?: string | null | undefined;
  readonly vendorName?: string | null | undefined;
  readonly amountPaise?: number | undefined;
  readonly splitStrategy?: SplitStrategy | undefined;
  readonly apartmentBasis?: ApartmentBasis | null | undefined;
  readonly splitConfig?: PreviewSplitConfig | null | undefined;
  readonly participantSelector?: unknown;
  readonly changeNote?: string | null | undefined;
}

/** One wording, so the refusal cannot drift between the route and this file. */
export const RECALCULATE_FORBIDDEN =
  "Only a society Admin or Treasurer can revise a published expense.";

/**
 * The config the plan runs with: the patch's merged value, or the stored `jsonb`.
 *
 * An explicit `null` on the wire is the editor's "back to the defaults", which is `{}`
 * — the same convention T065's update keeps — and an absent key leaves the column
 * alone. `null` is never forwarded: the engine reads a config structurally, and a
 * `null` where an object belongs would be a shape nobody meant.
 */
function configOf(
  patch: RecalculateExpenseCommand,
  stored: unknown,
): PreviewSplitConfig | undefined {
  if (patch.splitConfig !== undefined) {
    return patch.splitConfig ?? {};
  }
  return stored as PreviewSplitConfig | undefined;
}

/**
 * The fields to write, and **only** the ones the caller sent.
 *
 * The definer function distinguishes an absent key (leave the column alone) from a
 * present one (write it), so this mapping is what makes an absent patch key mean
 * "unchanged" all the way down. Two derived keys are the exception and they are
 * deliberate:
 *
 *  - `apartmentBasis` travels whenever the strategy *or* the basis moved, carrying the
 *    plan's own value (which is `null` when the effective strategy never reads a
 *    basis). Without that, a move from `apartment` to `equal` would leave the old
 *    basis in the column — a fact the new strategy ignores, but one a later reader
 *    (and the revision snapshot) would have to interpret;
 *  - `splitConfig` travels only when the caller sent one, exactly like every other
 *    editable field.
 */
function recalculationFields(
  patch: RecalculateExpenseCommand,
  strategy: SplitStrategy,
  basis: ApartmentBasis | null,
  amount: bigint,
  selector: unknown,
): ExpenseRecalculationFields {
  const planMoved =
    patch.splitStrategy !== undefined || patch.apartmentBasis !== undefined;

  return {
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.description === undefined
      ? {}
      : { description: patch.description }),
    ...(patch.vendorName === undefined ? {} : { vendorName: patch.vendorName }),
    ...(patch.amountPaise === undefined ? {} : { amountPaise: amount }),
    ...(patch.splitStrategy === undefined ? {} : { splitStrategy: strategy }),
    ...(planMoved ? { apartmentBasis: basis } : {}),
    ...(patch.splitConfig === undefined
      ? {}
      : { splitConfig: { ...(patch.splitConfig ?? {}) } }),
    ...(patch.participantSelector === undefined
      ? {}
      : {
          participantSelector: selector as Readonly<Record<string, unknown>>,
        }),
  };
}
