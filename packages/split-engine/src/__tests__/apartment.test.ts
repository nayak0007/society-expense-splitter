import { computeSplit, type ApartmentSplitInput } from "../index";
import {
  LIFT_BANDS,
  apartmentFlat,
  apartmentFlats,
  customFlat,
  expectErr,
  expectOk,
  ledger,
  percentFlat,
  rupees,
  shareFlat,
  sumPaise,
} from "./fixtures";

/**
 * The `apartment` strategy as the engine sees it (Roadmap T058): the result
 * contract, warnings, exclusions, and where the six bases agree.
 *
 * The bases have suites of their own; what is here is the part they share — that
 * every result carries `warnings`, that an excluded flat is absent from the ledger
 * while the total stays whole, that warnings are deterministic in *order* and not
 * merely in content, and that the engine's amount/participant/duplicate checks
 * apply to this strategy exactly as they do to the other four.
 */
describe("apartment strategy", () => {
  it("carries an empty warnings list on every other strategy", () => {
    // One result shape, not a shape that changes with the strategy: a caller never
    // has to ask which strategy it holds to know whether to look at `warnings`.
    const amount = rupees("100");
    const results = [
      expectOk(
        computeSplit({
          strategy: "equal",
          amount,
          participants: apartmentFlats(2),
        }),
      ),
      expectOk(
        computeSplit({
          strategy: "percentage",
          amount,
          participants: [percentFlat("101", 5_000), percentFlat("102", 5_000)],
        }),
      ),
      expectOk(
        computeSplit({
          strategy: "shares",
          amount,
          participants: [shareFlat("101", 1_000), shareFlat("102", 1_000)],
        }),
      ),
      expectOk(
        computeSplit({
          strategy: "custom",
          amount,
          participants: [customFlat("101", "40"), customFlat("102", "60")],
        }),
      ),
      expectOk(
        computeSplit({
          strategy: "apartment",
          basis: "per_flat",
          amount,
          participants: apartmentFlats(2),
        }),
      ),
    ];

    for (const result of results) {
      expect(result.warnings).toEqual([]);
      expect(Object.isFrozen(result.warnings)).toBe(true);
    }
  });

  it("holds a flat back from the ledger without losing a paisa", () => {
    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_carpet",
        amount: rupees("48000"),
        participants: [
          apartmentFlat("101", { carpetAreaSqft: 600 }),
          apartmentFlat("102", { carpetAreaSqft: null }),
          apartmentFlat("103", { carpetAreaSqft: 900 }),
          apartmentFlat("104", { carpetAreaSqft: 1500 }),
        ],
      }),
    );

    // Three flats share the whole ₹48,000 — the excluded flat's share is not
    // "lost", it is borne by the flats that remain, exactly as the PRD's warning
    // implies ("excluded") rather than "charged ₹0".
    expect(result.allocations).toHaveLength(3);
    expect(sumPaise(result.allocations)).toBe(4_800_000n);
    expect(result.residualPaise).toBe(0n);
    expect(ledger(result.allocations)).toEqual([
      "101:960000",
      "103:1440000",
      "104:2400000",
    ]);
    expect(result.warnings[0]?.apartmentIds).toEqual(["apartment-102"]);
  });

  it("lists warning ids in apartment order whatever order the input was in", () => {
    const participants = [
      apartmentFlat("105", { carpetAreaSqft: null }),
      apartmentFlat("101", { carpetAreaSqft: 500 }),
      apartmentFlat("103", { carpetAreaSqft: null }),
      apartmentFlat("102", { carpetAreaSqft: null }),
    ];

    const result = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_carpet",
        amount: rupees("100"),
        participants,
      }),
    );

    expect(result.warnings[0]?.apartmentIds).toEqual([
      "apartment-102",
      "apartment-103",
      "apartment-105",
    ]);
  });

  it("produces identical warnings for the same flats in a different order", () => {
    const participants = [
      apartmentFlat("104", { floor: null }),
      apartmentFlat("102", { floor: 12 }),
      apartmentFlat("103", { floor: 2 }),
      apartmentFlat("101", { floor: null }),
    ];

    const forward = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_floor_band",
        amount: rupees("100"),
        participants,
        floorBands: [{ from: 0, to: 8, mult: 1 }],
      }),
    );
    const reversed = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_floor_band",
        amount: rupees("100"),
        participants: [...participants].reverse(),
        floorBands: [{ from: 0, to: 8, mult: 1 }],
      }),
    );

    expect(reversed.warnings).toEqual(forward.warnings);
    expect(forward.warnings.map((warning) => warning.code)).toEqual([
      "MISSING_FLOOR",
      "NO_FLOOR_BAND",
    ]);
  });

  it("names the flat and the field a bad fact came from", () => {
    const error = expectErr(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_builtup",
        amount: rupees("100"),
        participants: [
          apartmentFlat("101", { builtupAreaSqft: 800 }),
          apartmentFlat("102", { builtupAreaSqft: -1 }),
        ],
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("participants.builtupAreaSqft");
    expect(error.details?.apartmentId).toBe("apartment-102");
    expect(error.details?.apartmentNumber).toBe("102");
    expect(error.message).toContain("Built-up area");
  });

  it("refuses a split every participant was excluded from", () => {
    const error = expectErr(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_carpet",
        amount: rupees("100"),
        participants: [
          apartmentFlat("101", { carpetAreaSqft: null }),
          apartmentFlat("102", { carpetAreaSqft: null }),
        ],
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("participants");
    expect(error.message).toContain("every participant was excluded");
  });

  it("shares the engine's amount, participant and duplicate checks", () => {
    const participants = apartmentFlats(2);

    const zero = expectErr(
      computeSplit({
        strategy: "apartment",
        basis: "per_flat",
        amount: rupees("0"),
        participants,
      }),
    );
    expect(zero.details?.field).toBe("amount");

    const empty = expectErr(
      computeSplit({
        strategy: "apartment",
        basis: "per_flat",
        amount: rupees("100"),
        participants: [],
      }),
    );
    expect(empty.details?.field).toBe("participants");

    const duplicate = expectErr(
      computeSplit({
        strategy: "apartment",
        basis: "per_flat",
        amount: rupees("100"),
        participants: [apartmentFlat("101"), apartmentFlat("101")],
      }),
    );
    expect(duplicate.code).toBe("conflict");
  });

  it("freezes the warnings it returns", () => {
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

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.warnings)).toBe(true);
    expect(Object.isFrozen(result.warnings[0])).toBe(true);
    expect(Object.isFrozen(result.warnings[0]?.apartmentIds)).toBe(true);
  });

  it("agrees with the equal strategy whenever every weight is the same", () => {
    // Not an implementation coincidence: each basis produces one identical weight
    // per flat, so the proportions are equal proportions and the residual's
    // destination is decided by the same ordering contract.
    const amount = rupees("100.01");
    const participants = apartmentFlats(5);
    const equal = expectOk(
      computeSplit({ strategy: "equal", amount, participants }),
    );

    const sameWeight: readonly ApartmentSplitInput[] = [
      { strategy: "apartment", basis: "per_flat", amount, participants },
      {
        strategy: "apartment",
        basis: "per_sqft_carpet",
        amount,
        participants,
      },
      { strategy: "apartment", basis: "per_bhk", amount, participants },
      {
        strategy: "apartment",
        basis: "per_parking_slot",
        amount,
        participants,
      },
      {
        strategy: "apartment",
        basis: "per_floor_band",
        amount,
        participants,
        floorBands: [{ from: 0, to: 10, mult: 1 }],
      },
    ];

    for (const input of sameWeight) {
      expect(ledger(expectOk(computeSplit(input)).allocations)).toEqual(
        ledger(equal.allocations),
      );
    }
  });

  it("gives per_flat and equal the same weights, not just the same money", () => {
    const amount = rupees("100");
    const participants = apartmentFlats(3);

    const equal = expectOk(
      computeSplit({ strategy: "equal", amount, participants }),
    );
    const perFlat = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_flat",
        amount,
        participants,
      }),
    );

    expect(ledger(perFlat.allocations)).toEqual(ledger(equal.allocations));
    expect(perFlat.allocations.map((one) => one.weight)).toEqual(
      equal.allocations.map((one) => one.weight),
    );
  });

  it("gives the same money when built-up is proportional to carpet", () => {
    // Every flat's built-up area is 1.25× its carpet area, so the two bases
    // describe the same division of the same expense — one ratio, two columns.
    const participants = [
      apartmentFlat("101", { carpetAreaSqft: 400, builtupAreaSqft: 500 }),
      apartmentFlat("102", { carpetAreaSqft: 600, builtupAreaSqft: 750 }),
      apartmentFlat("103", { carpetAreaSqft: 800, builtupAreaSqft: 1000 }),
    ];

    const carpet = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_carpet",
        amount: rupees("1000.01"),
        participants,
      }),
    );
    const builtup = expectOk(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_builtup",
        amount: rupees("1000.01"),
        participants,
      }),
    );

    expect(ledger(builtup.allocations)).toEqual(ledger(carpet.allocations));
    expect(builtup.residualPaise).toBe(0n);
  });

  it("does not mutate the caller's participants when it excludes and sorts", () => {
    const participants = [
      apartmentFlat("103", { floor: 6 }),
      apartmentFlat("101", { floor: null }),
      apartmentFlat("102", { floor: 2 }),
    ];
    const snapshot = participants.map((one) => one.apartmentNumber);

    void computeSplit({
      strategy: "apartment",
      basis: "per_floor_band",
      amount: rupees("100"),
      participants,
      floorBands: LIFT_BANDS,
    });

    expect(participants.map((one) => one.apartmentNumber)).toEqual(snapshot);
  });
});
