import { Inject, Injectable } from "@nestjs/common";
import { resolveParticipantsForExpense } from "@ses/application";
import type { ExpenseParticipantDeps } from "@ses/application";
import {
  Money,
  asExpenseCategoryId,
  asExpenseError,
  canOnResource,
  err,
  expenseError,
  memberSnapshotOf,
  ok,
  paise,
} from "@ses/domain";
import type {
  ApartmentBasis,
  ApartmentId,
  ExpenseCategory,
  ExpenseCategoryRepository,
  ExpenseError,
  ExpenseMembershipReader,
  ExpenseParticipant,
  ExpenseParticipantReader,
  ExpenseParticipantResolution,
  ExpenseSocietyReader,
  MemberId,
  Paise,
  Result,
  SocietyId,
  SocietyMembership,
  SplitStrategy,
  SplitWarningCode,
  UnassignedReason,
  UserId,
  Weight,
} from "@ses/domain";
import { ONE_SHARE, computeSplit } from "@ses/split-engine";
import type {
  ApartmentParticipant,
  BasisPoints,
  CustomParticipant,
  FloorBand,
  PercentageParticipant,
  ShareParticipant,
  ShareUnits,
  SplitError,
  SplitInput,
  SplitResult,
} from "@ses/split-engine";

import { MEMBERSHIP_READER } from "../../../../common/authorization/membership-reader";
import { toAppError } from "../expense-category-error.mapper";
import { EXPENSE_CATEGORY_REPOSITORY } from "../expense-category.tokens";
import {
  EXPENSE_PARTICIPANT_READER,
  EXPENSE_SOCIETY_READER,
} from "../participant.tokens";

/**
 * The stateless split preview — Roadmap T064, PRD §3.5 / §API.
 *
 * ## What it composes, and what it does not
 *
 * ```
 * preview(command)
 *   ├─ membership + canOnResource("expense.create", draft expense)   (authorisation)
 *   ├─ category defaults, only when the request omitted strategy/basis
 *   ├─ resolveParticipantsForExpense(...)                            (T063 — the resolver)
 *   ├─ buildSplitInput(...)                                          (config → engine input)
 *   ├─ computeSplit(...)                                             (T059 — the engine)
 *   └─ toPreview(...)                                                (engine result → preview)
 * ```
 *
 * There is **one** participant-resolution implementation (T063's use case, called, never
 * re-derived) and **one** allocation implementation (T059's `computeSplit`, called, never
 * re-derived). Nothing in this file queries a table, filters a flat, routes a tenant or
 * performs allocation arithmetic; the only rules it owns are the *composition* ones — what
 * an omitted strategy or basis defaults to, which config section the effective strategy
 * reads, and how a request's per-participant entries are validated against the resolved
 * set. Those are exactly the rules T066's publish path must share, so they are exported
 * pure functions rather than private methods.
 *
 * ## Nothing persists, and the type says so
 *
 * Every dependency is a read-shaped port and the engine is a pure function, so a
 * successful preview performs zero writes by construction — the integration suite
 * measures the row counts as well, because "there is no repository injected" is a claim
 * about the wiring and not about the schema. No expense, split, due, revision or event is
 * created: pricing a split and recording it are different operations, and only T066 does
 * the second.
 *
 * ## The unassigned case, stated exactly
 *
 * T063 can return a billable flat with **no member to address the charge to**
 * (`unassigned_no_owner` / `unassigned_no_member`). This preview runs the engine over the
 * *assignable* participants and reports those flats in the response's `unassigned` list
 * with their reason — it does not silently drop them, and it does not invent a member to
 * charge. It stops short of allocating them a share because no contract in the system can
 * represent a member-less allocation: the engine's `SplitParticipant.memberId` is
 * required (T059), `ExpenseSplit.fromAllocation` requires it (T061), and
 * `dues.member_id` is `NOT NULL` (T060), so an amount for such a flat could be computed
 * but never published as a due. Whether the flat should nevertheless carry its share in
 * the split is a product decision that belongs to T066's publish design, with the PRD
 * §3.5.4 sentence ("the due attaches to the apartment") on one side and the three
 * contracts on the other; until it is decided, the flagged list is the honest
 * representation, and the `preview == publish` contract test is what will force the two
 * paths to change together.
 *
 * ## Errors
 *
 * Expected failures are `Result`s from the pure functions and thrown `AppError`s out of
 * the service — the same seam `ParticipantResolverService` keeps, so a controller never
 * branches on `ok`. Engine failures are converted **faithfully** (`validation`,
 * `conflict`, `invariant` all exist in the expense vocabulary), and an engine success
 * whose allocations do not sum to the amount is refused as `invariant` rather than
 * answered — SAD's "the one test that must never go red" is checked at the boundary that
 * receives the result.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Command
// ─────────────────────────────────────────────────────────────────────────────

/** One flat's percentage — hundredths of a percent, `33.33%` is `3333`. */
export interface PreviewSplitPercentageEntry {
  readonly apartmentId: string;
  readonly basisPoints: number;
}

