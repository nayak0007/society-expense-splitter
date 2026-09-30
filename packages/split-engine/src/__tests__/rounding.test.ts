import { Money, MoneyError, weight } from "@ses/domain";

import { distribute, undistributedPaise } from "../rounding";
import { partsToPaise, rupees } from "./fixtures";

/**
 * The rounding rule (Roadmap T056, PRD §3.5).
 *
 * Two things are being pinned, and they are different claims:
 *
 *  - **The rule itself** — floor, then hand the residual out one paisa at a time
 *    to the largest fractional remainders, ties by position in the given order.
 *    These are the tests that would catch a change in `Money.allocateByWeights`,
 *    which is why several of them restate a case `@ses/domain` already covers: the
 *    engine depends on that behaviour *as a contract*, and a dependency's test
 *    suite is not where this package's dependency on it is documented.
 *  - **That order is the tie-break.** `distribute` is deliberately order-sensitive.
 *    The engine sorts by apartment number before calling, precisely so that "index
 *    order" and "apartment order" are the same thing.
 */
describe("distribute", () => {
  it("conserves the total exactly when it does not divide evenly", () => {
    const parts = distribute(rupees("100"), [weight(1), weight(1), weight(1)]);

    // ₹33.33 each leaves one paisa over, and it lands on the first in order.
    expect(partsToPaise(parts)).toEqual(["3334", "3333", "3333"]);
    expect(undistributedPaise(rupees("100"), parts)).toBe(0n);
  });

  it("gives the residual to the largest fractional remainder, not the first", () => {
    // ₹1 across weights 1:2:3 is 16.67 / 33.33 / 50.00 paise — the remainders are
    // 4, 2 and 0, so the extra paisa belongs to the *first* only because it also
    // has the largest remainder. Ordering by index instead of by remainder would
    // produce the same answer here, which is why the weights are chosen so the
    // largest remainder and the lowest index are the same participant and the
    // assertion is about the remainder column.
    const parts = distribute(rupees("1"), [weight(1), weight(2), weight(3)]);

    expect(partsToPaise(parts)).toEqual(["17", "33", "50"]);
    expect(undistributedPaise(rupees("1"), parts)).toBe(0n);
  });

  it("breaks a tie by position in the order it was given", () => {
    // Three equal weights and an amount that leaves one paisa: every remainder is
    // identical, so position is the only thing left to decide it. This is the
    // behaviour the engine relies on when it passes weights in apartment order.
    const parts = distribute(rupees("100"), [weight(1), weight(1), weight(1)]);

    expect(partsToPaise(parts)[0]).toBe("3334");
  });

  it("gives a zero weight zero and the rest their share", () => {
    const parts = distribute(rupees("100"), [weight(1), weight(0), weight(1)]);

    expect(partsToPaise(parts)).toEqual(["5000", "0", "5000"]);
  });

  it("gives a single participant the whole amount", () => {
    const parts = distribute(rupees("1234.56"), [weight(1)]);

    expect(partsToPaise(parts)).toEqual(["123456"]);
  });

  it("divides ₹12,000 across 96 equal weights with nothing left over", () => {
    const weights = Array.from({ length: 96 }, () => weight(1));
    const parts = distribute(rupees("12000"), weights);

    expect(parts).toHaveLength(96);
    expect(new Set(partsToPaise(parts))).toEqual(new Set(["12500"]));
    expect(undistributedPaise(rupees("12000"), parts)).toBe(0n);
  });

  it("allocates the magnitude of a negative amount and keeps the sign", () => {
    // A refund: the parts must still sum to the input, negatives and all, or a
    // credit would lose a paisa in the opposite direction from a charge.
    const refund = Money.fromPaise(-10_000);
    const parts = distribute(refund, [weight(1), weight(1), weight(1)]);

    expect(partsToPaise(parts)).toEqual(["-3334", "-3333", "-3333"]);
    expect(undistributedPaise(refund, parts)).toBe(0n);
  });

  it("refuses to divide by nothing at all", () => {
    // Unreachable from `computeSplit` — it requires a participant, and every
    // strategy gives each one a positive weight — but a silent `[]` here would be
    // an amount that vanished with no error anywhere.
    expect(() => distribute(rupees("100"), [])).toThrow(MoneyError);
    expect(() => distribute(rupees("100"), [weight(0), weight(0)])).toThrow(
      MoneyError,
    );
  });
});

describe("undistributedPaise", () => {
  it("reports nothing outstanding for a conserving distribution", () => {
    const amount = rupees("100");
    expect(undistributedPaise(amount, distribute(amount, [weight(1)]))).toBe(
      0n,
    );
  });

  it("measures what was actually not distributed", () => {
    // Pointed at parts that knowingly do not add up, so the number is proven to be
    // computed rather than always answering zero. ₹33.33 + ₹33.33 is ₹66.66, which
    // is ₹33.34 short of ₹100.
    const parts = [Money.fromPaise(3_333), Money.fromPaise(3_333)];

    expect(undistributedPaise(rupees("100"), parts)).toBe(3_334n);
  });

  it("reports the whole amount when nothing was distributed", () => {
    expect(undistributedPaise(rupees("100"), [])).toBe(10_000n);
  });
});
