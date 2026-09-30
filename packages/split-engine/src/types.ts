import {
  DomainError,
  type ApartmentId,
  type DomainErrorInit,
  type MemberId,
  type Money,
  type Paise,
  type Weight,
} from "@ses/domain";

/**
 * The split engine's contract — what `computeSplit` accepts and answers
 * (Roadmap T056, PRD §3.5).
 *
 * ## Where this sits
 *
 * A pure function of its argument. No database, no HTTP, no clock, no random
 * source and no mutable state: the same input yields the same allocations on the
 * server that publishes a bill and on the phone that previewed it, which is the
 * whole reason `packages/split-engine` exists as a shared package rather than as
 * a method on the expense aggregate (SAD §1.1 — "the split engine must be
 * byte-identical on client and server"). A preview that disagrees with the bill
 * is the trust-destroying bug the PRD rates Sev-1, so divergence is prevented by
 * construction rather than by review.
 *
 * ## Money is the only amount
 *
 * Every amount here is `Money` — an exact integer of paise (T012, ADR-0005) — and
 * **this package performs no arithmetic on amounts at all**. It hands the amount
 * and a weight per participant to
 * [`Money.allocateByWeights`](../../domain/src/shared/money.vo.ts), which is the
 * one implementation of the largest-remainder rule in the repository. A second
 * implementation is exactly how a paisa goes missing between the preview and the
 * bill.
 *
 * `amountPaise` does not appear in this file on purpose. The PRD's sketch of
 * `SplitResult` writes `amountPaise` because that is the JSON wire shape
 * (SAD §7.9: money on the wire is an integer `*Paise` field); inside the domain
 * the amount is a `Money`, and the conversion belongs to the API contract layer
 * where `paiseToWire` already lives.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Error codes a split can fail with.
 *
 * All three already exist in the shared catalogue, so the API's error mapper
 * needs no new case (`hasDomainErrorCode` is what it switches on):
 *
 *  - `validation` — the request could not describe a split at all: a zero or
 *    negative total, no participants, percentages that do not total 100%.
 *  - `conflict` — the request describes the same participant twice, which would
 *    charge one flat two shares of one expense.
 *  - `invariant` — a bug, not input: the allocations do not sum to the total.
 *    Nothing can produce this today, which is why it throws rather than being
 *    returned.
 */
export const SPLIT_ERROR_CODES = [
  "validation",
  "conflict",
  "invariant",
] as const;

export type SplitErrorCode = (typeof SPLIT_ERROR_CODES)[number];

export class SplitError extends DomainError<SplitErrorCode> {
  constructor(
    code: SplitErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>> | undefined,
  ) {
    const init: DomainErrorInit<SplitErrorCode> = { code, message, details };
    super(init);
    this.name = "SplitError";
  }
}

export function isSplitError(error: unknown): error is SplitError {
  return error instanceof SplitError;
}

