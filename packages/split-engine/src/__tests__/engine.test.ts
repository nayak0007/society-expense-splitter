import { Money } from "@ses/domain";

import {
  SPLIT_ERROR_CODES,
  SPLIT_STRATEGIES,
  SplitError,
  computeSplit,
  isSplitError,
  splitError,
} from "../index";
import {
  allocationsToPaise,
  expectErr,
  expectOk,
  flat,
  flats,
  ledger,
  percentFlat,
  rupees,
  sumPaise,
} from "./fixtures";

/**
 * The engine itself (Roadmap T056): what it refuses, and the order it decides in.
 *
 * Ordering gets the most attention here because it is the only decision this file
 * makes beyond dispatch. The rounding rule lives in `rounding.test.ts` and the
 * strategies in their own suites; what is *unique* to the engine is that the
 * weights reach the rule in apartment order, which is what turns "tie-break by
 * index" into the PRD's "tie-break by apartment number ascending".
 *
 * The property tests at the end are deterministic (a seeded xorshift, so a failure
 * reproduces from its seed) rather than `fast-check`. That is deliberate: the
 * 10,000-iteration `fast-check` suite is Roadmap T059, which owns the CI wiring for
 * it, and adding a second property-testing toolchain now would be two things to
 * keep green for one invariant. What is here is enough to state the invariant over
 * a wide sample of shapes rather than over five hand-picked ones.
 */

