import { Money } from "@ses/domain";

import { computeSplit } from "../index";
import {
  apartmentFlat,
  expectErr,
  expectOk,
  ledger,
  rupees,
  sumPaise,
} from "./fixtures";

/**
 * `per_sqft_carpet` and `per_sqft_builtup` (PRD §3.5.4, Roadmap T058) — "the most
 * common fair method for maintenance in India".
 *
 * The roadmap's own two cases are here: mixed areas summing exactly, and three
 * apartments with a null area producing one `MISSING_AREA` warning that lists
 * their ids. Everything else is the arithmetic that has to hold around them —
 * which field is read, what an impossible area does, and where the residual paisa
 * lands.
 */
describe("per_sqft bases", () => {
  it("splits ₹12,000 in proportion to carpet area", () => {
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_carpet",
        amount: rupees("12000"),
        participants: [
          apartmentFlat("101", { carpetAreaSqft: 600 }),
          apartmentFlat("102", { carpetAreaSqft: 900 }),
          apartmentFlat("103", { carpetAreaSqft: 1500 }),
        ],
      }),
    );

    // 600 : 900 : 1500 of ₹12,000 — three exact shares, because the weights are
    // the areas in hundredths (60,000 : 90,000 : 150,000) and the division happens
    // once, in integers.
    expect(ledger(result.allocations)).toEqual([
      "101:240000",
      "102:360000",
      "103:600000",
    ]);
    expect(result.allocations.map((allocation) => allocation.weight)).toEqual([
      60_000n,
      90_000n,
      150_000n,
    ]);
    expect(result.residualPaise).toBe(0n);
    expect(result.warnings).toEqual([]);
  });

  it("splits exactly when the areas have decimals", () => {
    // 100.5 : 199.5 sqft of ₹1,000 — 33,500 and 66,500 paise. A float
    // implementation of this division is the one that needs `toBeCloseTo`.
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_carpet",
        amount: rupees("1000"),
        participants: [
          apartmentFlat("101", { carpetAreaSqft: 100.5 }),
          apartmentFlat("102", { carpetAreaSqft: 199.5 }),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:33500", "102:66500"]);
    expect(sumPaise(result.allocations)).toBe(100_000n);
  });

  it("sums exactly over a building of mixed areas", () => {
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_carpet",
        amount: rupees("60000"),
        participants: [
          apartmentFlat("101", { carpetAreaSqft: 520.5 }),
          apartmentFlat("102", { carpetAreaSqft: 640.25 }),
          apartmentFlat("103", { carpetAreaSqft: 711 }),
          apartmentFlat("104", { carpetAreaSqft: 899.99 }),
          apartmentFlat("105", { carpetAreaSqft: 1000.01 }),
          apartmentFlat("106", { carpetAreaSqft: 1250.5 }),
        ],
      }),
    );

    expect(sumPaise(result.allocations)).toBe(6_000_000n);
    expect(result.residualPaise).toBe(0n);
    // The biggest flat pays the most, and nobody pays more than the expense.
    expect(result.allocations[5]?.amount.paise).toBeGreaterThan(
      result.allocations[0]?.amount.paise ?? 0n,
    );
    for (const allocation of result.allocations) {
      expect(allocation.amount.paise).toBeLessThanOrEqual(6_000_000n);
    }
  });

  it("puts the residual paisa on the largest area", () => {
    // 100.00 : 100.00 : 100.01 of ₹100. The third flat's remainder is the largest
    // (16,667 of 30,001 against 6,667), so it takes the single leftover paisa —
    // the mirror image of an equal split, where the lowest number gets it.
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_carpet",
        amount: rupees("100"),
        participants: [
          apartmentFlat("101", { carpetAreaSqft: 100 }),
          apartmentFlat("102", { carpetAreaSqft: 100 }),
          apartmentFlat("103", { carpetAreaSqft: 100.01 }),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual([
      "101:3333",
      "102:3333",
      "103:3334",
    ]);
  });

  it("reads the built-up area for per_sqft_builtup", () => {
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_builtup",
        amount: rupees("1200"),
        participants: [
          apartmentFlat("101", { builtupAreaSqft: 900 }),
          apartmentFlat("102", { builtupAreaSqft: 300 }),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:90000", "102:30000"]);
    expect(result.allocations.map((allocation) => allocation.weight)).toEqual([
      90_000n,
      30_000n,
    ]);
  });

  it("excludes exactly the flats the chosen field is missing for", () => {
    // A flat with a built-up area but no carpet area is weighable by one basis and
    // not the other, which is the whole reason the two are separate bases.
    const participants = [
      apartmentFlat("101", { carpetAreaSqft: null, builtupAreaSqft: 800 }),
      apartmentFlat("102", { carpetAreaSqft: 600, builtupAreaSqft: 750 }),
    ];

    const carpet = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_carpet",
        amount: rupees("100"),
        participants,
      }),
    );
    expect(ledger(carpet.allocations)).toEqual(["102:10000"]);
    expect(carpet.warnings.map((warning) => warning.code)).toEqual([
      "MISSING_AREA",
    ]);

    const builtup = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_builtup",
        amount: rupees("1000"),
        participants,
      }),
    );
    expect(ledger(builtup.allocations)).toEqual(["101:51613", "102:48387"]);
    expect(builtup.warnings).toEqual([]);
  });

  it("excludes three flats with no carpet area and warns once with their ids", () => {
    // The roadmap's case, verbatim: one warning, three ids, and the ledger still
    // sums to the expense over the flats that were weighed.
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_carpet",
        amount: rupees("60000"),
        participants: [
          apartmentFlat("101", { carpetAreaSqft: 700 }),
          apartmentFlat("102", { carpetAreaSqft: null }),
          apartmentFlat("103", { carpetAreaSqft: null }),
          apartmentFlat("104", { carpetAreaSqft: 800 }),
          apartmentFlat("105", { carpetAreaSqft: null }),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:2800000", "104:3200000"]);
    expect(sumPaise(result.allocations)).toBe(6_000_000n);
    expect(result.warnings).toEqual([
      {
        code: "MISSING_AREA",
        message: "3 apartments were excluded: no area recorded.",
        apartmentIds: ["apartment-102", "apartment-103", "apartment-105"],
      },
    ]);
  });

  it('says "1 apartment was excluded" when only one was', () => {
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_carpet",
        amount: rupees("100"),
        participants: [
          apartmentFlat("101", { carpetAreaSqft: 600 }),
          apartmentFlat("102", { carpetAreaSqft: null }),
        ],
      }),
    );

    expect(result.warnings[0]?.message).toBe(
      "1 apartment was excluded: no area recorded.",
    );
  });

  it("refuses an area outside the column's bounds", () => {
    const cases = [
      { area: 0, why: "zero" },
      { area: -5, why: "negative" },
      { area: 100_001, why: "over the column's bound" },
      { area: Number.NaN, why: "NaN" },
      { area: Number.POSITIVE_INFINITY, why: "infinite" },
    ];

    for (const { area, why } of cases) {
      const error = expectErr(
        computeSplit({
          strategy: "apartment",
          basis: "per_sqft_carpet",
          amount: rupees("100"),
          participants: [apartmentFlat("101", { carpetAreaSqft: area })],
        }),
      );

      // The `why` is carried into the assertion so a failure names the case
      // instead of printing five identical-looking expectations.
      expect({
        why,
        code: error.code,
        field: error.details?.field,
        flat: error.details?.apartmentId,
      }).toEqual({
        why,
        code: "validation",
        field: "participants.carpetAreaSqft",
        flat: "apartment-101",
      });
      expect(error.message).toContain("Carpet area must be between");
    }
  });

  it("refuses an area finer than the column", () => {
    // `numeric(8, 2)` holds two decimals. `0.1 + 0.2` is the case that matters:
    // the value has *already* drifted, so rounding it into a weight would be
    // inventing a measurement nobody made.
    for (const area of [600.005, 0.1 + 0.2]) {
      const error = expectErr(
        computeSplit({
          strategy: "apartment",
          basis: "per_sqft_carpet",
          amount: rupees("100"),
          participants: [apartmentFlat("101", { carpetAreaSqft: area })],
        }),
      );

      expect(error.code).toBe("validation");
      expect(error.message).toContain("at most 2 decimal places");
    }
  });

  it("conserves an amount beyond the safe integer range", () => {
    // 2^60 paise against the column's largest areas (100,000 sqft each, i.e.
    // 10,000,000 hundredths). Both sides of the division are bigint.
    const amount = Money.fromPaise(2n ** 60n);
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_carpet",
        amount,
        participants: [
          apartmentFlat("101", { carpetAreaSqft: 100_000 }),
          apartmentFlat("102", { carpetAreaSqft: 100_000 }),
          apartmentFlat("103", { carpetAreaSqft: 1 }),
        ],
      }),
    );

    expect(sumPaise(result.allocations)).toBe(2n ** 60n);
    expect(result.residualPaise).toBe(0n);
  });

  it("is a function of the participant set, not of the array order", () => {
    const participants = [
      apartmentFlat("103", { carpetAreaSqft: 1000 }),
      apartmentFlat("101", { carpetAreaSqft: 500 }),
      apartmentFlat("102", { carpetAreaSqft: 700 }),
    ];

    const forward = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_carpet",
        amount: rupees("100.01"),
        participants,
      }),
    );
    const reversed = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_carpet",
        amount: rupees("100.01"),
        participants: [...participants].reverse(),
      }),
    );

    expect(ledger(reversed.allocations)).toEqual(ledger(forward.allocations));
  });
});
