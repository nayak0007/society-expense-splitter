import {
  DomainError,
  type ApartmentBasis,
  type ApartmentId,
  type DomainErrorInit,
  type MemberId,
  type Money,
  type Paise,
  type Weight,
} from "@ses/domain";

/**
 * The split engine's contract — what `computeSplit` accepts and answers
 * (Roadmap T056/T057, PRD §3.5).
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
 * The strategies this package implements — all five of the database's.
 *
 * `equal` and `percentage` (T056), `shares` and `custom` (T057), `apartment`
 * (T058). `split_strategy` in `supabase/migrations/20260920130000_society_core.sql`
 * is `('equal', 'percentage', 'shares', 'apartment', 'custom')`, and the spelling
 * here matches it exactly so a stored value maps onto a strategy without a
 * translation table.
 *
 * `apartment` is the one strategy with a *second* dimension: which apartment
 * attribute is the weight. That is {@link ApartmentBasis}, and it is not a
 * strategy of its own — the database models it as a column (`apartment_basis`)
 * beside `split_strategy`, and the PRD as a selector in the expense form — so
 * `planSplit` dispatches on the strategy and the apartment arm dispatches on the
 * basis.
 *
 * Listing a strategy before it exists would be the tempting mistake: a caller
 * could then pass it, type-check, and reach a `switch` that throws at runtime. The
 * union grows as the strategies land — and because `planSplit` dispatches with an
 * exhaustive `switch` over this union, a strategy added here without a branch of
 * its own is a compile error too.
 */
// The vocabulary moved to `@ses/domain` in T062
// (`packages/domain/src/shared/split-vocabulary.ts`), which is where the full
// rationale for the five arms and the six bases now lives. Re-exported rather than
// re-declared so there is exactly one spelling: `@ses/contracts` and
// `@ses/application` may import the domain but not this package, and a second
// literal is the drift the PRD's "a preview must equal the bill" rule cannot
// survive. `planSplit`'s exhaustive `switch` over this union is unchanged.
export { SPLIT_STRATEGIES, type SplitStrategy } from "@ses/domain";

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
// Apartment bases
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The apartment attributes a split can be weighted by (PRD §3.5.4, Roadmap T058).
 *
 * These six are the database's own. `apartment_basis` in
 * `supabase/migrations/20260920130000_society_core.sql` is exactly
 * `('per_flat', 'per_sqft_carpet', 'per_sqft_builtup', 'per_bhk',
 * 'per_floor_band', 'per_parking_slot')`, and the spelling here matches it so a
 * stored value maps onto a basis without a translation table — the argument
 * {@link SPLIT_STRATEGIES} makes for the strategy enum, made one dimension over.
 *
 * ## What is deliberately *not* a basis
 *
 * PRD §3.5.4's bullet list also names `occupied_only`, and it is absent here on
 * purpose. It is not in the `apartment_basis` enum, so no expense could ever store
 * it; its own gloss is "skip vacant flats", which is a question about *who
 * participates* rather than about how a participating flat is weighted; and T063's
 * participant resolver owns exactly that question (its selector has `occupancy`,
 * `includeVacant` and `bill_vacant_flats`). Making it a basis here would move a
 * resolution decision into the engine — the boundary {@link SplitParticipant}
 * documents.
 */
// Defined in `@ses/domain` — see the note above the strategy re-export.
export { APARTMENT_BASES, type ApartmentBasis } from "@ses/domain";

/**
 * The five bases that read a fact off each participant and nothing else.
 *
 * Split out as a type so {@link ApartmentAttributeSplitInput} can say "any basis
 * whose input carries no configuration" without listing them twice, and so
 * {@link ApartmentFloorBandSplitInput} can be the one arm that must carry bands.
 */
export type ApartmentAttributeBasis = Exclude<ApartmentBasis, "per_floor_band">;

/**
 * One floor band (PRD §3.5.4): an inclusive floor range and the multiplier a flat
 * in it is weighted by.
 *
 * `mult` is written the way the PRD and the wire write it — `0`, `1`, `1.5` — and
 * is read as an exact integer of thousandths, never as a float (see the weights
 * table on {@link ApartmentParticipant}). **Zero is legal and means exempt, not
 * excluded**: a ground-floor flat in a lift charge pays exactly ₹0 and still
 * appears in the split, which is what Roadmap T058's "charges ground-floor flats
 * exactly ₹0" asks for. Excluding the band instead would make the flat vanish from
 * the split table a resident reads.
 */
