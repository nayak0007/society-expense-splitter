import { Money } from "@ses/domain";

import { computeSplit } from "../index";
import type { CustomParticipant, SplitAllocation } from "../index";
import {
  allocationsToPaise,
  expectOk,
  flat,
  flats,
  ledger,
  percentFlat,
  rupees,
  shareFlat,
} from "./fixtures";

/**
 * Cross-strategy equivalence (Roadmap T057).
 *
 * Where two strategies describe the same division they must produce the same
 * money — not merely a similar number, and not a rounding coincidence. `equal` and
 * `shares` at one share each are the same division; `shares 1 : 2 : 1` and
 * `percentage 25 : 50 : 25` are the same division; a custom split typed to the
 * amounts an equal split produced *is* that division. Each of those is asserted on
 * exact paise, per allocation and per participant id.
 *
 * These are the tests that would catch a second arithmetic path. A strategy that
 * divided for itself, or that rounded its own remainder, would still pass its own
 * suite's conservation check — a total can be conserved by the wrong rule too —
 * but it could not agree with a different strategy on the same input. That is what
 * "semantic consistency, not implementation identity" means here: the strategies
 * are free to be written differently, and are not free to disagree.
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

/** The identity of each allocation, so money is compared *with* its participant. */
function identityOf(allocations: readonly SplitAllocation[]): string[] {
  return allocations.map(
    (allocation) => `${allocation.apartmentNumber}/${allocation.memberId}`,
  );
}

/**
 * A custom participant holding exactly what an allocation says.
 *
 * Built from the allocations rather than from the input array on purpose: the
 * result is in apartment order, the input need not be, and pairing by array index
 * would silently hand one flat's amount to another — the exact bug this suite
 * exists to catch elsewhere.
 */
function customFrom(allocation: SplitAllocation): CustomParticipant {
  return {
    memberId: allocation.memberId,
    apartmentId: allocation.apartmentId,
    apartmentNumber: allocation.apartmentNumber,
    amount: allocation.amount,
  };
}

describe("cross-strategy equivalence", () => {
  it("agrees with equal when every participant has one share", () => {
    const equal = expectOk(
      computeSplit({
        strategy: "equal",
        amount: rupees("12000"),
        participants: flats(96),
      }),
    );
    const shares = expectOk(
      computeSplit({
        strategy: "shares",
        amount: rupees("12000"),
        participants: flats(96).map((one) =>
          shareFlat(one.apartmentNumber, 1_000),
        ),
      }),
    );

    expect(ledger(shares.allocations)).toEqual(ledger(equal.allocations));
    expect(identityOf(shares.allocations)).toEqual(
      identityOf(equal.allocations),
    );
  });

  it("agrees with equal on which flat carries the residual paisa", () => {
    // ₹100 over three flats leaves one paisa; both strategies must leave it on the
    // same one, including when the input arrives out of order.
    const participants = [flat("103"), flat("101"), flat("102")];

    const equal = expectOk(
      computeSplit({ strategy: "equal", amount: rupees("100"), participants }),
    );
    const shares = expectOk(
      computeSplit({
        strategy: "shares",
        amount: rupees("100"),
        participants: participants.map((one) =>
          shareFlat(one.apartmentNumber, 1_000),
        ),
      }),
    );

    expect(ledger(equal.allocations)).toEqual([
      "101:3334",
      "102:3333",
      "103:3333",
    ]);
    expect(ledger(shares.allocations)).toEqual(ledger(equal.allocations));
  });

  it("agrees with percentage 25 : 50 : 25 when shares are 1 : 2 : 1", () => {
    const percentage = expectOk(
      computeSplit({
        strategy: "percentage",
        amount: rupees("1000.01"),
        participants: [
          percentFlat("101", 2_500),
          percentFlat("102", 5_000),
          percentFlat("103", 2_500),
        ],
      }),
    );
    const shares = expectOk(
      computeSplit({
        strategy: "shares",
        amount: rupees("1000.01"),
        participants: [
          shareFlat("101", 1_000),
          shareFlat("102", 2_000),
          shareFlat("103", 1_000),
        ],
      }),
    );

    expect(ledger(shares.allocations)).toEqual(ledger(percentage.allocations));
    expect(allocationsToPaise(shares.allocations)).toEqual(
      allocationsToPaise(percentage.allocations),
    );
  });

  it("reproduces an equal allocation exactly when custom is typed to it", () => {
    // ₹100 over three flats is 3334 / 3333 / 3333 — a ledger no treasurer would
    // invent, and one a custom split can state outright. The amounts are the same
    // money; only the weights differ, because a custom participant's basis is its
    // amount and an equal participant's is `1`.
    const equal = expectOk(
      computeSplit({
        strategy: "equal",
        amount: rupees("100"),
        participants: [flat("103"), flat("101"), flat("102")],
      }),
    );

    const custom = expectOk(
      computeSplit({
        strategy: "custom",
        amount: rupees("100"),
        participants: equal.allocations.map(customFrom),
      }),
    );

    expect(ledger(custom.allocations)).toEqual(ledger(equal.allocations));
    expect(identityOf(custom.allocations)).toEqual(
      identityOf(equal.allocations),
    );
  });

  it("reproduces a shares allocation exactly when custom is typed to it", () => {
    // A shares split of ₹1 at 1 : 2 : 3 is 17 / 33 / 50 paise. A custom split that
    // states those three figures must land on the same flats with the same paise,
    // which is the residual policy agreeing with itself across strategies.
    const shares = expectOk(
      computeSplit({
        strategy: "shares",
        amount: rupees("1"),
        participants: [
          shareFlat("103", 3_000),
          shareFlat("102", 2_000),
          shareFlat("101", 1_000),
        ],
      }),
    );

    const custom = expectOk(
      computeSplit({
        strategy: "custom",
        amount: rupees("1"),
        participants: shares.allocations.map(customFrom),
      }),
    );

    expect(ledger(shares.allocations)).toEqual(["101:17", "102:33", "103:50"]);
    expect(ledger(custom.allocations)).toEqual(ledger(shares.allocations));
  });

  it("keeps the three strategies agreed across 200 random amounts", () => {
    // The sweep, rather than three hand-picked cases: for every random amount and
    // participant count, `equal`, `shares` at one share each and a `custom` split
    // typed to the result must be the same ledger — amounts, ids and order.
    const random = makeRandom(0x0e_9a_11);

    for (let round = 0; round < 200; round += 1) {
      const count = 1 + Math.floor(random() * 20);
      const amount = Money.fromPaise(1 + Math.floor(random() * 9_000_000));
      const participants = flats(count);

      const equal = expectOk(
        computeSplit({ strategy: "equal", amount, participants }),
      );
      const shares = expectOk(
        computeSplit({
          strategy: "shares",
          amount,
          participants: participants.map((one) =>
            shareFlat(one.apartmentNumber, 1_000),
          ),
        }),
      );
      const custom = expectOk(
        computeSplit({
          strategy: "custom",
          amount,
          participants: equal.allocations.map(customFrom),
        }),
      );

      expect(ledger(shares.allocations)).toEqual(ledger(equal.allocations));
      expect(ledger(custom.allocations)).toEqual(ledger(equal.allocations));
      expect(shares.residualPaise).toBe(0n);
      expect(custom.residualPaise).toBe(0n);
    }
  });
});