/** One flat's share count — thousandths of a share, `1.5` is `1500`. */
export interface PreviewSplitShareEntry {
  readonly apartmentId: string;
  readonly shareUnits: number;
}

/** One flat's custom allocation, in integer paise. */
export interface PreviewSplitCustomAmountEntry {
  readonly apartmentId: string;
  readonly amountPaise: number;
}

/** One floor band (PRD §3.5.4). `mult` is a decimal; the engine reads thousandths. */
export interface PreviewSplitFloorBand {
  readonly from: number;
  readonly to: number;
  readonly mult: number;
}

/**
 * The strategy-specific configuration, structurally the contract's `splitConfig`.
 *
 * Structural rather than a contracts import, because a use case is also callable with a
 * `jsonb` replay (T066's recalculation) and must not depend on the wire. Each key belongs
 * to one strategy; the effective strategy decides which key is read.
 */
export interface PreviewSplitConfig {
  readonly percentages?: readonly PreviewSplitPercentageEntry[] | undefined;
  readonly shares?: readonly PreviewSplitShareEntry[] | undefined;
  readonly customAmounts?: readonly PreviewSplitCustomAmountEntry[] | undefined;
  readonly floorBands?: readonly PreviewSplitFloorBand[] | undefined;
}

/**
 * What the route hands the use case — already parsed by the contract schema.
 *
 * `selector` is `unknown` on purpose: `resolveParticipantsForExpense` takes it as
 * `unknown` and re-validates it through the domain's `createParticipantSelector`, which
 * is the same path a stored selector replays through, so the wire and the replay cannot
 * disagree about what a selector is.
 */
