import {
  PERCENT_TOLERANCE_BASIS_POINTS,
  PERCENT_TOTAL_BASIS_POINTS,
  basisPoints,
  computeSplit,
  type BasisPoints,
} from "../index";
import {
  expectErr,
  expectOk,
  flat,
  ledger,
  percentFlat,
  rupees,
  sumPaise,
} from "./fixtures";

/**
 * Percentage split (PRD §3.5.2, Roadmap T056).
 *
 * Every assertion here is exact integer arithmetic, so there is no epsilon
 * anywhere in the file. That is the point of representing a percentage as
 * {@link BasisPoints}: the PRD's own worked example (`33.33 + 33.33 + 33.34 =
 * 100.00`) is `3333n + 3333n + 3334n = 10_000n`, and a float implementation of the
 * same rule is the one that needs `toBeCloseTo`.
 */
describe("percentage split", () => {
  it("allocates an exact percentage of ₹1,000", () => {
    const result = expectOk(
      computeSplit({
        strategy: "percentage",
        amount: rupees("1000"),
        participants: [percentFlat("101", 6_000), percentFlat("102", 4_000)],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:60000", "102:40000"]);
    expect(result.allocations.map((allocation) => allocation.weight)).toEqual([
      6_000n,
      4_000n,
    ]);
    expect(result.residualPaise).toBe(0n);
  });

  it("totals 100.00% exactly from 33.33 + 33.33 + 33.34", () => {
    const result = expectOk(
      computeSplit({
        strategy: "percentage",
        amount: rupees("100"),
        participants: [
          percentFlat("101", 3_333),
          percentFlat("102", 3_333),
          percentFlat("103", 3_334),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual([
      "101:3333",
      "102:3333",
      "103:3334",
    ]);
    expect(result.residualPaise).toBe(0n);
  });

  it("accepts a total within one basis point of 100%", () => {
    // 99.99%: three equal two-decimal shares of one whole, which is a legitimate
    // ledger rather than a typo. The weights need not sum to 10_000 for the money
    // to be right — the primitive divides by the sum it is given.
    const short = expectOk(
      computeSplit({
        strategy: "percentage",
        amount: rupees("100"),
        participants: [
          percentFlat("101", 3_333),
          percentFlat("102", 3_333),
          percentFlat("103", 3_333),
        ],
      }),
    );
    expect(sumPaise(short.allocations)).toBe(10_000n);
    expect(short.residualPaise).toBe(0n);

    // 100.01%: the same tolerance in the other direction.
    const over = expectOk(
      computeSplit({
        strategy: "percentage",
        amount: rupees("100"),
        participants: [
          percentFlat("101", 3_334),
          percentFlat("102", 3_334),
          percentFlat("103", 3_333),
        ],
      }),
    );
    expect(sumPaise(over.allocations)).toBe(10_000n);
    expect(over.residualPaise).toBe(0n);
  });

  it("returns an error when the percentages do not total 100%", () => {
    const error = expectErr(
      computeSplit({
        strategy: "percentage",
        amount: rupees("100"),
        participants: [percentFlat("101", 6_000), percentFlat("102", 3_000)],
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("participants.percentage");
    expect(error.details?.totalBasisPoints).toBe("9000");
    expect(error.message).toContain("90.00%");
  });

  it("returns an error when the total is off by more than one basis point", () => {
    // 99.98% and 100.02% — one basis point beyond the tolerance in each direction.
    const under = expectErr(
      computeSplit({
        strategy: "percentage",
        amount: rupees("100"),
        participants: [
          percentFlat("101", 3_333),
          percentFlat("102", 3_333),
          percentFlat("103", 3_332),
        ],
      }),
    );
    expect(under.code).toBe("validation");
    expect(under.message).toContain("99.98%");

    const above = expectErr(
      computeSplit({
        strategy: "percentage",
        amount: rupees("100"),
        participants: [
          percentFlat("101", 3_334),
          percentFlat("102", 3_334),
          percentFlat("103", 3_334),
        ],
      }),
    );
    expect(above.code).toBe("validation");
    expect(above.message).toContain("100.02%");
  });

  it("refuses all-zero percentages rather than splitting nothing", () => {
    const error = expectErr(
      computeSplit({
        strategy: "percentage",
        amount: rupees("100"),
        participants: [percentFlat("101", 0), percentFlat("102", 0)],
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.message).toContain("0.00%");
  });

  it("rejects a percentage outside 0–100 cast past the constructor", () => {
    // The brand is compile-time only, so these are the cases the runtime check
    // exists for: a value off the wire, or a cast someone added to silence the
    // compiler.
    const above = expectErr(
      computeSplit({
        strategy: "percentage",
        amount: rupees("100"),
        participants: [
          { ...flat("101"), percentage: 10_001n as unknown as BasisPoints },
        ],
      }),
    );
    expect(above.code).toBe("validation");
    expect(above.message).toContain("100.01%");

    const below = expectErr(
      computeSplit({
        strategy: "percentage",
        amount: rupees("100"),
        participants: [
          { ...flat("101"), percentage: -1n as unknown as BasisPoints },
        ],
      }),
    );
    expect(below.code).toBe("validation");
  });

  it("rejects a fractional percentage cast past the constructor", () => {
    // `33.33` basis points is not a thing; `33.33%` is 3333 basis points. Rounding
    // it here would move money between participants without anyone choosing to.
    const error = expectErr(
      computeSplit({
        strategy: "percentage",
        amount: rupees("100"),
        participants: [
          { ...flat("101"), percentage: 33.33 as unknown as BasisPoints },
        ],
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.message).toContain("3333");
  });

  it("lets a single participant take 100%", () => {
    const result = expectOk(
      computeSplit({
        strategy: "percentage",
        amount: rupees("250.75"),
        participants: [percentFlat("101", PERCENT_TOTAL_BASIS_POINTS)],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:25075"]);
  });

  it("conserves ₹0.01 across three participants", () => {
    // A single paisa against weights 3333:3333:3334. The largest remainder is the
    // third participant's (3334 of 10000 against 3333), so the only paisa in the
    // expense belongs to the *last* flat by apartment order — the opposite end
    // from an equal split, and the case that proves the residual follows the
    // remainder rather than the position.
    const result = expectOk(
      computeSplit({
        strategy: "percentage",
        amount: rupees("0.01"),
        participants: [
          percentFlat("101", 3_333),
          percentFlat("102", 3_333),
          percentFlat("103", 3_334),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:0", "102:0", "103:1"]);
    expect(sumPaise(result.allocations)).toBe(1n);
  });
});

describe("basisPoints", () => {
  it("brands a whole number of basis points", () => {
    expect(basisPoints(0)).toBe(0n);
    expect(basisPoints(3_333)).toBe(3_333n);
    expect(basisPoints(10_000n)).toBe(PERCENT_TOTAL_BASIS_POINTS);
  });

  it("refuses a fraction, a negative and anything over 100%", () => {
    expect(() => basisPoints(33.33)).toThrow();
    expect(() => basisPoints(-1)).toThrow();
    expect(() => basisPoints(-1n)).toThrow();
    expect(() => basisPoints(10_001)).toThrow();
  });

  it("is one basis point, which is the 0.01% the PRD allows", () => {
    expect(PERCENT_TOLERANCE_BASIS_POINTS).toBe(1n);
    expect(PERCENT_TOTAL_BASIS_POINTS).toBe(10_000n);
  });
});
