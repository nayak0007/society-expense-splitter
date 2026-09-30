import { computeSplit, type FloorBand } from "../index";
import {
  LIFT_BANDS,
  apartmentFlat,
  expectErr,
  expectOk,
  ledger,
  rupees,
  sumPaise,
} from "./fixtures";

/**
 * `per_floor_band` (PRD §3.5.4, Roadmap T058) — the lift-charge basis.
 *
 * > e.g. lift charges: ground floor 0×, floors 1–3 1×, floors 4+ 1.5×
 *
 * Two claims carry most of the weight here. A **zero multiplier is an exemption,
 * not an exclusion**: the ground-floor flat appears in the result with ₹0, which
 * is the roadmap's own test. And the band *table* is configuration, so a table
 * that could not mean anything — empty, reversed, overlapping — is a field error
 * before any flat is weighed, while a flat the table simply does not reach is
 * excluded with a warning rather than silently dropped or given an invented
 * multiplier.
 */
describe("per_floor_band basis", () => {
  it("charges ground-floor flats exactly ₹0", () => {
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_floor_band",
        amount: rupees("1000"),
        participants: [
          apartmentFlat("101", { floor: 0 }),
          apartmentFlat("102", { floor: 2 }),
          apartmentFlat("103", { floor: 6 }),
        ],
        floorBands: LIFT_BANDS,
      }),
    );

    // Weights 0 : 1000 : 1500 of ₹1,000 — the ground floor is *in* the split and
    // owes nothing, the second floor pays ₹400 and the sixth ₹600.
    expect(ledger(result.allocations)).toEqual([
      "101:0",
      "102:40000",
      "103:60000",
    ]);
    expect(result.allocations.map((allocation) => allocation.weight)).toEqual([
      0n,
      1000n,
      1500n,
    ]);
    expect(sumPaise(result.allocations)).toBe(100_000n);
    expect(result.residualPaise).toBe(0n);
    expect(result.warnings).toEqual([]);
  });

  it("matches both ends of a band inclusively", () => {
    // Floors 1 and 3 are inside `1–3`; 4 and 8 are inside `4–8`. Nothing falls in
    // the gap between them because there is no gap — the ranges are inclusive.
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_floor_band",
        amount: rupees("1000"),
        participants: [
          apartmentFlat("101", { floor: 1 }),
          apartmentFlat("102", { floor: 3 }),
          apartmentFlat("103", { floor: 4 }),
          apartmentFlat("104", { floor: 8 }),
        ],
        floorBands: LIFT_BANDS,
      }),
    );

    expect(ledger(result.allocations)).toEqual([
      "101:20000",
      "102:20000",
      "103:30000",
      "104:30000",
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("supports basements and the ground floor", () => {
    // Floors are the domain's own integers: negative is a basement, `0` is ground,
    // and both can sit in a 0× band.
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_floor_band",
        amount: rupees("500"),
        participants: [
          apartmentFlat("101", { floor: -2 }),
          apartmentFlat("102", { floor: 0 }),
          apartmentFlat("103", { floor: 1 }),
        ],
        floorBands: [
          { from: -2, to: 0, mult: 0 },
          { from: 1, to: 10, mult: 1 },
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:0", "102:0", "103:50000"]);
    expect(result.warnings).toEqual([]);
  });

  it("excludes a flat with no floor recorded and warns", () => {
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_floor_band",
        amount: rupees("100"),
        participants: [
          apartmentFlat("101", { floor: 2 }),
          apartmentFlat("102", { floor: null }),
        ],
        floorBands: LIFT_BANDS,
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:10000"]);
    expect(result.warnings).toEqual([
      {
        code: "MISSING_FLOOR",
        message: "1 apartment was excluded: no floor recorded.",
        apartmentIds: ["apartment-102"],
      },
    ]);
  });

  it("excludes a flat above every band and warns", () => {
    // The floor *is* recorded — the table simply stops below it. Excluding with a
    // warning keeps the rest of the building's bill computable and makes the gap
    // the treasurer's next action, where a validation error would block everyone.
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_floor_band",
        amount: rupees("100"),
        participants: [
          apartmentFlat("101", { floor: 0 }),
          apartmentFlat("102", { floor: 12 }),
        ],
        floorBands: [{ from: 0, to: 8, mult: 1 }],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:10000"]);
    expect(result.warnings).toEqual([
      {
        code: "NO_FLOOR_BAND",
        message:
          "1 apartment was excluded: a floor outside every configured band.",
        apartmentIds: ["apartment-102"],
      },
    ]);
  });

  it("reports both reasons in code order when both apply", () => {
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_floor_band",
        amount: rupees("100"),
        participants: [
          apartmentFlat("103", { floor: 1 }),
          apartmentFlat("101", { floor: null }),
          apartmentFlat("102", { floor: 12 }),
        ],
        floorBands: [{ from: 1, to: 8, mult: 1 }],
      }),
    );

    expect(result.warnings.map((warning) => warning.code)).toEqual([
      "MISSING_FLOOR",
      "NO_FLOOR_BAND",
    ]);
    expect(ledger(result.allocations)).toEqual(["103:10000"]);
  });

  it("puts the residual paisa on the lowest apartment number", () => {
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_floor_band",
        amount: rupees("100"),
        participants: [
          apartmentFlat("103", { floor: 1 }),
          apartmentFlat("101", { floor: 1 }),
          apartmentFlat("102", { floor: 1 }),
        ],
        floorBands: [{ from: 0, to: 5, mult: 1 }],
      }),
    );

    expect(ledger(result.allocations)).toEqual([
      "101:3334",
      "102:3333",
      "103:3333",
    ]);
  });

  it("accepts unsorted and adjacent bands", () => {
    const unsorted = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_floor_band",
        amount: rupees("1000"),
        participants: [
          apartmentFlat("101", { floor: 0 }),
          apartmentFlat("102", { floor: 2 }),
          apartmentFlat("103", { floor: 6 }),
        ],
        floorBands: [
          { from: 4, to: 8, mult: 1.5 },
          { from: 0, to: 0, mult: 0 },
          { from: 1, to: 3, mult: 1 },
        ],
      }),
    );

    expect(ledger(unsorted.allocations)).toEqual([
      "101:0",
      "102:40000",
      "103:60000",
    ]);
  });

  it("rejects an empty band table", () => {
    const error = expectErr(
      computeSplit({
        strategy: "apartment",
        basis: "per_floor_band",
        amount: rupees("100"),
        participants: [apartmentFlat("101", { floor: 1 })],
        floorBands: [],
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("floorBands");
    expect(error.message).toContain("at least one band");
  });

  it("rejects a reversed band", () => {
    const error = expectErr(
      computeSplit({
        strategy: "apartment",
        basis: "per_floor_band",
        amount: rupees("100"),
        participants: [apartmentFlat("101", { floor: 1 })],
        floorBands: [{ from: 5, to: 2, mult: 1 }],
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.message).toContain("reversed");
  });

  it("rejects a band bound that is not a whole floor in range", () => {
    const cases: readonly FloorBand[] = [
      { from: 1.5, to: 3, mult: 1 },
      { from: -6, to: 3, mult: 1 },
      { from: 1, to: 500, mult: 1 },
      { from: Number.NaN, to: 3, mult: 1 },
    ];

    for (const band of cases) {
      const error = expectErr(
        computeSplit({
          strategy: "apartment",
          basis: "per_floor_band",
          amount: rupees("100"),
          participants: [apartmentFlat("101", { floor: 1 })],
          floorBands: [band],
        }),
      );

      expect(error.code).toBe("validation");
      expect(error.details?.field).toBe("floorBands");
      expect(error.message).toContain("whole floor numbers");
    }
  });

  it("rejects a negative or over-fine multiplier", () => {
    for (const mult of [-1, 1.0005, Number.NaN]) {
      const error = expectErr(
        computeSplit({
          strategy: "apartment",
          basis: "per_floor_band",
          amount: rupees("100"),
          participants: [apartmentFlat("101", { floor: 1 })],
          floorBands: [{ from: 1, to: 3, mult }],
        }),
      );

      expect(error.code).toBe("validation");
      expect(error.message).toContain("multiplier");
    }
  });

  it("rejects overlapping bands", () => {
    // The roadmap's case: a floor must match at most one band, whether the bands
    // touch at a floor, nest inside each other, or are the same band twice.
    const overlapping: readonly (readonly FloorBand[])[] = [
      [
        { from: 0, to: 3, mult: 1 },
        { from: 3, to: 5, mult: 1 },
      ],
      [
        { from: 1, to: 5, mult: 1 },
        { from: 2, to: 3, mult: 2 },
      ],
      [
        { from: 1, to: 3, mult: 1 },
        { from: 1, to: 3, mult: 1 },
      ],
    ];

    for (const floorBands of overlapping) {
      const error = expectErr(
        computeSplit({
          strategy: "apartment",
          basis: "per_floor_band",
          amount: rupees("100"),
          participants: [apartmentFlat("101", { floor: 1 })],
          floorBands,
        }),
      );

      expect(error.code).toBe("validation");
      expect(error.details?.field).toBe("floorBands");
      expect(error.message).toContain("overlap");
    }
  });

  it("refuses a split where every floor is in a 0× band", () => {
    // Exemption is a weight of zero, and a split where *everything* weighs zero
    // has nothing to divide by — the one case the engine must refuse rather than
    // hand to the allocator.
    const error = expectErr(
      computeSplit({
        strategy: "apartment",
        basis: "per_floor_band",
        amount: rupees("100"),
        participants: [
          apartmentFlat("101", { floor: 1 }),
          apartmentFlat("102", { floor: 2 }),
        ],
        floorBands: [{ from: 0, to: 10, mult: 0 }],
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("participants");
    expect(error.message).toContain("positive weight");
  });

  it("refuses an impossible floor fact rather than inventing a band", () => {
    // The floor column is a `smallint` with `CHECK (floor BETWEEN -5 AND 200)`, and
    // the domain's `createFloor` refuses exactly these values, so one of them can
    // only arrive from a hand-built input or a mis-scaled value in transit. It is a
    // field error, not a warning: no band table can say what such a flat owes, and
    // guessing a multiplier is how a plausible-looking bill gets published.
    const cases: readonly number[] = [1.5, -6, 500, Number.NaN];

    for (const floor of cases) {
      const error = expectErr(
        computeSplit({
          strategy: "apartment",
          basis: "per_floor_band",
          amount: rupees("100"),
          participants: [
            apartmentFlat("101", { floor: 1 }),
            apartmentFlat("102", { floor }),
          ],
          floorBands: LIFT_BANDS,
        }),
      );

      expect(error.code).toBe("validation");
      expect(error.details?.field).toBe("participants.floor");
      expect(error.details?.apartmentId).toBe("apartment-102");
      expect(error.message).toContain("whole number between -5 and 200");
    }
  });

  it("is a function of the participant set, not of the array order", () => {
    const participants = [
      apartmentFlat("103", { floor: 6 }),
      apartmentFlat("101", { floor: null }),
      apartmentFlat("102", { floor: 12 }),
    ];

    const forward = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_floor_band",
        amount: rupees("100.01"),
        participants,
        floorBands: LIFT_BANDS,
      }),
    );
    const reversed = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_floor_band",
        amount: rupees("100.01"),
        participants: [...participants].reverse(),
        floorBands: LIFT_BANDS,
      }),
    );

    expect(ledger(reversed.allocations)).toEqual(ledger(forward.allocations));
    // The warnings are part of the result and must be ordered identically too —
    // both the codes and the ids inside them.
    expect(reversed.warnings).toEqual(forward.warnings);
  });

  it("does not mutate the caller's bands or participants", () => {
    const participants = [apartmentFlat("103", { floor: 6 })];
    const bands: FloorBand[] = [
      { from: 4, to: 8, mult: 1.5 },
      { from: 0, to: 3, mult: 1 },
    ];
    const snapshot = [...bands];

    void computeSplit({
      strategy: "apartment",
      basis: "per_floor_band",
      amount: rupees("100"),
      participants,
      floorBands: bands,
    });

    expect(bands).toEqual(snapshot);
    expect(participants.map((one) => one.apartmentNumber)).toEqual(["103"]);
  });
});
