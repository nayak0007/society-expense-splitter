import { Money, asApartmentId, asMemberId, type Result } from "@ses/domain";

import {
  basisPoints,
  shareUnits,
  type ApartmentParticipant,
  type CustomParticipant,
  type FloorBand,
  type PercentageParticipant,
  type ShareParticipant,
  type SplitAllocation,
  type SplitParticipant,
} from "../types";

/**
 * Test fixtures for the split engine's suites.
 *
 * Not a test file (`*.test.ts` is what the preset collects), and excluded from
 * coverage by `coveragePathIgnorePatterns: ["/__tests__/"]`, so the builders here
 * are never mistaken for production code.
 *
 * Ids are derived from the flat number rather than written out, because the tests
 * that matter assert on *ordering* and on *which* flat carries the residual paisa.
 * A fixture whose ids were random would make those assertions unreadable, and one
 * whose ids were hand-copied would drift the moment a case was added.
 */

/**
 * One participant. The default ids are `member-<number>` / `apartment-<number>`.
 *
 * Overriding them is how the tests express the two cases the ordering contract
 * turns on: two participants in the *same* flat (same `apartmentNumber`, so the
 * id tie-breakers decide) and a participant whose id order disagrees with the
 * order it was passed in.
 */
export function flat(
  apartmentNumber: string,
  options: {
    readonly memberId?: string;
    readonly apartmentId?: string;
  } = {},
): SplitParticipant {
  return {
    memberId: asMemberId(options.memberId ?? `member-${apartmentNumber}`),
    apartmentId: asApartmentId(
      options.apartmentId ?? `apartment-${apartmentNumber}`,
    ),
    apartmentNumber,
  };
}

/** A participant with a percentage, given in basis points (`3333` is `33.33%`). */
export function percentFlat(
  apartmentNumber: string,
  percentage: number | bigint,
  options: {
    readonly memberId?: string;
    readonly apartmentId?: string;
  } = {},
): PercentageParticipant {
  return {
    ...flat(apartmentNumber, options),
    percentage: basisPoints(percentage),
  };
}

/** `count` flats numbered from `first` upwards — `101`, `102`, … */
export function flats(count: number, first = 101): readonly SplitParticipant[] {
  return Array.from({ length: count }, (_, index) =>
    flat(String(first + index)),
  );
}

/**
 * A participant with a share count, in thousandths (`3_000` is three shares).
 *
 * The unit is spelled out in every call — `shareUnits` refuses a float, and the
 * `numeric(8, 3)` scale is the schema's — so a test that writes `3_000` is
 * writing exactly what a society with a `share_units` of `3.000` would send.
 */
export function shareFlat(
  apartmentNumber: string,
  share: number | bigint,
  options: {
    readonly memberId?: string;
    readonly apartmentId?: string;
  } = {},
): ShareParticipant {
  return { ...flat(apartmentNumber, options), share: shareUnits(share) };
}

/**
 * `count` flats sharing one share count, numbered from `first` upwards.
 *
 * The shape a BHK tier has: ten 3-share flats in a row, then twenty 2-share flats,
 * and so on. Written as a builder rather than a literal so the roadmap's own
 * example reads as the tiers it names rather than as fifty constructor calls.
 */
export function shareTier(
  count: number,
  share: number | bigint,
  first: number,
): readonly ShareParticipant[] {
  return Array.from({ length: count }, (_, index) =>
    shareFlat(String(first + index), share),
  );
}

/**
 * The PRD's lift bands: ground floor `0×`, floors 1–3 `1×`, floors 4–8 `1.5×`.
 *
 * Frozen, because it is shared: a test that measured "the caller's bands are not
 * mutated" by mutating this one would poison every other test in the run.
 */
export const LIFT_BANDS: readonly FloorBand[] = Object.freeze([
  { from: 0, to: 0, mult: 0 },
  { from: 1, to: 3, mult: 1 },
  { from: 4, to: 8, mult: 1.5 },
]);

/**
 * A participant in an apartment split, with the flat's attributes.
 *
 * Every fact has a default, so a test states only the one it is about — and `null`
 * is passed through rather than defaulted, because "not recorded" is a fact the
 * engine acts on and is the case most of these tests exist for.
 */
