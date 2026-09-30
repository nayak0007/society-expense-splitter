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
 * `per_bhk` (PRD §3.5.4, Roadmap T058) — the configuration is the weight.
 *
 * It is the same ratio the PRD's shares example uses for its BHK tiers, with the
 * number coming from the flat's record instead of from a treasurer's typing, so
 * the tests here are about *reading* it faithfully: whole and half configurations,
 * the tenths scale, and what happens when the configuration was never filled in.
 */
describe("per_bhk basis", () => {
  it("weighs a 3 BHK flat three times a 1 BHK flat", () => {
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_bhk",
        amount: rupees("60000"),
        participants: [
          apartmentFlat("101", { bhk: 3 }),
          apartmentFlat("102", { bhk: 2 }),
          apartmentFlat("103", { bhk: 1 }),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual([
      "101:3000000",
      "102:2000000",
      "103:1000000",
    ]);
    expect(result.allocations.map((allocation) => allocation.weight)).toEqual([
      30n,
      20n,
      10n,
    ]);
    expect(result.residualPaise).toBe(0n);
    expect(result.warnings).toEqual([]);
  });

  it("supports a half configuration — 1.5 BHK weighs 15", () => {
    // Real configurations are 1.5 BHK; the column is `numeric(3, 1)` and the
    // weight keeps that scale, so 1.5 : 0.5 is 15 : 5 and the money is exact.
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_bhk",
        amount: rupees("100"),
        participants: [
          apartmentFlat("101", { bhk: 1.5 }),
          apartmentFlat("102", { bhk: 0.5 }),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:7500", "102:2500"]);
  });

  it("puts the residual paisa on the largest fractional remainder", () => {
    // 3 : 2 : 1 BHK of ₹1 — 50, 33 and 16 paise floor, with remainders 0, 20 and
    // 40 of 60, so the single leftover paisa goes to the *smallest* flat.
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_bhk",
        amount: rupees("1"),
        participants: [
          apartmentFlat("101", { bhk: 3 }),
          apartmentFlat("102", { bhk: 2 }),
          apartmentFlat("103", { bhk: 1 }),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:50", "102:33", "103:17"]);
    expect(sumPaise(result.allocations)).toBe(100n);
  });

  it("excludes a flat with no configuration and warns", () => {
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_bhk",
        amount: rupees("100"),
        participants: [
          apartmentFlat("101", { bhk: 2 }),
          apartmentFlat("102", { bhk: null }),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:10000"]);
    expect(result.warnings).toEqual([
      {
        code: "MISSING_BHK",
        message: "1 apartment was excluded: no BHK configuration recorded.",
        apartmentIds: ["apartment-102"],
      },
    ]);
  });

  it("refuses a configuration that could not have come from the column", () => {
    const cases = [
      { bhk: 0, why: "below the smallest configuration" },
      { bhk: 20.5, why: "over the column's bound" },
      { bhk: 2.25, why: "finer than numeric(3, 1)" },
      { bhk: Number.NaN, why: "NaN" },
    ];

    for (const { bhk, why } of cases) {
      const error = expectErr(
        computeSplit({
          strategy: "apartment",
          basis: "per_bhk",
          amount: rupees("100"),
          participants: [apartmentFlat("101", { bhk })],
        }),
      );

      expect({ why, code: error.code }).toEqual({ why, code: "validation" });
      expect(error.details?.field).toBe("participants.bhk");
    }
  });

  it("is a function of the participant set, not of the array order", () => {
    const participants = [
      apartmentFlat("103", { bhk: 1 }),
      apartmentFlat("101", { bhk: 3 }),
      apartmentFlat("102", { bhk: 2 }),
    ];

    const forward = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_bhk",
        amount: rupees("100.01"),
        participants,
      }),
    );
    const reversed = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_bhk",
        amount: rupees("100.01"),
        participants: [...participants].reverse(),
      }),
    );

    expect(ledger(reversed.allocations)).toEqual(ledger(forward.allocations));
  });

  it("does not mutate the caller's participants", () => {
    const participants = [
      apartmentFlat("103", { bhk: 1 }),
      apartmentFlat("101", { bhk: 3 }),
    ];
    const snapshot = participants.map((one) => one.apartmentNumber);

    void computeSplit({
      strategy: "apartment",
      basis: "per_bhk",
      amount: rupees("100"),
      participants,
    });

    expect(participants.map((one) => one.apartmentNumber)).toEqual(snapshot);
  });
});