export interface FloorBand {
  readonly from: number;
  readonly to: number;
  readonly mult: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shares
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `ShareUnits` — a share count as an exact integer: **thousandths of a share**.
 * `1.5` shares is `1500n`; one whole share is `1000n`.
 *
 * ## Why the scale is thousandths
 *
 * It is the column's scale, not a choice made here: `apartments.share_units` is
 * `numeric(8, 3)` with `CHECK (share_units >= 0 AND share_units <= 10000)`
 * (`20260924140000_structure_apartments.sql`), and PRD §3.5.3 says shares may be
 * "integer or decimal". A decimal share held as a float is the same hazard a float
 * percentage is — `0.1 + 0.2` is not `0.3`, and a ledger has to balance to the
 * paisa — so a share is represented the way the database represents it: an
 * integer of thousandths, widened to a `Weight` with no division anywhere.
 *
 * ## The scale cannot move money
 *
 * Shares are a ratio, and every weight scaled by the same factor allocates the
 * same proportions — `3000 : 2000 : 1000` is `3 : 2 : 1` — because
 * `Money.allocateByWeights` divides once by the sum it is given, and the
 * remainder ranking it uses for the residual is scaled by that same factor. What
 * the scale buys is the decimal: `1.25` shares is expressible as `1250n`, rather
 * than as a float that is *almost* `1.25`.
 */
declare const shareUnitsBrand: unique symbol;

export type ShareUnits = bigint & {
  readonly [shareUnitsBrand]: "ShareUnits";
};

/** One whole share — the `1` of `apartments.share_units DEFAULT 1`. */
export const ONE_SHARE = 1_000n as ShareUnits;

/**
 * The ceiling on a share count: **`10_000` shares**, i.e. `10_000_000`
 * thousandths.
 *
 * The number is the database's (`chk_apartments_share_units`, quoted above), and
 * the reason to enforce it here is the same reason a zero amount is refused: a
 * weight above the column's limit describes a split that could never be stored,
 * so accepting it would turn a field error the treasurer can fix into a
 * constraint violation at commit. It is also, exactly, the largest weight that
 * still fits `expense_splits.weight numeric(12, 4)` — eight integer digits.
 */
export const MAX_SHARE_UNITS = 10_000_000n as ShareUnits;

/**
 * Validates and brands a share count.
 *
 * Accepts a whole number of thousandths from `1` to `10_000_000` — `0.001` to
 * `10_000` shares. **Zero and negative shares are refused** (Roadmap T057): a
 * share is a claim on a pool, and a participant with no claim is not a
 * participant. Returning a ₹0 allocation for a mistyped share would hide the
 * mistake rather than refuse it, and `expense_splits` would carry a row for a flat
 * the society never meant to charge. A flat the society does mean to exempt is
 * left out of the participant list by participant resolution (T063) — the same
 * way a flat outside the selector is left out today — or given the `0%` that a
 * percentage split allows (see `percentageWeights`).
 *
 * A `number` must be a safe integer: `1.5` shares is `1500`, so a fractional
 * `number` arriving here is a caller that has already done share arithmetic in
 * floats. Rounding it into money is the one thing this package must never do, so
 * it is refused instead.
 */
export function shareUnits(value: bigint | number): ShareUnits {
  const candidate =
    typeof value === "number"
      ? Number.isSafeInteger(value)
        ? BigInt(value)
        : undefined
      : value;

  if (candidate === undefined) {
    throw splitError(
      "validation",
      `A share must be a whole number of thousandths, received ${String(value)}; 1.5 shares is 1500.`,
      { field: "participants.share" },
    );
  }

  if (candidate <= 0n) {
    throw splitError(
      "validation",
      `A share must be greater than zero, received ${candidate.toString()} thousandths.`,
      { field: "participants.share" },
    );
  }

  if (candidate > MAX_SHARE_UNITS) {
    throw splitError(
      "validation",
      `A share cannot exceed ${(MAX_SHARE_UNITS / ONE_SHARE).toString()} shares, received ${candidate.toString()} thousandths.`,
      { field: "participants.share" },
    );
  }

  return candidate as ShareUnits;
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

/**
 * A participant in a shares split: the same share, with its share count.
 *
 * The count is a {@link ShareUnits} — thousandths of a share, the
 * `apartments.share_units numeric(8, 3)` scale — and it is validated on the way in
 * (`shareUnits`), because a share is a ratio that has to be exact. The field is
 * named for what the treasurer configures ("give 102 three shares"), and it is
 * still the only thing this strategy needs: a share count *is* a weight.
 */
export interface ShareParticipant extends SplitParticipant {
  readonly share: ShareUnits;
}

/**
 * A participant in a custom split: the same share, with the exact amount the
 * treasurer allocated to it.
 *
 * This is the one strategy where each participant's figure is *the answer* rather
 * than a basis to divide — no proportion, no residual, no rounding — so it is the
 * one participant type whose value is money rather than a weight.
 *
 * The amount lives on the participant for the same reason the percentage does
 * (see {@link PercentageParticipant}): a parallel array or an id-keyed map makes
 * an amount belonging to nobody, or a participant with no amount, *expressible*.
 * Here both are simply not writable down, and a custom split "excludes a flat" by
 * leaving it out of the list.
 */
export interface CustomParticipant extends SplitParticipant {
  readonly amount: Money;
}

/**
 * A participant in an apartment-basis split: the same share, with the flat's
 * attributes.
 *
 * The facts are the apartment columns the six bases read
 * (`apartments` in `20260924140000_structure_apartments.sql`), under the names the
 * domain entity and the wire contract already use: `floor`, `carpetAreaSqft`,
 * `builtupAreaSqft`, `bhk`, `parkingSlots`. They are **per-participant**, in the
 * same way a percentage and a share count are, so which flat a fact belongs to
 * cannot be misaligned — and they are **required and nullable**, exactly as the
 * columns are: `null` is "not recorded", which is a fact the engine acts on (see
 * below) rather than an omission a caller may make silently.
 *
 * ## Weights are the attribute, in the column's own scale
 *
 * Each basis hands `Money.allocateByWeights` an exact integer, so a decimal
 * attribute has to be *represented* exactly rather than as a float. The scale is
 * the column's, one more time:
 *
 * | Basis                | Weight given to each participant            |
 * | -------------------- | ------------------------------------------- |
 * | `per_flat`           | `1` — one flat, the same weight as `equal`  |
 * | `per_sqft_carpet`    | carpet area in **hundredths** of a sqft (`numeric(8, 2)`) |
 * | `per_sqft_builtup`   | built-up area in hundredths of a sqft       |
 * | `per_bhk`            | BHK in **tenths** (`numeric(3, 1)`): 2 BHK is `20`, 1.5 BHK is `15` |
 * | `per_floor_band`     | the band's multiplier in **thousandths**: `1.5×` is `1500` |
 * | `per_parking_slot`   | the slot count, whole: 2 slots is `2`       |
 *
 * Only the ratios matter — `Money.allocateByWeights` divides once by the sum it is
 * given — so a scale can never move money, and `per_flat`'s `1` is why a per-flat
 * split and an equal split are the *same result*, weights included.
 *
 * ## What a missing fact does
 *
 * A null attribute **excludes** the flat from the split and raises a warning
 * (Roadmap T058: "Apartments missing the required attribute are excluded and
 * reported as a warning, never silently dropped"). The remaining flats share the
 * whole amount, so the ledger still conserves. A value that is present but
 * *impossible* — a floor of `-9`, a BHK of `2.25`, an area of `0` — is a field
 * error instead, because the domain's own value objects (`createFloor`, `createBhk`,
 * `createArea`) and the column `CHECK`s make it unreachable from stored data; see
 * `bases/facts.ts`.
 */
export interface ApartmentParticipant extends SplitParticipant {
  /** `null` = not recorded. Negative floors are basements, `0` is ground. */
  readonly floor: number | null;
  /** `null` = not measured. Never `0` — see `createArea`. */
  readonly carpetAreaSqft: number | null;
  readonly builtupAreaSqft: number | null;
  /** e.g. `2`, `1.5`. `null` = not recorded. */
  readonly bhk: number | null;
  /** `smallint NOT NULL DEFAULT 0`; `0` is "no allotted slot" and is a weight of `0`. */
  readonly parkingSlots: number;
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
 * Weighted shares (PRD §3.5.3): each participant pays
 * `amount × share ÷ totalShares`.
 */
export interface SharesSplitInput {
  readonly strategy: "shares";
  readonly amount: Money;
  readonly participants: readonly ShareParticipant[];
}

/**
 * Custom (PRD §3.5.5): the treasurer's exact amount per participant, which must
 * add up to the expense.
 */
export interface CustomSplitInput {
  readonly strategy: "custom";
  readonly amount: Money;
  readonly participants: readonly CustomParticipant[];
}

/**
 * Apartment-basis split (PRD §3.5.4, Roadmap T058) whose weight is an attribute
 * carried on the participant.
 *
 * One arm for five bases rather than five near-identical arms: they differ in
 * which fact they read and in nothing else, and the fact lives on the participant
 * either way. The sixth basis is split out because it is the one that needs
 * configuration — see {@link ApartmentFloorBandSplitInput}.
 */
export interface ApartmentAttributeSplitInput {
  readonly strategy: "apartment";
  /** `per_flat`, `per_sqft_carpet`, `per_sqft_builtup`, `per_bhk` or `per_parking_slot`. */
  readonly basis: ApartmentAttributeBasis;
  readonly amount: Money;
  readonly participants: readonly ApartmentParticipant[];
}

/**
 * `per_floor_band` (PRD §3.5.4): the same split, plus the band table the flats'
 * floors are matched against.
 *
 * The bands are the one thing an apartment split needs that is *not* a fact about
 * a flat — they are the expense's configuration, the PRD's
 * `splitConfig: { floorBands: [...] }` — so they are required here and impossible
 * to pass to a basis that would ignore them, which is the same argument
 * {@link ApartmentAttributeSplitInput} makes in the other direction. What is left
 * for runtime validation is the band table's *content*: non-empty, integer ranges
 * that are ordered and inside the floor bounds, non-negative multipliers at the
 * thousandths scale, and no two bands overlapping (Roadmap T058: "Overlapping
 * bands rejected at validation").
 */
export interface ApartmentFloorBandSplitInput {
  readonly strategy: "apartment";
  readonly basis: "per_floor_band";
  readonly amount: Money;
  readonly participants: readonly ApartmentParticipant[];
  readonly floorBands: readonly FloorBand[];
}

/** The `apartment` strategy: five attribute bases and the floor-band basis. */
export type ApartmentSplitInput =
  ApartmentAttributeSplitInput | ApartmentFloorBandSplitInput;

/**
 * What `computeSplit` accepts.
 *
 * A discriminated union rather than `{ strategy, amount, participants, config }`,
 * so the strategy decides what a participant *is* and TypeScript enforces it: an
 * equal split cannot be handed percentages to ignore, a percentage split cannot be
 * run without them, and a custom split cannot be run without amounts. The PRD's
 * `config` slot is where the sketch put the strategy's data; moving that data onto
 * the participant is what makes the invariants structural (see
 * {@link PercentageParticipant}, {@link ShareParticipant} and
 * {@link CustomParticipant}).
 *
 * There is deliberately **no `rounding` field**, though the PRD's sketch lists
 * one. The PRD specifies exactly one rounding rule (§3.5: divide in paise, floor,
 * then hand the residual out one paisa at a time by descending fractional
 * remainder, ties by apartment number ascending), so a parameter whose only legal
 * value is "the rule" would be a choice that does not exist — and the obvious
 * second value, `round`, is the one that loses paise.
 */
export type SplitInput =
  | EqualSplitInput
  | PercentageSplitInput
  | SharesSplitInput
  | CustomSplitInput
  | ApartmentSplitInput;

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
 * A reason a split is still a split but something about its data is worth saying.
 *
 * T058's addition, and the distinction from an error is the whole point: an
 * **error** means the calculation cannot proceed (a reversed floor band, a BHk of
 * 2.25), while a **warning** means it proceeded and a caller should know why the
 * result looks the way it does — `MISSING_AREA`'s flats are *not in the
 * allocations*, and without the warning their absence would be invisible.
 *
 * Machine-readable by construction: a `code` a client switches on, the ids the
 * warning is about, and a rendered `message` for the case where a client has
 * nothing better to say. The PRD's wire example is exactly this shape
 * (`{"code": "MISSING_AREA", "message": "...", "apartmentIds": [...]}`).
 *
 * One warning per code, not per flat: the PRD's example reports three flats with
 * one warning, and a split table wants one line saying "3 flats have no area",
 * not three lines saying one each.
 */
export const SPLIT_WARNING_CODES = [
  "MISSING_AREA",
  "MISSING_BHK",
  "MISSING_FLOOR",
  "NO_FLOOR_BAND",
] as const;

export type SplitWarningCode = (typeof SPLIT_WARNING_CODES)[number];

export interface SplitWarning {
  readonly code: SplitWarningCode;
  /** Human-readable summary, e.g. `"3 apartments were excluded: no area recorded."` */
  readonly message: string;
  /**
   * The flats the warning is about, in the engine's ordering (apartment number
   * byte-wise, then apartment id, then member id) — so two callers who passed the
   * same flats in different orders see the same list, not merely the same set.
   */
  readonly apartmentIds: readonly ApartmentId[];
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
  /**
   * One entry per participant that *took a share*, in apartment-number ascending
   * order. An apartment-basis split can hold back a flat whose attribute is not
   * recorded (T058); such a flat is absent here and named in {@link warnings}.
   */
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
  /**
   * Data-quality reports, **empty for every strategy that cannot produce one**.
   *
   * Present on every result rather than only on apartment splits, so a caller
   * never has to ask which strategy it is holding to know whether to look — the
   * same argument the type union makes for the input side. Ordered by
   * {@link SPLIT_WARNING_CODES}, and frozen like everything else here.
   */
  readonly warnings: readonly SplitWarning[];
}