/** xorshift32 — deterministic, so a failure is reproducible from its seed. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state ^ (state << 13)) >>> 0;
    state = (state ^ (state >>> 17)) >>> 0;
    state = (state ^ (state << 5)) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("computeSplit validation", () => {
  it("refuses a zero amount", () => {
    // `expenses.amount_paise` is `CHECK (amount_paise > 0)`, so a zero here is a
    // constraint violation waiting to happen. Returning zeros would look like
    // success and then fail at commit.
    const error = expectErr(
      computeSplit({
        strategy: "equal",
        amount: Money.zero(),
        participants: flats(3),
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("amount");
    expect(error.message).toContain("₹0.00");
  });

  it("refuses a negative amount", () => {
    const error = expectErr(
      computeSplit({
        strategy: "equal",
        amount: Money.fromPaise(-1),
        participants: flats(3),
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("amount");
  });

  it("refuses an empty participant list, for every strategy", () => {
    const equal = expectErr(
      computeSplit({
        strategy: "equal",
        amount: rupees("100"),
        participants: [],
      }),
    );
    expect(equal.code).toBe("validation");
    expect(equal.details?.field).toBe("participants");

    const percentage = expectErr(
      computeSplit({
        strategy: "percentage",
        amount: rupees("100"),
        participants: [],
      }),
    );
    expect(percentage.code).toBe("validation");
    expect(percentage.details?.field).toBe("participants");

    // T057's two as well: a shares or custom split with nobody in it is refused
    // by the same check, before any strategy is asked for weights.
    const shares = expectErr(
      computeSplit({
        strategy: "shares",
        amount: rupees("100"),
        participants: [],
      }),
    );
    expect(shares.code).toBe("validation");
    expect(shares.details?.field).toBe("participants");

    const custom = expectErr(
      computeSplit({
        strategy: "custom",
        amount: rupees("100"),
        participants: [],
      }),
    );
    expect(custom.code).toBe("validation");
    expect(custom.details?.field).toBe("participants");

    // T058's apartment arm too. It has its own emptiness check (an all-excluded
    // apartment set is also refused), but an empty list never reaches the basis:
    // the shared check refuses it first, exactly like the other four.
    const apartment = expectErr(
      computeSplit({
        strategy: "apartment",
        basis: "per_sqft_carpet",
        amount: rupees("100"),
        participants: [],
      }),
    );
    expect(apartment.code).toBe("validation");
    expect(apartment.details?.field).toBe("participants");
  });

  it("refuses the same member and flat twice", () => {
    // A resolver bug, not user input: one share of one expense cannot be charged
    // to the same member and flat twice.
    const error = expectErr(
      computeSplit({
        strategy: "equal",
        amount: rupees("100"),
        participants: [flat("101"), flat("102"), flat("101")],
      }),
    );

    expect(error.code).toBe("conflict");
    expect(error.details?.field).toBe("participants");
    expect(error.details?.apartmentId).toBe("apartment-101");
    expect(error.details?.memberId).toBe("member-101");
    expect(error.message).toContain("101");
  });

  it("allows one flat with two participating members", () => {
    // The legitimate case the duplicate check must not catch: two co-owners of one
    // flat, and `expense_splits` is unique on `(expense_id, member_id,
    // apartment_id)`, not on the apartment alone.
    const result = expectOk(
      computeSplit({
        strategy: "equal",
        amount: rupees("100"),
        participants: [
          flat("101", { memberId: "owner-one" }),
          flat("101", { memberId: "owner-two" }),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:5000", "101:5000"]);
  });

  it("narrows its errors with isSplitError", () => {
    const error = expectErr(
      computeSplit({
        strategy: "equal",
        amount: Money.zero(),
        participants: flats(2),
      }),
    );

    expect(error).toBeInstanceOf(SplitError);
    expect(isSplitError(error)).toBe(true);
    expect(isSplitError(new Error("not a split error"))).toBe(false);
  });

  it("exposes the three codes and the factory a caller can raise", () => {
    // The consumer-facing half of the error contract: these are the codes the
    // API's mapper switches on, and a fake split engine in another package's tests
    // raises its failures through the same factory so no caller has to construct a
    // `SplitError` by hand.
    expect(SPLIT_ERROR_CODES).toEqual(["validation", "conflict", "invariant"]);

    const error = splitError("conflict", "already participating", {
      field: "participants",
    });
    expect(error).toBeInstanceOf(SplitError);
    expect(error.code).toBe("conflict");
    expect(error.message).toBe("already participating");
    expect(error.details?.field).toBe("participants");
    expect(splitError("invariant", "no details").details).toBeUndefined();
  });
});

describe("computeSplit ordering", () => {
  it("orders by apartment number byte-wise, not numerically", () => {
    // `"1"` < `"10"` < `"2"` in code-unit order, which is the same order the
    // database index uses (`apartment_number COLLATE "C"`). Numeric ordering would
    // give 1, 2, 10 — and would put the residual paisa on a different flat than the
    // server's own ordering.
    const result = expectOk(
      computeSplit({
        strategy: "equal",
        amount: rupees("100"),
        participants: [flat("2"), flat("10"), flat("1")],
      }),
    );

    expect(result.allocations.map((one) => one.apartmentNumber)).toEqual([
      "1",
      "10",
      "2",
    ]);
  });

  it("breaks an apartment-number tie by id, not by array position", () => {
    const result = expectOk(
      computeSplit({
        strategy: "equal",
        amount: rupees("100.01"),
        participants: [
          flat("101", { apartmentId: "b", memberId: "m1" }),
          flat("101", { apartmentId: "a", memberId: "m2" }),
        ],
      }),
    );

    expect(result.allocations.map((one) => one.apartmentId)).toEqual([
      "a",
      "b",
    ]);
    // The stray paisa follows the ordering rather than the argument order.
    expect(allocationsToPaise(result.allocations)).toEqual(["5001", "5000"]);
  });

  it("is stable for a whole group sharing one apartment number", () => {
    // Three participants in one flat: `a/m1`, `a/m2`, `b/m2`. The last two agree on
    // apartment number and apartment id and are separated only by member id, so
    // this is the case the third ordering key exists for.
    const group = [
      flat("101", { apartmentId: "a", memberId: "m2" }),
      flat("101", { apartmentId: "b", memberId: "m2" }),
      flat("101", { apartmentId: "a", memberId: "m1" }),
    ];

    const forward = expectOk(
      computeSplit({
        strategy: "equal",
        amount: rupees("100"),
        participants: group,
      }),
    );
    const reversed = expectOk(
      computeSplit({
        strategy: "equal",
        amount: rupees("100"),
        participants: [...group].reverse(),
      }),
    );

    expect(
      forward.allocations.map((one) => `${one.apartmentId}/${one.memberId}`),
    ).toEqual(["a/m1", "a/m2", "b/m2"]);
    expect(ledger(reversed.allocations)).toEqual(ledger(forward.allocations));
  });

  it("does not mutate the caller's participants", () => {
    const participants = [flat("103"), flat("101"), flat("102")];
    const snapshot = participants.map((one) => one.apartmentNumber);

    void computeSplit({
      strategy: "equal",
      amount: rupees("100"),
      participants,
    });

    expect(participants.map((one) => one.apartmentNumber)).toEqual(snapshot);
  });

  it("freezes the result so a published split cannot be edited in place", () => {
    const result = expectOk(
      computeSplit({
        strategy: "equal",
        amount: rupees("100"),
        participants: flats(3),
      }),
    );

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.allocations)).toBe(true);
    expect(Object.isFrozen(result.allocations[0])).toBe(true);
  });

  it("echoes the total and reports nothing undistributed", () => {
    const amount = rupees("1000");
    const result = expectOk(
      computeSplit({ strategy: "equal", amount, participants: flats(7) }),
    );

    expect(result.total.paise).toBe(amount.paise);
    expect(result.total).toBe(amount);
    expect(result.residualPaise).toBe(0n);
    expect(sumPaise(result.allocations)).toBe(amount.paise);
  });

  it("implements exactly the strategies it declares", () => {
    // Pinned because the database enum already holds all five
    // (`equal, percentage, shares, apartment, custom`) and the names have to match
    // it exactly; T058 extends this list by the last one, and that edit should be
    // visible in a diff rather than discovered by a stored value failing to
    // dispatch.
    expect(SPLIT_STRATEGIES).toEqual([
      "equal",
      "percentage",
      "shares",
      "apartment",
      "custom",
    ]);
  });
});

describe("computeSplit invariants over generated input", () => {
  it("conserves every paise across 500 random equal splits", () => {
    const random = makeRandom(0x5eed_1234);

    for (let round = 0; round < 500; round += 1) {
      const count = 1 + Math.floor(random() * 40);
      const amount = Money.fromPaise(1 + Math.floor(random() * 9_000_000));
      const participants = flats(count);

      const first = expectOk(
        computeSplit({ strategy: "equal", amount, participants }),
      );

      expect(sumPaise(first.allocations)).toBe(amount.paise);
      expect(first.residualPaise).toBe(0n);
      expect(first.allocations).toHaveLength(count);

      // Order-independence, asserted alongside conservation: the two properties
      // together are what make the residual's destination a property of the
      // participant set rather than of the caller.
      const reversed = expectOk(
        computeSplit({
          strategy: "equal",
          amount,
          participants: [...participants].reverse(),
        }),
      );
      expect(ledger(reversed.allocations)).toEqual(ledger(first.allocations));
    }
  });

  it("conserves every amount up to 200 paise across 1 to 12 participants", () => {
    // Exhaustive in a small domain rather than sampled. A systematic off-by-one
    // that only appears at particular divisors — a count of 7 against a total of
    // 13 — is exactly what a random sample walks past, and this domain is small
    // enough to enumerate completely: 2,400 splits, no seed to trust.
    for (let count = 1; count <= 12; count += 1) {
      for (let amount = 1; amount <= 200; amount += 1) {
        const money = Money.fromPaise(amount);
        const result = expectOk(
          computeSplit({
            strategy: "equal",
            amount: money,
            participants: flats(count),
          }),
        );

        expect(sumPaise(result.allocations)).toBe(money.paise);
        expect(result.residualPaise).toBe(0n);
        expect(result.allocations).toHaveLength(count);

        // No part is negative and none exceeds the whole — a check that a
        // conservation-only assertion cannot make, since a +1 and a -1 would
        // cancel out and still sum correctly.
        for (const allocation of result.allocations) {
          expect(allocation.amount.paise).toBeGreaterThanOrEqual(0n);
          expect(allocation.amount.paise).toBeLessThanOrEqual(money.paise);
        }
      }
    }
  });

  it("conserves every paise across 300 random percentage splits", () => {
    const random = makeRandom(0xbeef_0f);

    for (let round = 0; round < 300; round += 1) {
      const count = 1 + Math.floor(random() * 12);
      // Percentages totalling exactly 100% by construction — an equal floor share
      // each, with the remainder on the lowest apartment numbers — so the
      // tolerance is never the thing under test here.
      const each = Math.floor(10_000 / count);
      const remainder = 10_000 - each * count;
      const participants = Array.from({ length: count }, (_, index) =>
        percentFlat(String(101 + index), each + (index < remainder ? 1 : 0)),
      );

      const amount = Money.fromPaise(1 + Math.floor(random() * 1_000_000));
      const result = expectOk(
        computeSplit({ strategy: "percentage", amount, participants }),
      );

      expect(sumPaise(result.allocations)).toBe(amount.paise);
      expect(result.residualPaise).toBe(0n);
    }
  });
});
