import {
  AREA_MAX_SQFT,
  BHK_MAX,
  BHK_MIN,
  FLOOR_MAX,
  FLOOR_MIN,
  Money,
  PARKING_SLOTS_MAX,
  PARKING_SLOTS_MIN,
} from "@ses/domain";
import fc from "fast-check";

import {
  MAX_SHARE_UNITS,
  PERCENT_TOTAL_BASIS_POINTS,
  basisPoints,
  computeSplit,
  shareUnits,
} from "../index";
import type {
  ApartmentBasis,
  ApartmentParticipant,
  BasisPoints,
  CustomParticipant,
  FloorBand,
  ShareUnits,
  SplitAllocation,
  SplitInput,
  SplitResult,
  SplitWarningCode,
} from "../index";
import { expectErr, expectOk, flat, ledger, sumPaise } from "./fixtures";

/**
 * The engine's invariants, over generated input (Roadmap T059, SAD §15.2).
 *
 * ## What this adds to T056–T058, and what it deliberately leaves alone
 *
 * The suites beside this file are **examples**: a chosen amount, a chosen building,
 * and the ledger the requirement says should come out — including an exhaustive
 * sweep of every amount from 1 to 200 paise across 1 to 12 participants and a
 * 2^60-paise conservation case. Every one of them stays exactly as it is. What no
 * example can do is speak for the input nobody thought of, which is why the PRD
 * makes this suite non-negotiable and why this is the one package with a 100%
 * branch gate:
 *
 * > The split engine has property-based tests (fast-check): for any amount and any
 * > participant set, allocations always sum exactly to the total and the result is
 * > deterministic. (PRD §18.4)
 *
 * ## The invariants, asserted together on every generated case
 *
 * Roadmap T059 names four; {@link expectInvariants} checks them, plus two that come
 * free on input that is already generated and that decide whether a *published* bill
 * is stable, for every strategy and every basis:
 *
 * 1. **Conservation** — `Σ allocations === amount`, exactly, in paise. Both sides
 *    are `bigint`; there is no epsilon to choose and no float to be close in.
 * 2. **Determinism** — the same input produces a deeply equal result.
 * 3. **Non-negativity** — no allocation is negative.
 * 4. **Zero residual** — the rounding rule placed every paisa it produced.
 * 5. **Order invariance** — the same logical participants in another array order
 *    produce the same `apartmentNumber → paise` mapping, and the same warnings.
 * 6. **Stable warnings** — a strategy that reads no nullable fact never warns.
 *
 * The second block is the specification as an oracle: each basis's weights must be
 * the documented column in the column's own scale. That is the property a mutation
 * has to break, and it is stated independently of the engine on purpose — a weight
 * property that asked the engine what the weight should be would prove only that the
 * engine agrees with itself.
 *
 * ## 10,000 cases per strategy
 *
 * SAD §15.2 ("Run with 10,000 iterations in CI") and Roadmap T059 ("All four
 * invariants green across 10,000 cases per strategy") both name the number, so
 * {@link RUNS} *is* that number for every invariant, weight, metamorphic and warning
 * property. Only the properties that generate deliberately enormous input — a
 * 500-flat building, a 2^60-paise amount against the columns' largest values — and
 * the properties whose subject is a *refusal* rather than an allocation run
 * {@link SUPPLEMENTARY_RUNS}: fewer cases, not smaller ones, stated here rather than
 * left to be inferred from a stopwatch.
 *
 * ## A failure reproduces from its own report
 *
 * fast-check prints the seed, the path, the counterexample and how far it shrank, so
 * a CI failure can be replayed case-for-case:
 *
 * ```bash
 * FC_SEED=1681903501 pnpm --filter @ses/split-engine test:property
 * ```
 *
 * `FC_SEED` below hands that seed to every property in this file, so the whole suite
 * replays the failing sequence rather than one property of it.
 *
 * Nothing here is random in the production sense: the generators are the only source
 * of variation, the engine's output is compared with the engine's own output, and
 * `docs/guides/SPLIT_ENGINE.md` §9 records that no clock, seed or I/O exists inside
 * the package.
 */

/** SAD §15.2 / Roadmap T059: 10,000 generated cases per strategy and basis. */
const RUNS = 10_000;

/** For enormous input and for refusals; the run count is the only thing reduced. */
const SUPPLEMENTARY_RUNS = 2_000;

/** The largest building the invariant properties generate. SAD §15.2's example allows 500. */
const MAX_PARTICIPANTS = 40;

/** Small enough that a refused case prints as a two-line counterexample. */
const MAX_SMALL_PARTICIPANTS = 6;

/** ₹1 crore in paise — the ceiling SAD §15.2's own property example draws from. */
const MAX_AMOUNT_PAISE = 1_000_000_000n;

/** Past `Number.MAX_SAFE_INTEGER`: the amount a bigint engine must still get exactly right. */
const HUGE_AMOUNT_PAISE = 2n ** 60n;

/** The flats a boundary property may ask about: SAD §15.2's own maximum. */
const MAX_BUILDING_PARTICIPANTS = 500;

/**
 * Replay a failure from the `{ seed, path }` its report printed, without editing
 * this file. Absent in the ordinary case, where fast-check seeds from the clock.
 *
 * Read through `globalThis` rather than `process`, because this package's
 * `tsconfig` narrows `types` to `["jest"]`: a test here may not assume Node's
 * ambient globals, and `fast-check` needs no Node to run.
 */
const replaySeed = (
  globalThis as {
    readonly process?: { readonly env?: { readonly FC_SEED?: string } };
  }
).process?.env?.FC_SEED;

if (replaySeed !== undefined && replaySeed !== "") {
  fc.configureGlobal({ seed: Number(replaySeed) });
}

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An amount the engine must accept: whole paise, at least one, up to ₹1 crore.
 *
 * Built with `Money.fromPaise`, so a generated amount is one a caller could hold
 * rather than a bare bigint the engine would have to interpret.
 */
const arbAmount = fc
  .bigInt({ min: 1n, max: MAX_AMOUNT_PAISE })
  .map((paise) => Money.fromPaise(paise));

/** A whole number of hundredths, divided once so the value has the column's scale. */
function hundredths(min: number, max: number): fc.Arbitrary<number> {
  return fc.integer({ min, max }).map((value) => value / 100);
}

/** A whole number of tenths, divided once: `numeric(3, 1)`. */
function tenths(min: number, max: number): fc.Arbitrary<number> {
  return fc.integer({ min, max }).map((value) => value / 10);
}

/**
 * A carpet or built-up area: `(0, 100000]` sq ft at two decimals.
 *
 * The bound is the domain's own constant rather than a literal, so a change to
 * `AREA_MAX_SQFT` moves the generator with it instead of leaving this file
 * asserting yesterday's column.
 */
const arbArea = hundredths(1, AREA_MAX_SQFT * 100);

/** A configuration: `[0.5, 20]` BHK at one decimal, which is the column's scale. */
const arbBhk = tenths(BHK_MIN * 10, BHK_MAX * 10);

/** A floor, or `null` for "not recorded" — the two states the column distinguishes. */
const arbFloor = fc.option(fc.integer({ min: FLOOR_MIN, max: FLOOR_MAX }), {
  nil: null,
});

