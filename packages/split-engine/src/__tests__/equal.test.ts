import { Money } from "@ses/domain";

import { computeSplit } from "../index";
import { expectOk, flat, flats, ledger, rupees, sumPaise } from "./fixtures";

/**
 * Equal split (PRD §3.5.1, Roadmap T056).
 *
 * The two cases T056 names are the first two tests below, verbatim: ₹12,000 across
 * 96 flats, and ₹100 across 3 with the residual on the first by apartment order.
 * They are worth having exactly as written — they are the numbers the roadmap's
 * manual QA says a treasurer checks by hand, so a failure here is a failure a
 * person would notice at the same moment.
 */
describe("equal split", () => {
  it("gives ₹125.00 to each of 96 flats", () => {
    const result = expectOk(
      computeSplit({
        strategy: "equal",
        amount: rupees("12000"),
        participants: flats(96),
      }),
    );

    expect(result.allocations).toHaveLength(96);
    for (const allocation of result.allocations) {
      expect(allocation.amount.paise).toBe(12_500n);
    }
    expect(result.allocations[0]?.amount.format()).toBe("₹125.00");
    expect(result.residualPaise).toBe(0n);
  });

  it("puts the one stray paisa on the lowest apartment number", () => {
    // Passed out of order on purpose: the residual must follow apartment number,
    // not the array the caller built.
    const result = expectOk(
      computeSplit({
        strategy: "equal",
        amount: rupees("100"),
        participants: [flat("103"), flat("101"), flat("102")],
      }),
    );

    expect(ledger(result.allocations)).toEqual([
      "101:3334",
      "102:3333",
      "103:3333",
    ]);
    expect(result.residualPaise).toBe(0n);
  });

  it("is a function of the participant set, not of the array order", () => {
    const participants = [flat("103"), flat("101"), flat("102"), flat("104")];

    const forward = expectOk(
      computeSplit({
        strategy: "equal",
        amount: rupees("100.01"),
        participants,
      }),
    );
    const reversed = expectOk(
      computeSplit({
        strategy: "equal",
        amount: rupees("100.01"),
        participants: [...participants].reverse(),
      }),
    );

    expect(ledger(reversed.allocations)).toEqual(ledger(forward.allocations));
  });

  it("gives every participant one equal share", () => {
    const result = expectOk(
      computeSplit({
        strategy: "equal",
        amount: rupees("100"),
        participants: flats(3),
      }),
    );

    for (const allocation of result.allocations) {
      expect(allocation.weight).toBe(1n);
    }
  });

  it("conserves even when the total is smaller than the participant count", () => {
    // ₹0.02 across 5 flats. Two flats owe a single paisa and three owe nothing,
    // which is the case a "divide and round" implementation gets wrong by paying
    // everyone 0 paise and losing the two.
    const result = expectOk(
      computeSplit({
        strategy: "equal",
        amount: rupees("0.02"),
        participants: flats(5),
      }),
    );

    expect(ledger(result.allocations)).toEqual([
      "101:1",
      "102:1",
      "103:0",
      "104:0",
      "105:0",
    ]);
    expect(sumPaise(result.allocations)).toBe(2n);
  });

  it("gives a lone participant the whole amount", () => {
    const result = expectOk(
      computeSplit({
        strategy: "equal",
        amount: rupees("4999.99"),
        participants: [flat("101")],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:499999"]);
  });

  it("conserves an amount beyond the safe integer range", () => {
    // 2^60 paise is ~11.5 quintillion, far past `Number.MAX_SAFE_INTEGER` (~9.007
    // * 10^15). A `number`-based engine would round here; `bigint` cannot.
    const amount = Money.fromPaise(2n ** 60n);

    const result = expectOk(
      computeSplit({ strategy: "equal", amount, participants: flats(3) }),
    );

    expect(sumPaise(result.allocations)).toBe(2n ** 60n);
    expect(result.residualPaise).toBe(0n);
  });

  it("produces identical output across 1,000 runs", () => {
    const input = {
      strategy: "equal",
      amount: rupees("777.77"),
      participants: flats(37),
    } as const;

    const first = expectOk(computeSplit(input));
    for (let run = 1; run < 1_000; run += 1) {
      expect(ledger(expectOk(computeSplit(input)).allocations)).toEqual(
        ledger(first.allocations),
      );
    }
  });
});
