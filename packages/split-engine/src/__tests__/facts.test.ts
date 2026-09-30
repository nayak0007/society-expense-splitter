import { exactUnits } from "../bases/facts";

/**
 * The one suite that imports an internal module rather than `../index`, and it does
 * so on purpose (Roadmap T058).
 *
 * `exactUnits` is the primitive every apartment basis converts a `numeric` column
 * through. Its own guards — a non-finite value, a negative, a number whose text is
 * in exponent form — are **unreachable through the engine**, because each reader
 * checks the column's range first (`readArea` bounds an area to `0 < x ≤ 100000`,
 * `readBhk` to `0.5 ≤ x ≤ 20`). That is the point of them: they are the second line
 * of defence for a caller that hands the primitive a value the column `CHECK`
 * already forbids, and what they must do with it is **refuse**, never round, never
 * throw, and never return a weight.
 *
 * Testing them through a basis would mean first removing the range check that makes
 * them unnecessary, so they are tested where they live. The rest of the file
 * exercises the readings the bases actually take, which is why `720.5` and `2` are
 * here too: an exact weight, and a whole number with no decimal point to slice at.
 */
describe("exactUnits", () => {
  it("reads a decimal at its column's scale, without multiplying a float", () => {
    expect(exactUnits(720.5, 2)).toBe(72_050n);
    expect(exactUnits(1.5, 1)).toBe(15n);
    expect(exactUnits(100_000, 2)).toBe(10_000_000n);
    expect(exactUnits(0, 2)).toBe(0n);
  });

  it("reads a whole number with no decimal point", () => {
    // The `numeric(3, 1)` BHK column's common case: `2` BHK is `20` tenths.
    expect(exactUnits(2, 1)).toBe(20n);
    expect(exactUnits(750, 2)).toBe(75_000n);
  });

  it("refuses a value the column could not hold, rather than rounding it", () => {
    const refused: readonly (readonly [number, number])[] = [
      [Number.NaN, 2],
      [Number.POSITIVE_INFINITY, 2],
      [Number.NEGATIVE_INFINITY, 2],
      [-0.5, 2],
      // Seventeen decimal places: a value that has already drifted in binary
      // floating point, which `String` shows plainly and `numeric(8, 2)` could not
      // store. Rounding it here would put a number in a bill that no column holds.
      [0.1 + 0.2, 2],
      [1.0005, 3],
      // Exponent-form text: not a decimal that can be placed at a fixed scale
      // without guessing how many places were meant.
      [1e21, 2],
      [1e-7, 2],
    ];

    for (const [value, decimals] of refused) {
      expect(exactUnits(value, decimals)).toBeUndefined();
    }
  });

  it("accepts a value that is exactly at the requested scale", () => {
    // The boundary between "exact" and "drifted": two places is two places.
    expect(exactUnits(1.25, 2)).toBe(125n);
    expect(exactUnits(0.01, 2)).toBe(1n);
  });
});
