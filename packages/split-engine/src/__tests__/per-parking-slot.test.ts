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
 * `per_parking_slot` (PRD §3.5.4, Roadmap T058) — a parking charge split by the
 * slots a flat was allotted.
 *
 * The interesting case is the flat with **no** slot: `0` is a recorded fact, so it
 * weighs zero and stays in the result with an amount of ₹0, exactly like a
 * ground-floor flat in a lift charge. Exclusion is reserved for facts that are not
 * recorded at all, and `parking_slots` is `NOT NULL DEFAULT 0` — there is no such
 * state.
 */
describe("per_parking_slot basis", () => {
  it("splits ₹30,000 by allotted slots", () => {
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_parking_slot",
        amount: rupees("30000"),
        participants: [
          apartmentFlat("101", { parkingSlots: 3 }),
          apartmentFlat("102", { parkingSlots: 2 }),
          apartmentFlat("103", { parkingSlots: 1 }),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual([
      "101:1500000",
      "102:1000000",
      "103:500000",
    ]);
    expect(result.allocations.map((allocation) => allocation.weight)).toEqual([
      3n,
      2n,
      1n,
    ]);
    expect(result.residualPaise).toBe(0n);
    expect(result.warnings).toEqual([]);
  });

  it("charges a flat with no slot exactly ₹0", () => {
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_parking_slot",
        amount: rupees("100"),
        participants: [
          apartmentFlat("101", { parkingSlots: 1 }),
          apartmentFlat("102", { parkingSlots: 0 }),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:10000", "102:0"]);
    expect(sumPaise(result.allocations)).toBe(10_000n);
    expect(result.warnings).toEqual([]);
  });

  it("puts the residual paisa on the flat with more slots", () => {
    // ₹1 over 2 : 1 slots — 66.67 and 33.33 paise, so the leftover paisa follows
    // the larger remainder and the bigger share grows by one.
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_parking_slot",
        amount: rupees("1"),
        participants: [
          apartmentFlat("101", { parkingSlots: 2 }),
          apartmentFlat("102", { parkingSlots: 1 }),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:67", "102:33"]);
  });

  it("refuses a parking charge no flat has a slot for", () => {
    // Every weight is zero: there is nothing to divide the amount by, and
    // answering with a list of ₹0 rows would be a bill nobody owes.
    const error = expectErr(
      computeSplit({
        strategy: "apartment",
        basis: "per_parking_slot",
        amount: rupees("100"),
        participants: [
          apartmentFlat("101", { parkingSlots: 0 }),
          apartmentFlat("102", { parkingSlots: 0 }),
        ],
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("participants");
    expect(error.message).toContain("positive weight");
  });

  it("refuses a slot count that could not have come from the column", () => {
    const cases = [
      { slots: -1, why: "negative" },
      { slots: 21, why: "over the column's bound" },
      { slots: 1.5, why: "fractional" },
      { slots: Number.NaN, why: "NaN" },
    ];

    for (const { slots, why } of cases) {
      const error = expectErr(
        computeSplit({
          strategy: "apartment",
          basis: "per_parking_slot",
          amount: rupees("100"),
          participants: [apartmentFlat("101", { parkingSlots: slots })],
        }),
      );

      expect({ why, code: error.code }).toEqual({ why, code: "validation" });
      expect(error.details?.field).toBe("participants.parkingSlots");
      expect(error.details?.apartmentId).toBe("apartment-101");
    }
  });

  it("is a function of the participant set, not of the array order", () => {
    const participants = [
      apartmentFlat("103", { parkingSlots: 1 }),
      apartmentFlat("101", { parkingSlots: 3 }),
      apartmentFlat("102", { parkingSlots: 2 }),
    ];

    const forward = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_parking_slot",
        amount: rupees("100.01"),
        participants,
      }),
    );
    const reversed = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_parking_slot",
        amount: rupees("100.01"),
        participants: [...participants].reverse(),
      }),
    );

    expect(ledger(reversed.allocations)).toEqual(ledger(forward.allocations));
  });
});
