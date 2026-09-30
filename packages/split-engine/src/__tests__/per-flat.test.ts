import { computeSplit } from "../index";
import {
  apartmentFlat,
  apartmentFlats,
  expectOk,
  ledger,
  rupees,
  sumPaise,
} from "./fixtures";

/**
 * `per_flat` (PRD §3.5.4, Roadmap T058) — "identical to equal, but scoped to flats
 * not people".
 *
 * The suite is short by nature: this basis reads nothing, so most of the edge
 * cases the others have (missing attribute, impossible attribute) cannot arise.
 * What it does pin is the two things that *could* go wrong — the weight, and the
 * fact that it is deliberately blind to attributes a caller happened to fill in.
 */
describe("per_flat basis", () => {
  it("gives every flat one share", () => {
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_flat",
        amount: rupees("12000"),
        participants: apartmentFlats(96),
      }),
    );

    expect(result.allocations).toHaveLength(96);
    for (const allocation of result.allocations) {
      expect(allocation.amount.paise).toBe(12_500n);
      expect(allocation.weight).toBe(1n);
    }
    expect(result.allocations[0]?.amount.format()).toBe("₹125.00");
    expect(result.residualPaise).toBe(0n);
    expect(result.warnings).toEqual([]);
  });

  it("puts the one stray paisa on the lowest apartment number", () => {
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_flat",
        amount: rupees("100"),
        participants: [
          apartmentFlat("103"),
          apartmentFlat("101"),
          apartmentFlat("102"),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual([
      "101:3334",
      "102:3333",
      "103:3333",
    ]);
  });

  it("reads no attribute, so an unrecorded one is not a warning", () => {
    // A per-flat split is "one share per flat". A flat with no area, no floor, no
    // configuration and no parking slot is still exactly one flat — and this basis
    // must not start reporting data it was never asked to weigh.
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_flat",
        amount: rupees("100"),
        participants: [
          apartmentFlat("101", {
            floor: null,
            carpetAreaSqft: null,
            builtupAreaSqft: null,
            bhk: null,
            parkingSlots: 0,
          }),
          apartmentFlat("102"),
          apartmentFlat("103"),
        ],
      }),
    );

    expect(result.allocations).toHaveLength(3);
    expect(result.warnings).toEqual([]);
    expect(sumPaise(result.allocations)).toBe(10_000n);
  });

  it("is a function of the participant set, not of the array order", () => {
    const participants = [
      apartmentFlat("103"),
      apartmentFlat("101"),
      apartmentFlat("102"),
      apartmentFlat("104"),
    ];

    const forward = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_flat",
        amount: rupees("100.01"),
        participants,
      }),
    );
    const reversed = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_flat",
        amount: rupees("100.01"),
        participants: [...participants].reverse(),
      }),
    );

    expect(ledger(reversed.allocations)).toEqual(ledger(forward.allocations));
  });

  it("does not mutate the caller's participants", () => {
    const participants = [apartmentFlat("103"), apartmentFlat("101")];
    const snapshot = participants.map((one) => one.apartmentNumber);

    void computeSplit({
      strategy: "apartment",
      basis: "per_flat",
      amount: rupees("100"),
      participants,
    });

    expect(participants.map((one) => one.apartmentNumber)).toEqual(snapshot);
  });
});