export function apartmentFlat(
  apartmentNumber: string,
  facts: {
    readonly floor?: number | null;
    readonly carpetAreaSqft?: number | null;
    readonly builtupAreaSqft?: number | null;
    readonly bhk?: number | null;
    readonly parkingSlots?: number;
  } = {},
  options: {
    readonly memberId?: string;
    readonly apartmentId?: string;
  } = {},
): ApartmentParticipant {
  return {
    ...flat(apartmentNumber, options),
    floor: facts.floor === undefined ? 1 : facts.floor,
    carpetAreaSqft:
      facts.carpetAreaSqft === undefined ? 600 : facts.carpetAreaSqft,
    builtupAreaSqft:
      facts.builtupAreaSqft === undefined ? 750 : facts.builtupAreaSqft,
    bhk: facts.bhk === undefined ? 2 : facts.bhk,
    parkingSlots: facts.parkingSlots ?? 1,
  };
}

/** `count` flats with the same attributes, numbered from `first` upwards. */
export function apartmentFlats(
  count: number,
  facts: {
    readonly floor?: number | null;
    readonly carpetAreaSqft?: number | null;
    readonly builtupAreaSqft?: number | null;
    readonly bhk?: number | null;
    readonly parkingSlots?: number;
  } = {},
  first = 101,
): readonly ApartmentParticipant[] {
  return Array.from({ length: count }, (_, index) =>
    apartmentFlat(String(first + index), facts),
  );
}

/**
 * A participant with an exact custom amount, given as rupee text through the real
 * parser — the same door a treasurer's typed figure comes through.
 */
export function customFlat(
  apartmentNumber: string,
  amountText: string,
  options: {
    readonly memberId?: string;
    readonly apartmentId?: string;
  } = {},
): CustomParticipant {
  return { ...flat(apartmentNumber, options), amount: rupees(amountText) };
}

/**
 * An amount from rupee text, through the real parser.
 *
 * Deliberately not `Money.fromPaise(10_000)`: a test that writes the amount the
 * way a treasurer types it is the test that would have caught a parser bug, and
 * `fromRupees` is the door real amounts come through.
 */
export function rupees(text: string): Money {
  const parsed = Money.fromRupees(text);
  if (!parsed.ok) {
    throw new Error(`bad fixture amount "${text}": ${parsed.error.message}`);
  }
  return parsed.value;
}

/** The paise of each part, as strings, so an assertion reads like a ledger. */
export function partsToPaise(parts: readonly Money[]): string[] {
  return parts.map((part) => part.paise.toString());
}

/** The paise of each allocation, as strings. */
export function allocationsToPaise(
  allocations: readonly SplitAllocation[],
): string[] {
  return allocations.map((allocation) => allocation.amount.paise.toString());
}

/**
 * `apartmentNumber:paise` per allocation — the shape an ordering assertion reads
 * in.
 *
 * Ordering is half of what this package decides, so most tests assert on this
 * rather than on amounts alone: it pins *which* flat got the residual paisa, which
 * an assertion on the multiset of amounts cannot.
 */
export function ledger(allocations: readonly SplitAllocation[]): string[] {
  return allocations.map(
    (allocation) =>
      `${allocation.apartmentNumber}:${allocation.amount.paise.toString()}`,
  );
}

/** `Σ allocations`, in paise — the invariant every strategy is held to. */
export function sumPaise(allocations: readonly SplitAllocation[]): bigint {
  let total = 0n;
  for (const allocation of allocations) total += allocation.amount.paise;
  return total;
}

/** Unwrap a success, failing the test with the domain message if it is not one. */
export function expectOk<TValue, TError extends { message: string }>(
  result: Result<TValue, TError>,
): TValue {
  if (!result.ok)
    throw new Error(`expected success, got: ${result.error.message}`);
  return result.value;
}

/** Unwrap a failure, failing the test if the operation unexpectedly succeeded. */
export function expectErr<TValue, TError>(
  result: Result<TValue, TError>,
): TError {
  if (result.ok) {
    throw new Error(`expected a failure, got: ${JSON.stringify(result.value)}`);
  }
  return result.error;
}