export function splitError(
  code: SplitErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>> | undefined,
): SplitError {
  return new SplitError(code, message, details);
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The strategies this package implements.
 *
 * Two of the database's five. `split_strategy` in
 * `supabase/migrations/20260920130000_society_core.sql` is already
 * `('equal', 'percentage', 'shares', 'apartment', 'custom')`, and the spelling
 * here matches it exactly so a stored value maps onto a strategy without a
 * translation table. `shares` and `custom` arrive with T057, the apartment bases
 * with T058.
 *
 * Listing all five now would be the tempting mistake: a caller could then pass
 * `strategy: 'custom'`, type-check, and reach a `switch` that throws at runtime.
 * The union grows as the strategies land, so "not implemented" is a compile error
 * rather than a production one.
 */
export const SPLIT_STRATEGIES = ["equal", "percentage"] as const;

export type SplitStrategy = (typeof SPLIT_STRATEGIES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Percentages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `BasisPoints` — a percentage as an exact integer: hundredths of a percent.
 *
 * `100%` is `10_000n` basis points and `0.01%` is `1n`, so the PRD's "two decimal
 * places" (§3.5) and the roadmap's "within 0.01% tolerance" (T056) are both
 * *exact* integer statements rather than float comparisons with an epsilon.
 *
 * ## Why not a float
 *
 * `33.33 + 33.33 + 33.34` is `99.99999999999999` in binary floating point, so a
 * float percentage total is either wrong or requires a tolerance that is itself a
 * float — and a tolerance of `0.01` does not mean `0.01` once it is a double.
 * The PRD's own worked example (`33.33 + 33.33 + 33.34 = 100.00`) has to be
 * deterministic, and in basis points it simply is: `3333 + 3333 + 3334 = 10_000`.
 *
 * It is also what keeps the fractions out of the *weights*: a percentage becomes
 * a `Weight` by a lossless widening of the same integer, never by
 * `percent * total / 100` with a float in the middle.
 */
declare const basisPointsBrand: unique symbol;

export type BasisPoints = bigint & {
  readonly [basisPointsBrand]: "BasisPoints";
};

/** `100%`. The total every percentage split must reach within the tolerance below. */
export const PERCENT_TOTAL_BASIS_POINTS = 10_000n as BasisPoints;

/**
 * The permitted deviation from `100%`, in basis points: one, i.e. `0.01%`.
 *
 * Both the PRD ("Validation blocks save if off by more than 0.01%") and T056
 * ("must total exactly 100.00% within 0.01% tolerance") state this same rule, and
 * because one basis point *is* `0.01%` the comparison is exact integer arithmetic.
 * The tolerance exists because three participants cannot each hold a
 * two-decimal share of some totals — `33.33%` three times is `99.99%`, and that
 * is a legitimate ledger, not a typo.
 */
export const PERCENT_TOLERANCE_BASIS_POINTS = 1n;

/**
 * Validates and brands a percentage.
 *
 * Accepts a whole number of basis points between `0` and `10_000`. Zero is legal
 * and means "owes nothing from this pool" — the same meaning `Weight` gives it,
 * and the case a society needs for an exempt flat. Rejects a fractional value
 * (`33.33` is `3333` basis points, not `33.33` basis points) rather than rounding
 * it, because silently rounding a percentage moves money between participants.
 */
export function basisPoints(value: bigint | number): BasisPoints {
  const candidate =
    typeof value === "number"
      ? Number.isSafeInteger(value)
        ? BigInt(value)
        : undefined
      : value;

  if (candidate === undefined) {
    throw splitError(
      "validation",
      `A percentage must be a whole number of basis points, received ${String(value)}; 33.33% is 3333.`,
      { field: "participants.percentage" },
    );
  }

  if (candidate < 0n || candidate > PERCENT_TOTAL_BASIS_POINTS) {
    throw splitError(
      "validation",
      `A percentage must be between 0% and 100%, received ${candidate.toString()} basis points.`,
      { field: "participants.percentage" },
    );
  }

  return candidate as BasisPoints;
}

// ─────────────────────────────────────────────────────────────────────────────
// Participants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One participant in a split: a member, the flat whose share it is, and the flat's
 * label.
 *
 * The two ids are the domain's existing branded ids rather than a new
 * `ParticipantId`, because they are also the columns the result is written to —
 * `expense_splits` is keyed `(expense_id, member_id, apartment_id)` with
 * `uq(expense_id, member_id, apartment_id)` (SAD §8) — and a third identifier
 * would need mapping back before the insert.
 *
 * `apartmentNumber` is carried for **ordering only**, and it is not redundant:
 * the residual paisa's destination is decided by apartment number ascending
 * (PRD §3.5, T056), and `apartmentId` is a uuid, whose order is arbitrary and
 * would put the extra paisa on an essentially random flat. This is the same
 * byte-wise comparison the database index is pinned to — see
 * [`compareApartments`](../../domain/src/structure/apartment.ts), which orders
 * `apartment_number COLLATE "C"` so a re-sorted list cannot disagree with the
 * server.
 *
 * A participant is a *share*, not a person: whether a flat's share is charged to
 * its owner or its tenant is participant resolution's decision (T063), made
 * before this function is called. That routing is why `memberId` is an input
 * rather than something the engine derives — an owner-only category has to be
 * able to name the owner.
 */
export interface SplitParticipant {
  readonly memberId: MemberId;
  readonly apartmentId: ApartmentId;
  readonly apartmentNumber: string;
}

/**
 * A participant in a percentage split: the same share, with its percentage.
 *
 * The percentage lives *on* the participant rather than in a parallel array or a
 * `config` map keyed by id, and that is a deliberate departure from the PRD's
 * `SplitInput` sketch. Both alternatives make a real bug expressible — a
 * misaligned parallel array silently moves a percentage onto the wrong flat, and
 * an id-keyed map can name a participant who is not in the list. Here the
 * percentage cannot be separated from the share it belongs to, and an unknown
 * reference is not something validation has to catch because it cannot be
 * written down.
 *
 * The same shape carries T057's `shares` and `custom` strategies — a share count
 * and an exact amount are per-participant values in exactly this way — so the
 * engine will not need restructuring to accept them.
 */
export interface PercentageParticipant extends SplitParticipant {
  readonly percentage: BasisPoints;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

/** Equal split: the amount divided by the number of participants (PRD §3.5.1). */
export interface EqualSplitInput {
  readonly strategy: "equal";
  readonly amount: Money;
  readonly participants: readonly SplitParticipant[];
}

/** Percentage split (PRD §3.5.2): each participant's explicit share of 100%. */
export interface PercentageSplitInput {
  readonly strategy: "percentage";
  readonly amount: Money;
  readonly participants: readonly PercentageParticipant[];
}

/**
 * What `computeSplit` accepts.
 *
 * A discriminated union rather than `{ strategy, amount, participants, config }`,
 * so the strategy decides what a participant *is* and TypeScript enforces it: an
 * equal split cannot be handed percentages to ignore, and a percentage split
 * cannot be run without them. The PRD's `config` slot is where the sketch put the
 * strategy's data; moving that data onto the participant is what makes the
 * invariants structural (see {@link PercentageParticipant}).
 *
 * There is deliberately **no `rounding` field**, though the PRD's sketch lists
 * one. The PRD specifies exactly one rounding rule (§3.5: divide in paise, floor,
 * then hand the residual out one paisa at a time by descending fractional
 * remainder, ties by apartment number ascending), so a parameter whose only legal
 * value is "the rule" would be a choice that does not exist — and the obvious
 * second value, `round`, is the one that loses paise.
 */
export type SplitInput = EqualSplitInput | PercentageSplitInput;

// ─────────────────────────────────────────────────────────────────────────────
// Result
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One participant's share of the expense.
 *
 * `weight` is the basis that produced `amount` — `1` for every participant in an
 * equal split, the basis points in a percentage split. The PRD's result carries
 * it, and it is not derived state: it is the answer to the question a resident
 * actually asks ("why do *I* owe this much?"), and it is what a split table
 * renders next to the amount.
 */
export interface SplitAllocation {
  readonly memberId: MemberId;
  readonly apartmentId: ApartmentId;
  readonly apartmentNumber: string;
  readonly amount: Money;
  readonly weight: Weight;
}

/**
 * The split, complete.
 *
 * `Σ allocations[i].amount === total`, exactly, in paise — the invariant the
 * ledger rests on. It is not restated as a field: a consumer that wants to check
 * it sums the allocations it was given, which is precisely the assertion the
 * database's deferred constraint trigger makes at publish time
 * (`chk_split_total`, SAD §8).
 */
export interface SplitResult {
  /** The amount that was split, echoed so a caller never re-passes it. */
  readonly total: Money;
  /** One entry per participant, in apartment-number ascending order. */
  readonly allocations: readonly SplitAllocation[];
  /**
   * Paise that the rounding rule could not place: **zero**.
   *
   * `Money.allocateByWeights` distributes the whole residual, so nothing is ever
   * left over, and this field is *measured* from the allocations rather than
   * assumed to be zero — if the rule ever stopped conserving, the number would
   * show up here instead of vanishing. It is in the result because the invariant
   * ("residual is always zero after distribution", T059) has to be assertable by
   * whoever holds the result, and recomputing it downstream would re-implement
   * the arithmetic this package exists to centralise.
   */
  readonly residualPaise: Paise;
}