/** The facts the six bases read: each absent or valid, never impossible. */
interface ApartmentFacts {
  readonly floor: number | null;
  readonly carpetAreaSqft: number | null;
  readonly builtupAreaSqft: number | null;
  readonly bhk: number | null;
  readonly parkingSlots: number;
}

const arbApartmentFacts: fc.Arbitrary<ApartmentFacts> = fc.record({
  floor: arbFloor,
  carpetAreaSqft: fc.option(arbArea, { nil: null }),
  builtupAreaSqft: fc.option(arbArea, { nil: null }),
  bhk: fc.option(arbBhk, { nil: null }),
  // `smallint NOT NULL DEFAULT 0`: a slot count is never *missing*, and `0` is a
  // legitimate weight — a flat with no allotted slot owes nothing from a parking
  // charge — rather than an unrecorded fact.
  parkingSlots: fc.integer({ min: PARKING_SLOTS_MIN, max: PARKING_SLOTS_MAX }),
});

/** A participant carrying apartment facts under its own identity. */
function apartmentParticipant(
  number: string,
  facts: ApartmentFacts,
): ApartmentParticipant {
  return { ...flat(number), ...facts };
}

/** A building's worth of apartment facts. */
const arbApartmentBuildings: fc.Arbitrary<readonly ApartmentFacts[]> = fc.array(
  arbApartmentFacts,
  { minLength: 1, maxLength: MAX_PARTICIPANTS },
);

/**
 * A fair split of `total` into `cuts.length + 1` non-negative parts that sum to
 * `total` **exactly**.
 *
 * The constructive alternative to generating values and rejecting the ones that do
 * not add up: percentages must total 100% and a custom split must total the expense,
 * and a generator that *partitions* the total cannot produce an invalid case to
 * filter out. Sorting the cut points and taking differences is a random composition,
 * and — because it is a pure function of generated data — it shrinks like any other
 * generator.
 */
function composition(
  total: bigint,
  cuts: readonly bigint[],
): readonly bigint[] {
  // Each cut is clamped into `[0, total]` so the parts always sum to `total`: a cut
  // above the total would otherwise become the largest point and the differences
  // would sum to the *cut* rather than to the total.
  const clamped = cuts.map((cut) =>
    cut < 0n ? 0n : cut > total ? total : cut,
  );
  const points = [0n, ...clamped, total].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  return points
    .slice(0, -1)
    .map((point, index) => (points[index + 1] ?? total) - point);
}

/** A percentage spread over the participants, totalling exactly 100%. */
const arbPercentageParts: fc.Arbitrary<readonly bigint[]> = fc
  .array(fc.bigInt({ min: 0n, max: PERCENT_TOTAL_BASIS_POINTS }), {
    minLength: 1,
    maxLength: MAX_PARTICIPANTS - 1,
  })
  .map((cuts) => composition(PERCENT_TOTAL_BASIS_POINTS, cuts));

/** Share counts, in thousandths of a share, one per participant. */
const arbShareParts: fc.Arbitrary<readonly bigint[]> = fc.array(
  fc.bigInt({ min: 1n, max: MAX_SHARE_UNITS }),
  { minLength: 1, maxLength: MAX_PARTICIPANTS },
);

/** The same list in another array order, from generated keys rather than `Math.random`. */
function permute<T>(
  items: readonly T[],
  key: (item: T) => number,
): readonly T[] {
  return [...items].sort((left, right) => key(left) - key(right));
}

/** `count` distinct apartment numbers from `first` — identity by construction. */
function numbersFrom(first: number, count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => String(first + index));
}

/** One flat's number and the fact that decides its weight. */
interface NumberedFact<TFact> {
  readonly number: string;
  readonly fact: TFact;
}

/** A generated building, in the caller's order and in another order. */
interface Building<TFact> {
  readonly straight: readonly NumberedFact<TFact>[];
  readonly shuffled: readonly NumberedFact<TFact>[];
}

/**
 * Participants for `n` flats: one generated fact each, distinct apartment numbers,
 * and the same logical building in a second array order.
 *
 * The facts arbitrary decides how many flats there are (its length *is* the count),
 * and the permutation is generated data rather than a call to `Math.random`, so a
 * failure still shrinks to a small counterexample and still reproduces from its seed.
 */
function arbBuilding<TFact>(
  arbFacts: fc.Arbitrary<readonly TFact[]>,
): fc.Arbitrary<Building<TFact>> {
  return arbFacts.chain((facts) =>
    fc
      .tuple(
        fc.integer({ min: 1, max: 9_000 }),
        fc.array(fc.nat(), {
          minLength: facts.length,
          maxLength: facts.length,
        }),
      )
      .map(([first, keys]) => {
        const numbered = facts.map((fact, index) => ({
          number: String(first + index),
          fact,
          key: keys[index] ?? 0,
        }));

        return {
          straight: numbered.map(({ number, fact }) => ({ number, fact })),
          shuffled: permute(numbered, (entry) => entry.key).map(
            ({ number, fact }) => ({ number, fact }),
          ),
        };
      }),
  );
}

/**
 * The same facts with the first flat's nullable attributes recorded.
 *
 * Two guarantees are what make the invariant properties *unconditional* rather than
 * a branch between "refused" and "allocated": at least one flat is included, and at
 * least one weight is positive. A property that accepted either outcome would be
 * satisfied by an engine that refused everything, which is the failure mode worth
 * designing out. Refusals have properties of their own below, where they are
 * asserted to be exactly the right refusal.
 */
function withUsableFirst(
  facts: readonly ApartmentFacts[],
): readonly ApartmentFacts[] {
  const [first, ...rest] = facts;
  if (first === undefined) return facts;

  return [
    {
      floor: first.floor ?? 1,
      carpetAreaSqft: first.carpetAreaSqft ?? 600,
      builtupAreaSqft: first.builtupAreaSqft ?? 750,
      bhk: first.bhk ?? 2,
      parkingSlots: Math.max(first.parkingSlots, 1),
    },
    ...rest,
  ];
}

/** The two inputs that must agree: the building, and the building reordered. */
interface StrategyCase {
  readonly input: SplitInput;
  readonly shuffled: SplitInput;
}

/**
 * One strategy's case generator: a building of facts, and the two inputs built from
 * it, so every invariant property asserts on both.
 *
 * `make` receives the amount and the numbered facts and returns the strategy's own
 * input, which keeps each participant type's shape visible at the call site instead
 * of hidden behind a cast.
 */
function casesFor<TFact>(
  arbFacts: fc.Arbitrary<readonly TFact[]>,
  make: (amount: Money, entries: readonly NumberedFact<TFact>[]) => SplitInput,
): fc.Arbitrary<StrategyCase> {
  return fc
    .tuple(arbAmount, arbBuilding(arbFacts))
    .map(([amount, building]) => ({
      input: make(amount, building.straight),
      shuffled: make(amount, building.shuffled),
    }));
}

/** A building with no per-participant fact: `equal` and `per_flat` read nothing. */
const noFacts = fc.array(fc.constant(null), {
  minLength: 1,
  maxLength: MAX_PARTICIPANTS,
});