export interface PreviewSplitCommand {
  /**
   * The amount in paise. `bigint` as well as `number` because T066's publish path
   * calls this same plan builder with the **persisted** amount, which is a `bigint`
   * by the time a row has been read (`ExpenseRecord.amount.paise`); widening the
   * parameter keeps the one authority callable from both doors without a lossy
   * `Number()` in between.
   */
  readonly amountPaise: number | bigint;
  readonly selector: unknown;
  /** `null` and absent are one fact: no category defaults are consulted. */
  readonly categoryId?: string | null | undefined;
  readonly splitStrategy?: SplitStrategy | undefined;
  readonly apartmentBasis?: ApartmentBasis | null | undefined;
  readonly splitConfig?: PreviewSplitConfig | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────────────────────────────────────

/** One computed allocation — the SAD §8.3 facts a publish will snapshot. */
export interface PreviewSplitAllocation {
  readonly memberId: MemberId;
  readonly apartmentId: ApartmentId;
  readonly apartmentNumber: string;
  readonly amount: Money;
  readonly weight: Weight;
}

/** T058's warning, carried through unchanged (one per code, in code order). */
export interface PreviewSplitWarning {
  readonly code: SplitWarningCode;
  readonly message: string;
  readonly apartmentIds: readonly ApartmentId[];
}

/** A billable flat with nobody to address the charge to — T063's flagged case. */
export interface PreviewSplitUnassigned {
  readonly apartmentId: ApartmentId;
  readonly apartmentNumber: string;
  readonly reason: UnassignedReason;
}

/** The preview, in domain values — the presentation mapper crosses to the wire. */
export interface ExpenseSplitPreview {
  readonly total: Money;
  /** The flats that took a share; equals `allocations.length`. */
  readonly participantCount: number;
  readonly allocations: readonly PreviewSplitAllocation[];
  readonly residualPaise: Paise;
  readonly warnings: readonly PreviewSplitWarning[];
  readonly unassigned: readonly PreviewSplitUnassigned[];
}

/** One wording, so the refusal cannot drift between the route and a direct caller. */
export const PREVIEW_SPLIT_REASON =
  "Only a society Admin, Treasurer or Committee Member can preview an expense split.";

// ─────────────────────────────────────────────────────────────────────────────
// The effective strategy and basis
// ─────────────────────────────────────────────────────────────────────────────

/** What the split will be, once the request and the category's defaults are reconciled. */
export interface ResolvedSplitPlan {
  readonly strategy: SplitStrategy;
  /** Set exactly when `strategy` is `apartment`; `null` otherwise. */
  readonly basis: ApartmentBasis | null;
}

/**
 * The strategy and basis the preview runs with (PRD §3.5, T062's category defaults).
 *
 * An omitted `splitStrategy` starts from the category's `default_split_strategy` — the
 * PRD's "what a new expense in this category starts as" — and `equal` when no category is
 * named. An `apartment` strategy takes its basis from the request, then the category's
 * `default_apartment_basis`, and is a **field error** when neither supplies one: guessing a
 * basis would price every flat by a rule nobody chose.
 *
 * A basis supplied beside a strategy that never reads one is dropped rather than refused,
 * which is the convention T062's category route records for the same field — a client
 * that switches strategies in the live editor can leave a stale basis on the request, and
 * failing it would make the editor's own state machine harder than the rule.
 */
export function resolveSplitPlan(
  command: PreviewSplitCommand,
  category: ExpenseCategory | null,
): Result<ResolvedSplitPlan, ExpenseError> {
  const strategy =
    command.splitStrategy ?? category?.defaultSplitStrategy ?? "equal";

  if (strategy !== "apartment") {
    return ok({ strategy, basis: null });
  }

  const basis =
    command.apartmentBasis ?? category?.defaultApartmentBasis ?? null;
  if (basis === null) {
    return err(
      expenseError(
        "validation",
        "The apartment strategy needs a basis — per_flat, per_sqft_carpet, per_sqft_builtup, per_bhk, per_floor_band or per_parking_slot.",
        { field: "apartmentBasis" },
      ),
    );
  }

  return ok({ strategy, basis });
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One config section's per-flat values, validated against the resolved set (T064).
 *
 * Keyed by `apartmentId` because resolution guarantees one participant per flat, and
 * **every reference must match a flat the resolver is charging**: an entry for an
 * apartment outside the selector, or for a flagged unassigned flat the engine has no
 * participant for, is a `validation` error rather than a silent no-op — a percentage
 * that quietly belonged to nobody would leave the editor showing 100% while a flat was
 * not billed. A duplicate reference is refused here for the same reason: silently
 * keeping one of the two would make the request mean something the client did not say.
 *
 * The three sections share this shape and one implementation; only the value each entry
 * carries differs, and the caller passes the reader for it.
 */
function valueEntries<TEntry extends { readonly apartmentId: string }>(
  entries: readonly TEntry[] | undefined,
  field: string,
  participants: readonly ExpenseParticipant[],
  readValue: (entry: TEntry) => number,
): Result<ReadonlyMap<string, number>, ExpenseError> {
  const values = new Map<string, number>();
  if (entries === undefined) return ok(values);

  const chargeable = new Set<string>(
    participants.map((participant) => participant.apartmentId),
  );

  for (const entry of entries) {
    if (values.has(entry.apartmentId)) {
      return err(
        expenseError(
          "validation",
          `${field} names the same apartment twice; one flat takes one share of a split.`,
          { field, apartmentId: entry.apartmentId },
        ),
      );
    }
    if (!chargeable.has(entry.apartmentId)) {
      return err(
        expenseError(
          "validation",
          `${field} names an apartment this selector does not charge — it is outside the selector, or no member is attached to it.`,
          { field, apartmentId: entry.apartmentId },
        ),
      );
    }
    values.set(entry.apartmentId, readValue(entry));
  }

  return ok(values);
}

/**
 * `apartments.share_units numeric(8, 3)` → the engine's `ShareUnits`.
 *
 * The column stores shares with three decimals (`3.000` is three shares, `1.500` is one
 * and a half) and the engine represents that same fact as an integer of thousandths
 * (`3_000n`, `1_500n` — `types.ts`'s "it is the column's scale"), so the crossing
 * multiplies by `ONE_SHARE`. The rounding is exact rather than a compromise: the
 * column's scale is three decimals and its ceiling ten thousand, so the mathematical
 * product is an integer of at most eight digits, and the float error at that magnitude
 * is far below a half-integer boundary. No formula and no allocation happen here — the
 * value is only handed to the engine in the engine's own unit.
 */
function storedShareUnits(value: number): number {
  return Math.round(value * Number(ONE_SHARE));
}

/**
 * Maps the resolved participants and the split config onto the engine's own input type —
 * the exact object T059 accepts and T066's publish path will build too (this function is
 * exported for that reason).
 *
 * ## Defaults are the strategy's own, not invented here
 *
 *  - **`percentage`** — a flat with no entry is `0` basis points, the value T056 permits
 *    as "owes nothing from this pool"; the engine still refuses a set that does not reach
 *    100% within its tolerance.
 *  - **`shares`** — a flat with no entry uses `apartments.share_units`, the column PRD
 *    §3.5.3 calls "a manual weight for share-based splits" and the one place a shares
 *    split's default comes from. That column is `numeric(8, 3)` — shares with three
 *    decimals — while the engine counts **thousandths**, so the crossing multiplies by
 *    `ONE_SHARE` (`storedShareUnits` below). A stored `0` is not defaulted around:
 *    T057 refuses a zero share, and that refusal is what the treasurer needs to see.
 *    An explicit request entry is already in the engine's thousandths (the contract's
 *    `shareUnits`), so only the stored side is scaled.
 *  - **`custom`** — exclusion is expressed by omission (T057), so a flat with no entry
 *    is not in the engine's participant list at all.
 *  - **`equal` / `apartment`** — every resolved participant takes part; their facts travel
 *    straight from resolution, which is why a participant is structurally an
 *    `ApartmentParticipant` and no fact can be misaligned with its flat.
 *
 * ## Why the percentages and shares are cast rather than branded
 *
 * `basisPoints()` and `shareUnits()` **throw** on a bad value; the strategies re-validate
 * the same values and **return** a typed `validation` error naming the offending field.
 * Casting here — the case the strategy docs already anticipate ("a caller has cast its way
 * past `basisPoints()`") — keeps the reachable refusal path the typed one, including the
 * zero-share case the brander would turn into a 500. Nothing else consumes these values
 * before the engine validates them.
 */
export function buildSplitInput(
  resolution: ExpenseParticipantResolution,
  plan: ResolvedSplitPlan,
  amountPaise: number | bigint,
  config: PreviewSplitConfig | undefined,
): Result<SplitInput, ExpenseError> {
  const amount = Money.fromPaise(paise(amountPaise));
  const participants = resolution.participants;

  switch (plan.strategy) {
    case "equal":
      return ok({ strategy: "equal", amount, participants });

    case "percentage": {
      const entries = valueEntries(
        config?.percentages,
        "splitConfig.percentages",
        participants,
        (entry) => entry.basisPoints,
      );
      if (!entries.ok) return entries;

      const list: PercentageParticipant[] = participants.map((participant) => ({
        memberId: participant.memberId,
        apartmentId: participant.apartmentId,
        apartmentNumber: participant.apartmentNumber,
        percentage: BigInt(
          entries.value.get(participant.apartmentId) ?? 0,
        ) as BasisPoints,
      }));
      return ok({ strategy: "percentage", amount, participants: list });
    }

    case "shares": {
      const entries = valueEntries(
        config?.shares,
        "splitConfig.shares",
        participants,
        (entry) => entry.shareUnits,
      );
      if (!entries.ok) return entries;

      const list: ShareParticipant[] = participants.map((participant) => ({
        memberId: participant.memberId,
        apartmentId: participant.apartmentId,
        apartmentNumber: participant.apartmentNumber,
        share: BigInt(
          entries.value.get(participant.apartmentId) ??
            storedShareUnits(participant.shareUnits),
        ) as ShareUnits,
      }));
      return ok({ strategy: "shares", amount, participants: list });
    }

    case "custom": {
      const entries = valueEntries(
        config?.customAmounts,
        "splitConfig.customAmounts",
        participants,
        (entry) => entry.amountPaise,
      );
      if (!entries.ok) return entries;

      const list: CustomParticipant[] = [];
      for (const participant of participants) {
        const stated = entries.value.get(participant.apartmentId);
        if (stated === undefined) continue; // exclusion by omission — T057.
        list.push({
          memberId: participant.memberId,
          apartmentId: participant.apartmentId,
          apartmentNumber: participant.apartmentNumber,
          amount: Money.fromPaise(paise(stated)),
        });
      }
      return ok({ strategy: "custom", amount, participants: list });
    }

    case "apartment": {
      // Unreachable through `resolveSplitPlan`, which refuses a null basis; kept so this
      // function's contract does not depend on its caller's.
      if (plan.basis === null) {
        return err(
          expenseError("validation", "The apartment strategy needs a basis.", {
            field: "apartmentBasis",
          }),
        );
      }

      const facts: readonly ApartmentParticipant[] = participants;
      if (plan.basis === "per_floor_band") {
        const floorBands: readonly FloorBand[] = config?.floorBands ?? [];
        return ok({
          strategy: "apartment",
          basis: plan.basis,
          amount,
          participants: facts,
          floorBands,
        });
      }
      return ok({
        strategy: "apartment",
        basis: plan.basis,
        amount,
        participants: facts,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The engine's result, as the preview reports it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The conservation check SAD §15 names as the one test that must never go red.
 *
 * `Money.allocateByWeights` distributes the whole residual, so this can never fail in
 * practice — which is exactly why it is checked here rather than assumed: the layer that
 * receives a result is the last place a broken allocation can be stopped before it is
 * reported as a bill. A successful-but-non-conserving result is an `invariant` failure,
 * not a validation error, because no caller input could produce it.
 */
export function verifyConservation(
  result: SplitResult,
): Result<SplitResult, ExpenseError> {
  const sum = result.allocations.reduce(
    (total, allocation) => total.add(allocation.amount),
    Money.zero(),
  );

  if (!sum.equals(result.total)) {
    return err(
      expenseError(
        "invariant",
        "The split engine returned allocations that do not sum to the expense amount.",
        { field: "amount" },
      ),
    );
  }
  return ok(result);
}

/**
 * An engine failure in the expense module's vocabulary.
 *
 * The three engine codes are the three shared codes, so the translation is faithful and
 * the API's mapper needs no new case. The engine's `conflict` (the same member and flat
 * twice) is unreachable from here by construction — resolution yields one participant per
 * flat and `valueEntries` refuses a duplicate reference — but it is not remapped: if a
 * future composition makes it reachable, it must keep meaning "409".
 */
export function fromSplitError(error: SplitError): ExpenseError {
  return expenseError(error.code, error.message, error.details);
}

/**
 * The engine's result plus resolution's flags, as one frozen preview.
 *
 * Allocations keep the engine's own order (apartment number ascending, the residual
 * rule's order — T059), and the flagged list keeps resolution's (floor then label, T063),
 * so two callers who passed the same set see byte-identical output. `participantCount`
 * counts the allocations, matching the PRD's example where it equals the allocation
 * list's length; a flagged flat is not a participant.
 */
export function toPreview(
  result: SplitResult,
  resolution: ExpenseParticipantResolution,
): ExpenseSplitPreview {
  const allocations: PreviewSplitAllocation[] = result.allocations.map(
    (allocation) => ({
      memberId: allocation.memberId,
      apartmentId: allocation.apartmentId,
      apartmentNumber: allocation.apartmentNumber,
      amount: allocation.amount,
      weight: allocation.weight,
    }),
  );

  const warnings: PreviewSplitWarning[] = result.warnings.map((warning) => ({
    code: warning.code,
    message: warning.message,
    apartmentIds: warning.apartmentIds,
  }));

  const unassigned: PreviewSplitUnassigned[] = resolution.unassigned.map(
    (entry) => ({
      apartmentId: entry.apartmentId,
      apartmentNumber: entry.apartmentNumber,
      reason: entry.reason,
    }),
  );

  return Object.freeze({
    total: result.total,
    participantCount: allocations.length,
    allocations: Object.freeze(allocations),
    residualPaise: result.residualPaise,
    warnings: Object.freeze(warnings),
    unassigned: Object.freeze(unassigned),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The API's preview use case — DI, orchestration and `Result` → `AppError`.
 *
 * The pure pieces above are exported so this class contains only the two things that
 * need the container: resolving the dependencies and ordering the steps. The step order
 * is the error precedence, and it is deliberate — contract (the pipe) → membership and
 * the resource decision → category defaults → strategy/basis plan → participant
 * resolution → engine input → engine → conservation. A caller that fixes the first
 * failure in that list can always re-run and reach the next one; a request that names a
 * cross-society category never costs the society-wide participant read.
 */
@Injectable()
export class PreviewSplitUseCase {
  constructor(
    @Inject(EXPENSE_PARTICIPANT_READER)
    private readonly participants: ExpenseParticipantReader,
    @Inject(EXPENSE_SOCIETY_READER)
    private readonly society: ExpenseSocietyReader,
    @Inject(EXPENSE_CATEGORY_REPOSITORY)
    private readonly categories: ExpenseCategoryRepository,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: ExpenseMembershipReader,
  ) {}

  private get deps(): ExpenseParticipantDeps {
    return {
      participants: this.participants,
      society: this.society,
      categories: this.categories,
      memberships: this.memberships,
    };
  }

  /**
   * Prices the split a selector would produce, without writing anything.
   *
   * Throws `AppError` on every expected refusal, exactly like
   * `ParticipantResolverService.resolve` — the controller therefore never branches on a
   * `Result`, and the same call surface serves T066's publish preview later.
   */
  async preview(
    actor: UserId,
    societyId: SocietyId,
    command: PreviewSplitCommand,
  ): Promise<ExpenseSplitPreview> {
    // 1 · The caller's membership, then the resource decision. `canOnResource` reads
    //     the record the caller is composing — an *unpublished* expense, which is what
    //     the matrix's 🟡 `expense.create` cell is about — so a Committee Member's
    //     preview is allowed and composing something already published would not be.
    //     A role the guard already refused never reaches here; this is the narrowing
    //     site the route inventory requires for a conditional action, and it fails
    //     closed for a caller that invoked the use case outside the HTTP pipeline.
    const membership = await this.loadMembership(actor, societyId);
    const allowed = canOnResource(
      memberSnapshotOf(membership),
      "expense.create",
      {
        kind: "expense",
        societyId,
        createdByMembershipId: membership.id,
        published: false,
      },
    );
    if (!allowed) {
      throw toAppError(expenseError("forbidden", PREVIEW_SPLIT_REASON));
    }

    // 2 · Category defaults, but only when the request actually omitted something a
    //     category can supply. The resolver reads the category too (for
    //     `is_owner_only`); this read exists for `default_split_strategy` /
    //     `default_apartment_basis`, and skipping it when the request is complete keeps
    //     the common path at one read.
    const needsDefaults =
      command.splitStrategy === undefined ||
      (command.splitStrategy === "apartment" &&
        (command.apartmentBasis ?? null) === null);
    const category =
      needsDefaults && command.categoryId != null
        ? await this.loadCategory(actor, societyId, command.categoryId)
        : null;

    // 3 · The plan before resolution, so a missing basis is a field error that costs no
    //     directory read.
    const plan = await unwrap(resolveSplitPlan(command, category));

    // 4 · Resolution — T063's use case, called once. Owner-only routing, vacancy,
    //     eligibility and ordering are all decided there, never re-derived here.
    const resolution = await unwrap(
      resolveParticipantsForExpense(this.deps, actor, societyId, {
        selector: command.selector,
        categoryId:
          command.categoryId == null
            ? null
            : asExpenseCategoryId(command.categoryId),
      }),
    );

    // 5 · The engine input, then the engine — one authority each, and the conservation
    //     check at the boundary that receives the result.
    const input = await unwrap(
      buildSplitInput(
        resolution,
        plan,
        command.amountPaise,
        command.splitConfig,
      ),
    );
    const computed = computeSplit(input);
    if (!computed.ok) throw toAppError(fromSplitError(computed.error));

    const verified = await unwrap(verifyConservation(computed.value));
    return toPreview(verified, resolution);
  }

  /**
   * The caller's membership, or `not_found`.
   *
   * The same rule T063's loader keeps: no membership and a removed membership are one
   * answer, because a distinguishable one would let a caller prove another tenant's
   * society exists (PRD T041), and a `pending` membership is left for the resource
   * decision to refuse (its grant is a grant on a membership the society has not admitted).
   */
  private async loadMembership(
    actor: UserId,
    societyId: SocietyId,
  ): Promise<SocietyMembership> {
    let membership: SocietyMembership | null;
    try {
      membership = await this.memberships.findMembership(societyId, actor);
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }

    if (membership === null || membership.status === "removed") {
      throw toAppError(
        expenseError("not_found", "That society is not available to you."),
      );
    }
    return membership;
  }

  /**
   * The category the defaults come from, or `not_found`.
   *
   * Read through T062's own `findCategory`, so a soft-deleted category and another
   * society's category are the same answer resolution will give moments later; an
   * **inactive** category resolves normally, which is T062's recorded hand-off (the
   * expense form filters on `isActive` — that is the picker's rule, not this read's).
   */
  private async loadCategory(
    actor: UserId,
    societyId: SocietyId,
    categoryId: string,
  ): Promise<ExpenseCategory> {
    let category: ExpenseCategory | null;
    try {
      category = await this.categories.findCategory(
        asExpenseCategoryId(categoryId),
        societyId,
        actor,
      );
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }

    if (category === null) {
      throw toAppError(
        expenseError("not_found", "That category is not available to you."),
      );
    }
    return category;
  }
}

/**
 * Unwraps a `Result` — or a promise of one — into a value or a thrown `AppError`.
 *
 * Accepts both because the steps above are a mix of synchronous pure functions and
 * asynchronous use cases, and a second helper for one of the two would be a second
 * refusal path to keep in step.
 */
async function unwrap<T>(
  pending: Result<T, ExpenseError> | Promise<Result<T, ExpenseError>>,
): Promise<T> {
  const result = await pending;
  if (!result.ok) {
    throw toAppError(result.error);
  }
  return result.value;
}