const arbEqualCase = casesFor(noFacts, (amount, entries) => ({
  strategy: "equal",
  amount,
  participants: entries.map((entry) => flat(entry.number)),
}));

const arbPercentageCase = casesFor(arbPercentageParts, (amount, entries) => ({
  strategy: "percentage",
  amount,
  participants: entries.map((entry) => ({
    ...flat(entry.number),
    percentage: basisPoints(entry.fact),
  })),
}));

const arbSharesCase = casesFor(arbShareParts, (amount, entries) => ({
  strategy: "shares",
  amount,
  participants: entries.map((entry) => ({
    ...flat(entry.number),
    share: shareUnits(entry.fact),
  })),
}));

/**
 * A custom split that always adds up, by construction: the parts *are* a partition
 * of the amount, so the sum check is never the thing under test here.
 *
 * Built from `arbBuilding` directly rather than through {@link casesFor}, because the
 * parts depend on the amount the case itself carries.
 */
const arbCustomCase: fc.Arbitrary<StrategyCase> = arbAmount.chain((amount) =>
  arbBuilding(
    fc
      .array(fc.bigInt({ min: 0n, max: amount.paise }), {
        minLength: 1,
        maxLength: MAX_PARTICIPANTS - 1,
      })
      .map((cuts) => composition(amount.paise, cuts)),
  ).map((building) => {
    const make = (entries: readonly NumberedFact<bigint>[]): SplitInput => ({
      strategy: "custom",
      amount,
      participants: entries.map((entry) => ({
        ...flat(entry.number),
        amount: Money.fromPaise(entry.fact),
      })),
    });

    return {
      input: make(building.straight),
      shuffled: make(building.shuffled),
    };
  }),
);

/** The five bases whose weight is a fact carried on the participant. */
type AttributeBasis = Exclude<ApartmentBasis, "per_floor_band">;

const ATTRIBUTE_BASES = [
  "per_flat",
  "per_sqft_carpet",
  "per_sqft_builtup",
  "per_bhk",
  "per_parking_slot",
] as const satisfies readonly ApartmentBasis[];

/** One attribute basis, over buildings whose first flat is always weighable. */
function arbAttributeCase(basis: AttributeBasis): fc.Arbitrary<StrategyCase> {
  return casesFor(
    arbApartmentBuildings.map(withUsableFirst),
    (amount, entries) => ({
      strategy: "apartment",
      basis,
      amount,
      participants: entries.map((entry) =>
        apartmentParticipant(entry.number, entry.fact),
      ),
    }),
  );
}

/**
 * A band table the engine accepts: contiguous, whole floors inside the domain's
 * range, multipliers at the thousandths scale, and **not sorted** — the table is
 * configuration, so the order it arrives in must not matter.
 *
 * `minThousandths` decides whether `0×` bands are allowed: the invariant property
 * wants them (they are the exemption), while the warning property does not (an
 * all-`0×` table is refused before it can warn about anybody).
 */
function arbBandsWith(
  minThousandths: number,
): fc.Arbitrary<readonly FloorBand[]> {
  return fc
    .tuple(
      fc.integer({ min: FLOOR_MIN, max: FLOOR_MAX }),
      fc.array(
        fc.tuple(
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: minThousandths, max: 3_000 }),
          fc.nat(),
        ),
        { minLength: 1, maxLength: 5 },
      ),
    )
    .map(([start, specs]) => {
      const built: { readonly band: FloorBand; readonly key: number }[] = [];
      let from = start;

      for (const [length, thousandths, key] of specs) {
        const to = Math.min(from + length - 1, FLOOR_MAX);
        if (to < from) break;
        built.push({ band: { from, to, mult: thousandths / 1_000 }, key });
        from = to + 1;
        if (from > FLOOR_MAX) break;
      }

      return built
        .sort((left, right) => left.key - right.key)
        .map((entry) => entry.band);
    });
}

/** A table that may include `0×` bands: the exemption, for the invariant properties. */
const arbBands = arbBandsWith(0);

/** A table whose every multiplier is positive, for properties about *whom* is warned. */
const arbPositiveBands = arbBandsWith(1);

/**
 * A band table that is guaranteed to weigh the first flat **positively**.
 *
 * The generated table would otherwise be able to put every flat in a `0×` band,
 * which the engine refuses (nothing to divide by) — a real case, but not this
 * property's subject. The repair is a pure function of the generated data: if no
 * band gives the first flat a positive multiplier, the band covering that floor (at
 * most one, since bands cannot overlap) is replaced by a single-floor band worth
 * `1×`, which cannot overlap anything the generator produced.
 */
function withPositiveFirstFloor(
  bands: readonly FloorBand[],
  floor: number | null,
): readonly FloorBand[] {
  if (floor === null) return bands;
  const covering = bands.filter(
    (band) => floor >= band.from && floor <= band.to,
  );
  if (covering.some((band) => band.mult > 0)) return bands;

  return [
    ...bands.filter((band) => !(floor >= band.from && floor <= band.to)),
    { from: floor, to: floor, mult: 1 },
  ];
}

const arbFloorBandCase: fc.Arbitrary<StrategyCase> = fc
  .tuple(
    arbAmount,
    arbBuilding(arbApartmentBuildings.map(withUsableFirst)),
    arbBands,
  )
  .map(([amount, building, bands]) => {
    const floorBands = withPositiveFirstFloor(
      bands,
      building.straight[0]?.fact.floor ?? null,
    );

    const make = (
      entries: readonly NumberedFact<ApartmentFacts>[],
    ): SplitInput => ({
      strategy: "apartment",
      basis: "per_floor_band",
      amount,
      participants: entries.map((entry) =>
        apartmentParticipant(entry.number, entry.fact),
      ),
      floorBands,
    });

    return {
      input: make(building.straight),
      shuffled: make(building.shuffled),
    };
  });

// ─────────────────────────────────────────────────────────────────────────────
// Reading a case back, and the specification as an oracle
// ─────────────────────────────────────────────────────────────────────────────

/** An apartment case's participants. Only ever called on an apartment case. */
function apartmentFactsOf(input: SplitInput): readonly ApartmentParticipant[] {
  if (input.strategy !== "apartment") {
    throw new Error("expected an apartment split");
  }
  return input.participants;
}

/** The band table a case carries, or none when its basis does not use one. */
function bandsOf(input: SplitInput): readonly FloorBand[] {
  return input.strategy === "apartment" && input.basis === "per_floor_band"
    ? input.floorBands
    : [];
}

/**
 * The weight the specification says one flat earns under one basis, or `undefined`
 * when the flat cannot be weighed at all (its fact is not recorded, or no band covers
 * its floor).
 *
 * `undefined` and `0n` are different answers here, exactly as they are in the split
 * itself: a flat in a `0×` band is *included* owing nothing, while a flat with no
 * floor recorded is not in the result and is named in a warning.
 */
function specificationWeight(
  basis: ApartmentBasis,
  facts: ApartmentFacts,
  bands: readonly FloorBand[],
): bigint | undefined {
  switch (basis) {
    case "per_flat":
      return 1n;
    case "per_sqft_carpet":
      return facts.carpetAreaSqft === null
        ? undefined
        : BigInt(Math.round(facts.carpetAreaSqft * 100));
    case "per_sqft_builtup":
      return facts.builtupAreaSqft === null
        ? undefined
        : BigInt(Math.round(facts.builtupAreaSqft * 100));
    case "per_bhk":
      return facts.bhk === null
        ? undefined
        : BigInt(Math.round(facts.bhk * 10));
    case "per_parking_slot":
      return BigInt(facts.parkingSlots);
    case "per_floor_band": {
      const floor = facts.floor;
      if (floor === null) return undefined;
      const band = bands.find(
        (candidate) => floor >= candidate.from && floor <= candidate.to,
      );
      return band === undefined
        ? undefined
        : BigInt(Math.round(band.mult * 1_000));
    }
  }
}

/** The engine's ordering, for a set of flats whose numbers are unique. */
function inEngineOrder<T extends { readonly number: string }>(
  items: readonly T[],
): readonly T[] {
  return [...items].sort((left, right) =>
    left.number < right.number ? -1 : left.number > right.number ? 1 : 0,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The four invariants, plus order invariance, asserted on one generated case.
 *
 * `shuffled` is the same logical input in another array order: the comparison is by
 * participant identity (`apartmentNumber → paise`), never by position, because a
 * position-wise comparison would pass on an engine that allocated by array index.
 */
function expectInvariants(
  input: SplitInput,
  shuffled: SplitInput,
  options: { readonly expectNoWarnings?: boolean } = {},
): SplitResult {
  const outcome = computeSplit(input);
  const result = expectOk(outcome);

  // Invariant 1 — conservation. Exactly, in paise.
  expect(sumPaise(result.allocations)).toBe(input.amount.paise);

  // Invariant 2 — determinism. A deep equality on the whole *outcome*: allocations,
  // their weights, the echoed total, the residual, the warnings, and the `ok`/`error`
  // discrimination itself.
  expect(computeSplit(input)).toEqual(outcome);

  // Invariant 3 — non-negativity. A filter, so a failure prints the offenders.
  expect(
    result.allocations.filter((allocation) => allocation.amount.paise < 0n),
  ).toEqual([]);

  // Invariant 4 — the residual is zero: the rounding rule placed every paisa.
  expect(result.residualPaise).toBe(0n);

  // Invariant 5 — order invariance, money and warnings alike.
  const reordered = expectOk(computeSplit(shuffled));
  expect(ledger(reordered.allocations)).toEqual(ledger(result.allocations));
  expect(reordered.warnings).toEqual(result.warnings);
  expect(reordered.residualPaise).toBe(result.residualPaise);

  // Invariant 6 — a strategy that reads no nullable fact has nothing to report.
  if (options.expectNoWarnings === true) {
    expect(result.warnings).toEqual([]);
  }

  return result;
}

/** Assert one strategy's invariants across {@link RUNS} generated cases. */
function expectInvariantsOver(
  cases: fc.Arbitrary<StrategyCase>,
  options: { readonly expectNoWarnings?: boolean } = {},
): void {
  fc.assert(
    fc.property(cases, (generated) => {
      expectInvariants(generated.input, generated.shuffled, options);
    }),
    { numRuns: RUNS },
  );
}

describe("the four invariants, for every strategy and every basis", () => {
  it("equal", () => {
    expectInvariantsOver(arbEqualCase, { expectNoWarnings: true });
  });

  it("percentage", () => {
    expectInvariantsOver(arbPercentageCase, { expectNoWarnings: true });
  });

  it("shares", () => {
    expectInvariantsOver(arbSharesCase, { expectNoWarnings: true });
  });

  it("custom", () => {
    expectInvariantsOver(arbCustomCase, { expectNoWarnings: true });
  });

  for (const basis of ATTRIBUTE_BASES) {
    it(`apartment · ${basis}`, () => {
      expectInvariantsOver(arbAttributeCase(basis), {
        // `per_flat` weighs every flat by the same `1`, and a parking charge weighs
        // a flat with no allotted slot by `0` rather than by a missing fact, so
        // neither basis can ever exclude anybody.
        expectNoWarnings: basis === "per_flat" || basis === "per_parking_slot",
      });
    });
  }

  it("apartment · per_floor_band", () => {
    expectInvariantsOver(arbFloorBandCase);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Weights are the documented attribute
// ─────────────────────────────────────────────────────────────────────────────

describe("each basis weighs the documented attribute", () => {
  function expectWeightsOver(basis: ApartmentBasis): void {
    const cases =
      basis === "per_floor_band" ? arbFloorBandCase : arbAttributeCase(basis);

    fc.assert(
      fc.property(cases, (generated) => {
        const bands = bandsOf(generated.input);
        const participants = apartmentFactsOf(generated.input);
        const result = expectOk(computeSplit(generated.input));

        const expected = inEngineOrder(
          participants
            .map((participant) => ({
              number: participant.apartmentNumber,
              weight: specificationWeight(
                basis,
                {
                  floor: participant.floor,
                  carpetAreaSqft: participant.carpetAreaSqft,
                  builtupAreaSqft: participant.builtupAreaSqft,
                  bhk: participant.bhk,
                  parkingSlots: participant.parkingSlots,
                },
                bands,
              ),
            }))
            .filter((entry) => entry.weight !== undefined),
        );

        expect(
          result.allocations.map((allocation) => ({
            number: allocation.apartmentNumber,
            weight: allocation.weight,
          })),
        ).toEqual(expected);
      }),
      { numRuns: RUNS },
    );
  }

  for (const basis of ATTRIBUTE_BASES) {
    it(`${basis}`, () => {
      expectWeightsOver(basis);
    });
  }

  it("per_floor_band", () => {
    expectWeightsOver("per_floor_band");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Metamorphic properties
// ─────────────────────────────────────────────────────────────────────────────

describe("metamorphic properties", () => {
  it("per_flat is equal, weights included", () => {
    fc.assert(
      fc.property(arbAttributeCase("per_flat"), (generated) => {
        const perFlat = expectOk(computeSplit(generated.input));
        const equal = expectOk(
          computeSplit({
            strategy: "equal",
            amount: generated.input.amount,
            participants: apartmentFactsOf(generated.input).map((participant) =>
              flat(participant.apartmentNumber),
            ),
          }),
        );

        expect(ledger(perFlat.allocations)).toEqual(ledger(equal.allocations));
        expect(perFlat.allocations.map((one) => one.weight)).toEqual(
          equal.allocations.map((one) => one.weight),
        );
      }),
      { numRuns: RUNS },
    );
  });

  it("equal areas are equal weights, so per_sqft_carpet is per_flat", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          arbAmount,
          arbArea,
          fc.integer({ min: 1, max: MAX_PARTICIPANTS }),
          fc.integer({ min: 1, max: 9_000 }),
        ),
        ([amount, area, count, first]) => {
          const participants = numbersFrom(first, count).map((number) =>
            apartmentParticipant(number, {
              floor: 1,
              carpetAreaSqft: area,
              builtupAreaSqft: null,
              bhk: null,
              parkingSlots: 0,
            }),
          );

          const carpet = expectOk(
            computeSplit({
              strategy: "apartment",
              basis: "per_sqft_carpet",
              amount,
              participants,
            }),
          );
          const perFlat = expectOk(
            computeSplit({
              strategy: "apartment",
              basis: "per_flat",
              amount,
              participants,
            }),
          );

          expect(ledger(carpet.allocations)).toEqual(
            ledger(perFlat.allocations),
          );
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("scaling every carpet area by a common factor does not move money", () => {
    const cases = fc.integer({ min: 2, max: 10 }).chain((factor) =>
      arbBuilding(
        fc.array(
          fc.integer({
            min: 1,
            max: Math.floor((AREA_MAX_SQFT * 100) / factor),
          }),
          { minLength: 1, maxLength: 20 },
        ),
      ).map((building) => ({ factor, building })),
    );

    fc.assert(
      fc.property(fc.tuple(arbAmount, cases), ([amount, generated]) => {
        // The hundredths are the generated value and the division happens once, so
        // both the base and the scaled area keep the column's two decimals exactly.
        const build = (scaled: boolean): readonly ApartmentParticipant[] =>
          generated.building.straight.map(({ number, fact }) =>
            apartmentParticipant(number, {
              floor: 1,
              carpetAreaSqft: (fact * (scaled ? generated.factor : 1)) / 100,
              builtupAreaSqft: null,
              bhk: null,
              parkingSlots: 0,
            }),
          );

        const base = expectOk(
          computeSplit({
            strategy: "apartment",
            basis: "per_sqft_carpet",
            amount,
            participants: build(false),
          }),
        );
        const scaled = expectOk(
          computeSplit({
            strategy: "apartment",
            basis: "per_sqft_carpet",
            amount,
            participants: build(true),
          }),
        );

        expect(ledger(scaled.allocations)).toEqual(ledger(base.allocations));
      }),
      { numRuns: RUNS },
    );
  });

  it("scaling every share by a common factor does not move money", () => {
    const cases = fc.integer({ min: 2, max: 10 }).chain((factor) =>
      arbBuilding(
        fc.array(
          fc.bigInt({ min: 1n, max: MAX_SHARE_UNITS / BigInt(factor) }),
          {
            minLength: 1,
            maxLength: 20,
          },
        ),
      ).map((building) => ({ factor, building })),
    );

    fc.assert(
      fc.property(fc.tuple(arbAmount, cases), ([amount, generated]) => {
        const build = (scaled: boolean) =>
          generated.building.straight.map(({ number, fact }) => ({
            ...flat(number),
            share: shareUnits(fact * (scaled ? BigInt(generated.factor) : 1n)),
          }));

        const base = expectOk(
          computeSplit({
            strategy: "shares",
            amount,
            participants: build(false),
          }),
        );
        const scaled = expectOk(
          computeSplit({
            strategy: "shares",
            amount,
            participants: build(true),
          }),
        );

        expect(ledger(scaled.allocations)).toEqual(ledger(base.allocations));
      }),
      { numRuns: RUNS },
    );
  });

  it("a band table of one uniform multiplier is per_flat", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          arbAmount,
          fc.constantFrom(0.5, 1, 1.5, 2, 2.5),
          fc.array(arbApartmentFacts, {
            minLength: 1,
            maxLength: MAX_PARTICIPANTS,
          }),
        ),
        ([amount, mult, facts]) => {
          // Every floor must be recorded, or the flat is excluded and the band table
          // has nothing to weigh it by.
          const participants = facts.map((one, index) =>
            apartmentParticipant(String(101 + index), {
              ...one,
              floor: one.floor ?? 1,
            }),
          );

          const banded = expectOk(
            computeSplit({
              strategy: "apartment",
              basis: "per_floor_band",
              amount,
              participants,
              floorBands: [{ from: FLOOR_MIN, to: FLOOR_MAX, mult }],
            }),
          );
          const perFlat = expectOk(
            computeSplit({
              strategy: "apartment",
              basis: "per_flat",
              amount,
              participants,
            }),
          );

          expect(ledger(banded.allocations)).toEqual(
            ledger(perFlat.allocations),
          );
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("built-up areas in a fixed ratio to carpet are the same money", () => {
    // `carpet × 1.25` stays at the column's two decimals only when the carpet is a
    // whole number of hundredths divisible by four, so the hundredths are the
    // generated value: `4h/100` and `5h/100`.
    fc.assert(
      fc.property(
        fc.tuple(
          arbAmount,
          arbBuilding(
            fc.array(fc.integer({ min: 1, max: 2_000_000 }), {
              minLength: 1,
              maxLength: 20,
            }),
          ),
        ),
        ([amount, building]) => {
          const participants = building.straight.map(({ number, fact }) =>
            apartmentParticipant(number, {
              floor: 1,
              carpetAreaSqft: (fact * 4) / 100,
              builtupAreaSqft: (fact * 5) / 100,
              bhk: null,
              parkingSlots: 0,
            }),
          );

          const carpet = expectOk(
            computeSplit({
              strategy: "apartment",
              basis: "per_sqft_carpet",
              amount,
              participants,
            }),
          );
          const builtup = expectOk(
            computeSplit({
              strategy: "apartment",
              basis: "per_sqft_builtup",
              amount,
              participants,
            }),
          );

          expect(ledger(builtup.allocations)).toEqual(
            ledger(carpet.allocations),
          );
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("a custom split typed to another strategy's ledger reproduces it", () => {
    fc.assert(
      fc.property(arbEqualCase, (generated) => {
        const original = expectOk(computeSplit(generated.input));

        // Built from the *allocations*, not from the input array: the result is in
        // apartment order and the input need not be, so pairing by position would
        // silently hand one flat's amount to another.
        const participants: readonly CustomParticipant[] =
          original.allocations.map((allocation: SplitAllocation) => ({
            memberId: allocation.memberId,
            apartmentId: allocation.apartmentId,
            apartmentNumber: allocation.apartmentNumber,
            amount: allocation.amount,
          }));

        const typed = expectOk(
          computeSplit({
            strategy: "custom",
            amount: generated.input.amount,
            participants,
          }),
        );

        expect(ledger(typed.allocations)).toEqual(ledger(original.allocations));
        expect(typed.residualPaise).toBe(0n);
      }),
      { numRuns: RUNS },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Warnings
// ─────────────────────────────────────────────────────────────────────────────

describe("warnings", () => {
  /** `code`, then the ids, in the order the engine promises to emit them. */
  function warningsOf(
    result: SplitResult,
  ): readonly (readonly [SplitWarningCode, readonly string[]])[] {
    return result.warnings.map((warning) => [
      warning.code,
      [...warning.apartmentIds],
    ]);
  }

  it("MISSING_AREA names exactly the flats with no carpet area", () => {
    const cases = casesFor(
      fc.array(
        fc.record({
          carpetAreaSqft: fc.option(arbArea, { nil: null }),
          builtupAreaSqft: fc.option(arbArea, { nil: null }),
        }),
        { minLength: 1, maxLength: MAX_PARTICIPANTS },
      ),
      (amount, entries) => ({
        strategy: "apartment",
        basis: "per_sqft_carpet",
        amount,
        participants: entries.map((entry) =>
          apartmentParticipant(entry.number, {
            floor: null,
            carpetAreaSqft: entry.fact.carpetAreaSqft,
            builtupAreaSqft: entry.fact.builtupAreaSqft,
            bhk: null,
            parkingSlots: 0,
          }),
        ),
      }),
    );

    fc.assert(
      fc.property(cases, (generated) => {
        const participants = apartmentFactsOf(generated.input);
        const excluded = inEngineOrder(
          participants
            .filter((participant) => participant.carpetAreaSqft === null)
            .map((participant) => ({ number: participant.apartmentNumber })),
        );

        if (excluded.length === participants.length) {
          // Every flat was excluded: there is nothing to divide, so the refusal is
          // the answer and there is no warning to report.
          const error = expectErr(computeSplit(generated.input));
          expect(error.code).toBe("validation");
          expect(error.details?.field).toBe("participants");
          return;
        }

        const result = expectOk(computeSplit(generated.input));
        expect(sumPaise(result.allocations)).toBe(generated.input.amount.paise);
        expect(warningsOf(result)).toEqual(
          excluded.length === 0
            ? []
            : [
                [
                  "MISSING_AREA",
                  excluded.map((entry) => `apartment-${entry.number}`),
                ],
              ],
        );
      }),
      { numRuns: RUNS },
    );
  });

  it("MISSING_FLOOR and NO_FLOOR_BAND name exactly the flats the table cannot weigh", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          arbAmount,
          arbBuilding(arbApartmentBuildings),
          arbPositiveBands,
        ),
        ([amount, building, floorBands]) => {
          const participants = building.straight.map(({ number, fact }) =>
            apartmentParticipant(number, fact),
          );

          const unrecorded = inEngineOrder(
            participants
              .filter((participant) => participant.floor === null)
              .map((participant) => ({ number: participant.apartmentNumber })),
          );
          const unmatched = inEngineOrder(
            participants
              .filter((participant) => participant.floor !== null)
              .filter(
                (participant) =>
                  !floorBands.some(
                    (band) =>
                      participant.floor !== null &&
                      participant.floor >= band.from &&
                      participant.floor <= band.to,
                  ),
              )
              .map((participant) => ({ number: participant.apartmentNumber })),
          );

          const outcome = computeSplit({
            strategy: "apartment",
            basis: "per_floor_band",
            amount,
            participants,
            floorBands,
          });

          if (unrecorded.length + unmatched.length === participants.length) {
            const error = expectErr(outcome);
            expect(error.code).toBe("validation");
            expect(error.details?.field).toBe("participants");
            return;
          }

          const result = expectOk(outcome);
          expect(sumPaise(result.allocations)).toBe(amount.paise);

          const expected: [SplitWarningCode, readonly string[]][] = [];
          if (unrecorded.length > 0) {
            expected.push([
              "MISSING_FLOOR",
              unrecorded.map((entry) => `apartment-${entry.number}`),
            ]);
          }
          if (unmatched.length > 0) {
            expected.push([
              "NO_FLOOR_BAND",
              unmatched.map((entry) => `apartment-${entry.number}`),
            ]);
          }

          expect(warningsOf(result)).toEqual(expected);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("a table that covers every floor warns about nothing", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          arbAmount,
          fc.array(arbApartmentFacts, {
            minLength: 1,
            maxLength: MAX_PARTICIPANTS,
          }),
          fc.integer({ min: 1, max: 2_000 }),
        ),
        ([amount, facts, thousandths]) => {
          const participants = facts.map((one, index) =>
            apartmentParticipant(String(101 + index), {
              ...one,
              floor: one.floor ?? 1,
            }),
          );

          const result = expectOk(
            computeSplit({
              strategy: "apartment",
              basis: "per_floor_band",
              amount,
              participants,
              // One band spanning the whole domain: every recorded floor matches,
              // and a multiplier above zero keeps every weight positive.
              floorBands: [
                { from: FLOOR_MIN, to: FLOOR_MAX, mult: thousandths / 1_000 },
              ],
            }),
          );

          expect(result.warnings).toEqual([]);
          expect(sumPaise(result.allocations)).toBe(amount.paise);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Numeric boundaries
// ─────────────────────────────────────────────────────────────────────────────

describe("numeric boundaries", () => {
  it("conserves 2^60 paise, far past the safe integer range", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: MAX_SHARE_UNITS }), {
          minLength: 1,
          maxLength: MAX_BUILDING_PARTICIPANTS,
        }),
        (shares) => {
          const amount = Money.fromPaise(HUGE_AMOUNT_PAISE);
          // The same flat/share pairings, handed over in the opposite array order:
          // the apartment numbers, not the shares, are what move.
          const participants = shares.map((share, index) => ({
            ...flat(String(101 + index)),
            share: shareUnits(share),
          }));

          const result = expectOk(
            computeSplit({ strategy: "shares", amount, participants }),
          );
          const reversed = expectOk(
            computeSplit({
              strategy: "shares",
              amount,
              participants: [...participants].reverse(),
            }),
          );

          expect(sumPaise(result.allocations)).toBe(HUGE_AMOUNT_PAISE);
          expect(result.residualPaise).toBe(0n);
          expect(ledger(reversed.allocations)).toEqual(
            ledger(result.allocations),
          );
        },
      ),
      { numRuns: SUPPLEMENTARY_RUNS },
    );
  });

  it("conserves the columns' largest values in one building", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_PARTICIPANTS }), (count) => {
        const amount = Money.fromPaise(MAX_AMOUNT_PAISE);
        const participants = numbersFrom(101, count).map((number) =>
          apartmentParticipant(number, {
            floor: FLOOR_MAX,
            carpetAreaSqft: AREA_MAX_SQFT,
            builtupAreaSqft: AREA_MAX_SQFT,
            bhk: BHK_MAX,
            parkingSlots: PARKING_SLOTS_MAX,
          }),
        );

        for (const basis of ATTRIBUTE_BASES) {
          const result = expectOk(
            computeSplit({
              strategy: "apartment",
              basis,
              amount,
              participants,
            }),
          );

          expect(sumPaise(result.allocations)).toBe(MAX_AMOUNT_PAISE);
          expect(result.residualPaise).toBe(0n);
        }

        const banded = expectOk(
          computeSplit({
            strategy: "apartment",
            basis: "per_floor_band",
            amount,
            participants,
            floorBands: [{ from: FLOOR_MIN, to: FLOOR_MAX, mult: 3 }],
          }),
        );

        expect(sumPaise(banded.allocations)).toBe(MAX_AMOUNT_PAISE);
      }),
      { numRuns: SUPPLEMENTARY_RUNS },
    );
  });

  it("places the only paisa there is when every exact share is below it", () => {
    fc.assert(
      fc.property(
        // One paisa across a building: every exact share is below a paisa, so the
        // residual rule has to place the only paisa there is.
        fc.tuple(
          fc.integer({ min: 1, max: MAX_PARTICIPANTS }),
          fc.array(fc.bigInt({ min: 1n, max: MAX_SHARE_UNITS }), {
            minLength: 1,
            maxLength: MAX_PARTICIPANTS,
          }),
        ),
        ([count, shares]) => {
          const participants = numbersFrom(101, count).map((number, index) => ({
            ...flat(number),
            share: shareUnits(shares[index % shares.length] ?? 1n),
          }));

          const result = expectOk(
            computeSplit({
              strategy: "shares",
              amount: Money.fromPaise(1n),
              participants,
            }),
          );

          expect(sumPaise(result.allocations)).toBe(1n);
          expect(result.allocations).toHaveLength(count);
          expect(
            result.allocations.filter(
              (allocation) => allocation.amount.paise === 1n,
            ),
          ).toHaveLength(1);
        },
      ),
      { numRuns: SUPPLEMENTARY_RUNS },
    );
  });

  it("conserves the widest area ratio the columns allow", () => {
    fc.assert(
      fc.property(arbAmount, (amount) => {
        const participants = [
          apartmentParticipant("101", {
            floor: 0,
            carpetAreaSqft: AREA_MAX_SQFT,
            builtupAreaSqft: null,
            bhk: null,
            parkingSlots: 0,
          }),
          apartmentParticipant("102", {
            floor: 0,
            carpetAreaSqft: 0.01,
            builtupAreaSqft: null,
            bhk: null,
            parkingSlots: 0,
          }),
        ];

        const result = expectOk(
          computeSplit({
            strategy: "apartment",
            basis: "per_sqft_carpet",
            amount,
            participants,
          }),
        );

        // Ten million to one: the smaller flat's exact share is `amount / 10_000_001`,
        // and the largest-remainder rule can hand it exactly one more paisa — never
        // more, and never at the cost of a paisa that should have been conserved.
        const [larger, smaller] = result.allocations;
        const exact = amount.paise / 10_000_001n;

        expect(sumPaise(result.allocations)).toBe(amount.paise);
        expect(result.residualPaise).toBe(0n);
        expect([exact, exact + 1n]).toContain(smaller?.amount.paise);
        expect(larger?.amount.paise).toBe(
          amount.paise - (smaller?.amount.paise ?? 0n),
        );
      }),
      { numRuns: SUPPLEMENTARY_RUNS },
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Refusals
// ─────────────────────────────────────────────────────────────────────────────

describe("invalid input is refused rather than repaired", () => {
  it("refuses a percentage total below the documented tolerance", () => {
    const cases = fc
      .tuple(
        arbAmount,
        fc.bigInt({ min: 2n, max: 5_000n }),
        fc.array(fc.bigInt({ min: 0n, max: PERCENT_TOTAL_BASIS_POINTS }), {
          minLength: 0,
          maxLength: MAX_SMALL_PARTICIPANTS - 1,
        }),
      )
      .map(([amount, delta, cuts]) => ({
        amount,
        parts: composition(PERCENT_TOTAL_BASIS_POINTS - delta, cuts),
      }));

    fc.assert(
      fc.property(cases, ({ amount, parts }) => {
        const participants = parts.map((part, index) => ({
          ...flat(String(101 + index)),
          percentage: part as BasisPoints,
        }));

        const error = expectErr(
          computeSplit({ strategy: "percentage", amount, participants }),
        );

        expect(error.code).toBe("validation");
        expect(error.details?.field).toBe("participants.percentage");
      }),
      { numRuns: SUPPLEMENTARY_RUNS },
    );
  });

  it("accepts a percentage total inside the documented tolerance", () => {
    const cases = fc
      .tuple(
        arbAmount,
        fc.bigInt({ min: 0n, max: 1n }),
        fc.array(fc.bigInt({ min: 0n, max: PERCENT_TOTAL_BASIS_POINTS }), {
          minLength: 0,
          maxLength: MAX_SMALL_PARTICIPANTS - 1,
        }),
      )
      .map(([amount, shortfall, cuts]) => ({
        amount,
        parts: composition(PERCENT_TOTAL_BASIS_POINTS - shortfall, cuts),
      }));

    fc.assert(
      fc.property(cases, ({ amount, parts }) => {
        const participants = parts.map((part, index) => ({
          ...flat(String(101 + index)),
          percentage: part as BasisPoints,
        }));

        const result = expectOk(
          computeSplit({ strategy: "percentage", amount, participants }),
        );

        expect(sumPaise(result.allocations)).toBe(amount.paise);
        expect(result.residualPaise).toBe(0n);
      }),
      { numRuns: SUPPLEMENTARY_RUNS },
    );
  });

  it("refuses a custom split that does not add up, naming the shortfall", () => {
    const cases = arbAmount.chain((amount) =>
      fc
        .tuple(
          fc
            .array(fc.bigInt({ min: 0n, max: amount.paise }), {
              minLength: 1,
              maxLength: MAX_SMALL_PARTICIPANTS - 1,
            })
            .map((cuts) => composition(amount.paise, cuts)),
          fc.bigInt({ min: 1n, max: amount.paise }),
          fc.boolean(),
        )
        .map(([parts, delta, over]) => {
          const adjusted = [...parts];
          // Over-assign by adding to the first part, or under-assign by taking from
          // the first part that can afford it: both keep every amount non-negative,
          // so the *sum* is the only thing wrong with the input.
          const index = over ? 0 : parts.findIndex((part) => part > 0n);
          const current = adjusted[index] ?? 0n;

          adjusted[index] = over
            ? current + delta
            : current - (delta < current ? delta : current);

          return { amount, adjusted };
        }),
    );

    fc.assert(
      fc.property(cases, ({ amount, adjusted }) => {
        const sum = adjusted.reduce((total, part) => total + part, 0n);

        const outcome = computeSplit({
          strategy: "custom",
          amount,
          participants: adjusted.map((part, index) => ({
            ...flat(String(101 + index)),
            amount: Money.fromPaise(part),
          })),
        });

        if (sum === amount.paise) {
          // The adjustment happened to restore the total: accepted, and it conserves.
          const result = expectOk(outcome);
          expect(sumPaise(result.allocations)).toBe(amount.paise);
          return;
        }

        const error = expectErr(outcome);
        expect(error.code).toBe("validation");
        expect(error.details?.field).toBe("participants.amount");
        // Signed, as a string: positive is money left unassigned, negative is money
        // assigned twice. The engine must not repair either.
        expect(error.details?.shortfallPaise).toBe(
          (amount.paise - sum).toString(),
        );
      }),
      { numRuns: SUPPLEMENTARY_RUNS },
    );
  });

  it("refuses a share that is zero, negative, fractional or above the ceiling", () => {
    const impossible = fc.constantFrom<bigint | number>(
      0n,
      -1_000n,
      MAX_SHARE_UNITS + 1n,
      1.5,
      2 ** 53,
    );

    fc.assert(
      fc.property(fc.tuple(arbAmount, impossible), ([amount, share]) => {
        const error = expectErr(
          computeSplit({
            strategy: "shares",
            amount,
            participants: [
              { ...flat("101"), share: share as unknown as ShareUnits },
            ],
          }),
        );

        expect(error.code).toBe("validation");
        expect(error.details?.field).toBe("participants.share");
      }),
      { numRuns: SUPPLEMENTARY_RUNS },
    );
  });

  it("refuses an impossible apartment fact, naming the flat and the field", () => {
    const valid: ApartmentFacts = {
      floor: 1,
      carpetAreaSqft: 600,
      builtupAreaSqft: 750,
      bhk: 2,
      parkingSlots: 1,
    };

    const impossible = fc.constantFrom<{
      readonly field: keyof ApartmentFacts;
      readonly facts: ApartmentFacts;
    }>(
      { field: "carpetAreaSqft", facts: { ...valid, carpetAreaSqft: 0 } },
      { field: "carpetAreaSqft", facts: { ...valid, carpetAreaSqft: -1 } },
      {
        field: "carpetAreaSqft",
        facts: { ...valid, carpetAreaSqft: AREA_MAX_SQFT + 0.01 },
      },
      {
        field: "carpetAreaSqft",
        facts: { ...valid, carpetAreaSqft: 600.005 },
      },
      {
        field: "carpetAreaSqft",
        facts: { ...valid, carpetAreaSqft: Number.NaN },
      },
      {
        field: "carpetAreaSqft",
        facts: { ...valid, carpetAreaSqft: Number.POSITIVE_INFINITY },
      },
      { field: "builtupAreaSqft", facts: { ...valid, builtupAreaSqft: -1 } },
      { field: "bhk", facts: { ...valid, bhk: 2.25 } },
      { field: "bhk", facts: { ...valid, bhk: BHK_MAX + 0.1 } },
      { field: "bhk", facts: { ...valid, bhk: 0.4 } },
      { field: "floor", facts: { ...valid, floor: FLOOR_MIN - 1 } },
      { field: "floor", facts: { ...valid, floor: 1.5 } },
      {
        field: "parkingSlots",
        facts: { ...valid, parkingSlots: PARKING_SLOTS_MAX + 1 },
      },
      { field: "parkingSlots", facts: { ...valid, parkingSlots: -1 } },
      {
        field: "parkingSlots",
        facts: { ...valid, parkingSlots: 1.5 },
      },
    );

    const basisFor = (field: keyof ApartmentFacts): AttributeBasis => {
      switch (field) {
        case "carpetAreaSqft":
          return "per_sqft_carpet";
        case "builtupAreaSqft":
          return "per_sqft_builtup";
        case "bhk":
          return "per_bhk";
        default:
          return "per_parking_slot";
      }
    };

    fc.assert(
      fc.property(
        fc.tuple(arbAmount, impossible, fc.integer({ min: 0, max: 4 })),
        ([amount, broken, position]) => {
          // The impossible fact sits on one flat among valid ones: the engine must
          // refuse the *request* rather than quietly weighing the broken flat, and
          // the error must name both the field and the flat it came from.
          const participants = numbersFrom(101, position + 1).map(
            (number, index) =>
              apartmentParticipant(
                number,
                index === position ? broken.facts : valid,
              ),
          );

          const error = expectErr(
            computeSplit(
              broken.field === "floor"
                ? {
                    strategy: "apartment",
                    basis: "per_floor_band",
                    amount,
                    participants,
                    floorBands: [{ from: FLOOR_MIN, to: FLOOR_MAX, mult: 1 }],
                  }
                : {
                    strategy: "apartment",
                    basis: basisFor(broken.field),
                    amount,
                    participants,
                  },
            ),
          );

          expect(error.code).toBe("validation");
          expect(error.details?.field).toBe(`participants.${broken.field}`);
          expect(error.details?.apartmentId).toBe(
            `apartment-${101 + position}`,
          );
        },
      ),
      { numRuns: SUPPLEMENTARY_RUNS },
    );
  });

  it("refuses a malformed band table", () => {
    const malformed = fc.constantFrom<readonly FloorBand[]>(
      [],
      [{ from: 5, to: 2, mult: 1 }],
      [
        { from: 0, to: 3, mult: 1 },
        { from: 3, to: 5, mult: 1 },
      ],
      [{ from: FLOOR_MIN - 1, to: 3, mult: 1 }],
      [{ from: 1, to: FLOOR_MAX + 1, mult: 1 }],
      [{ from: 1.5, to: 3, mult: 1 }],
      [{ from: 1, to: 3, mult: -1 }],
      [{ from: 1, to: 3, mult: 1.0005 }],
      [{ from: 1, to: 3, mult: Number.NaN }],
    );

    fc.assert(
      fc.property(fc.tuple(arbAmount, malformed), ([amount, floorBands]) => {
        const error = expectErr(
          computeSplit({
            strategy: "apartment",
            basis: "per_floor_band",
            amount,
            participants: [
              apartmentParticipant("101", {
                floor: 1,
                carpetAreaSqft: 600,
                builtupAreaSqft: 750,
                bhk: 2,
                parkingSlots: 1,
              }),
            ],
            floorBands,
          }),
        );

        expect(error.code).toBe("validation");
        expect(error.details?.field).toBe("floorBands");
      }),
      { numRuns: SUPPLEMENTARY_RUNS },
    );
  });

  it("refuses a split in which every weight is zero", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          arbAmount,
          fc.array(arbApartmentFacts, {
            minLength: 1,
            maxLength: MAX_SMALL_PARTICIPANTS,
          }),
          fc.constantFrom("per_floor_band", "per_parking_slot"),
        ),
        ([amount, facts, basis]) => {
          const participants = facts.map((one, index) =>
            apartmentParticipant(String(101 + index), {
              ...one,
              floor: 1,
              parkingSlots: 0,
            }),
          );

          const error = expectErr(
            computeSplit(
              basis === "per_floor_band"
                ? {
                    strategy: "apartment",
                    basis,
                    amount,
                    participants,
                    // Every floor in one `0×` band: exempt for everyone, which
                    // leaves nothing to divide by.
                    floorBands: [{ from: FLOOR_MIN, to: FLOOR_MAX, mult: 0 }],
                  }
                : { strategy: "apartment", basis, amount, participants },
            ),
          );

          expect(error.code).toBe("validation");
          expect(error.details?.field).toBe("participants");
          expect(error.message).toContain("positive weight");
        },
      ),
      { numRuns: SUPPLEMENTARY_RUNS },
    );
  });

  it("refuses a split in which every flat was excluded", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          arbAmount,
          fc.integer({ min: 1, max: MAX_SMALL_PARTICIPANTS }),
          fc.constantFrom("per_sqft_carpet", "per_sqft_builtup", "per_bhk"),
        ),
        ([amount, count, basis]) => {
          const participants = numbersFrom(101, count).map((number) =>
            apartmentParticipant(number, {
              floor: null,
              carpetAreaSqft: null,
              builtupAreaSqft: null,
              bhk: null,
              parkingSlots: 0,
            }),
          );

          const error = expectErr(
            computeSplit({
              strategy: "apartment",
              basis,
              amount,
              participants,
            }),
          );

          expect(error.code).toBe("validation");
          expect(error.details?.field).toBe("participants");
        },
      ),
      { numRuns: SUPPLEMENTARY_RUNS },
    );
  });

  it("refuses the same member and flat twice", () => {
    fc.assert(
      fc.property(
        fc.tuple(arbAmount, fc.integer({ min: 1, max: 20 })),
        ([amount, count]) => {
          const participants = [
            ...numbersFrom(101, count).map((number) => flat(number)),
            flat("101"),
          ];

          const error = expectErr(
            computeSplit({ strategy: "equal", amount, participants }),
          );

          expect(error.code).toBe("conflict");
        },
      ),
      { numRuns: SUPPLEMENTARY_RUNS },
    );
  });
});
