import { Money } from "@ses/domain";

import {
  MAX_SHARE_UNITS,
  ONE_SHARE,
  computeSplit,
  shareUnits,
  type ShareUnits,
} from "../index";
import {
  expectErr,
  expectOk,
  flat,
  ledger,
  rupees,
  shareFlat,
  shareTier,
  sumPaise,
} from "./fixtures";

/**
 * Shares split (PRD §3.5.3, Roadmap T057).
 *
 * The roadmap's own case is the first test: ₹60,000 over `10×3 + 20×2 + 20×1`
 * shares. The PRD prints the per-tier figures as ₹2,000 / ₹1,333.34 / ₹666.67,
 * which cannot be right — they add to ₹60,000.20 — and the file records why: the
 * tier figures are a display rounding of `60000 × share ÷ 90`, while the ledger
 * has to conserve, so the twenty paise the rule has left over go to the tier with
 * the largest fractional remainder (the 1-share flats, whose remainder is twice
 * the 2-share tier's). ₹1,333.33 + ₹666.67 is ₹2,000.00, which is the arithmetic
 * the PRD's own rounding rule produces.
 *
 * Every expected number below is written as a paise literal, so a failure reads as
 * a specific bill rather than as a diff of two rounded strings.
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

describe("shares split", () => {
  it("splits ₹60,000 over the BHK tiers and sums to exactly ₹60,000", () => {
    const participants = [
      ...shareTier(10, 3_000, 101),
      ...shareTier(20, 2_000, 111),
      ...shareTier(20, 1_000, 131),
    ];

    const result = expectOk(
      computeSplit({
        strategy: "shares",
        amount: rupees("60000"),
        participants,
      }),
    );

    const tierPaise = (share: bigint) =>
      result.allocations
        .filter((allocation) => allocation.weight === share)
        .map((allocation) => allocation.amount.paise);

    // 90,000 thousandths (30 + 40 + 20 shares) against 6,000,000 paise: each
    // three-share flat is exactly 2,000 · 100 paise, each two-share flat is
    // 133,333.33 and each one-share flat 66,666.67. The rule floors all three and
    // hands the 20 leftover paise out one at a time, largest remainder first —
    // which is the one-share tier, so it lands on ₹666.67.
    expect(tierPaise(3_000n)).toEqual(new Array(10).fill(200_000n));
    expect(tierPaise(2_000n)).toEqual(new Array(20).fill(133_333n));
    expect(tierPaise(1_000n)).toEqual(new Array(20).fill(66_667n));

    expect(sumPaise(result.allocations)).toBe(6_000_000n);
    expect(result.total.paise).toBe(6_000_000n);
    expect(result.residualPaise).toBe(0n);
    expect(result.allocations).toHaveLength(50);

    // The tier figures as a treasurer reads them off the split table.
    expect(result.allocations[0]?.amount.format()).toBe("₹2,000.00");
    expect(result.allocations[10]?.amount.format()).toBe("₹1,333.33");
    expect(result.allocations[30]?.amount.format()).toBe("₹666.67");
  });

  it("puts the residual paisa on the largest fractional remainder, not the first flat", () => {
    // ₹1 over shares 1 : 2 : 3 is 16.67 / 33.33 / 50.00 paise. The remainders are
    // 4000, 2000 and 0 of 6000, so the single paisa belongs to the *smallest*
    // weight — the opposite end from an equal split, and proof that the residual
    // follows the remainder column rather than the position in the list.
    const result = expectOk(
      computeSplit({
        strategy: "shares",
        amount: rupees("1"),
        participants: [
          shareFlat("101", 1_000),
          shareFlat("102", 2_000),
          shareFlat("103", 3_000),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:17", "102:33", "103:50"]);
    expect(result.residualPaise).toBe(0n);
  });

  it("conserves a single paisa across unequal shares", () => {
    // ₹0.01 against 1 : 2 : 3. Every floor is zero, so the only paisa in the
    // expense is allocated by remainder — and it is the 3-share flat's.
    const result = expectOk(
      computeSplit({
        strategy: "shares",
        amount: rupees("0.01"),
        participants: [
          shareFlat("101", 1_000),
          shareFlat("102", 2_000),
          shareFlat("103", 3_000),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:0", "102:0", "103:1"]);
    expect(sumPaise(result.allocations)).toBe(1n);
  });

  it("is a function of the participant set, not of the array order", () => {
    const participants = [
      shareFlat("103", 3_000),
      shareFlat("101", 1_000),
      shareFlat("102", 2_000),
    ];

    const forward = expectOk(
      computeSplit({
        strategy: "shares",
        amount: rupees("100"),
        participants,
      }),
    );
    const reversed = expectOk(
      computeSplit({
        strategy: "shares",
        amount: rupees("100"),
        participants: [...participants].reverse(),
      }),
    );

    // ₹100 at 1 : 2 : 3 is ₹16.67 / ₹33.33 / ₹50.00 — the one leftover paisa goes
    // to the 3-share flat, and it goes there whichever way the array arrives.
    expect(ledger(forward.allocations)).toEqual([
      "101:1667",
      "102:3333",
      "103:5000",
    ]);
    expect(ledger(reversed.allocations)).toEqual(ledger(forward.allocations));
  });

  it("keeps the residual attached to the right flat when ids run against the ordering", () => {
    // Three equal shares and ₹100.01: two paise are left over and both remainders
    // tie, so position decides — and position is apartment number, byte-wise.
    // The member ids deliberately run the other way, so a test that only checked
    // *amounts* would pass while the money sat on the wrong member.
    const participants = [
      shareFlat("103", 1_000, { memberId: "m-1", apartmentId: "a-3" }),
      shareFlat("101", 1_000, { memberId: "m-3", apartmentId: "a-1" }),
      shareFlat("102", 1_000, { memberId: "m-2", apartmentId: "a-2" }),
    ];

    const result = expectOk(
      computeSplit({
        strategy: "shares",
        amount: rupees("100.01"),
        participants,
      }),
    );

    expect(
      result.allocations.map(
        (allocation) =>
          `${allocation.apartmentNumber}:${allocation.memberId}:${allocation.amount.paise.toString()}`,
      ),
    ).toEqual(["101:m-3:3334", "102:m-2:3334", "103:m-1:3333"]);
    expect(result.residualPaise).toBe(0n);
  });

  it("accepts a decimal share — 1.5 shares is 1500 thousandths", () => {
    // PRD §3.5.3: "integer or decimal share units". ₹1,000 split 1.25 : 0.75 is
    // exactly ₹625.00 and ₹375.00, because both weights are integers and the one
    // division happens in `Money.allocateByWeights` — no float ever sees 1.25.
    const result = expectOk(
      computeSplit({
        strategy: "shares",
        amount: rupees("1000"),
        participants: [shareFlat("101", 1_250), shareFlat("102", 750)],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:62500", "102:37500"]);
    expect(result.allocations.map((allocation) => allocation.weight)).toEqual([
      1_250n,
      750n,
    ]);
    expect(result.residualPaise).toBe(0n);
  });

  it("gives the same money whatever the share scale is", () => {
    // 1 : 2 : 3 and 1000 : 2000 : 3000 are the same proportions, so they must be
    // the same allocation — including which flat carries the residual paisa. This
    // is what makes the thousandths scale safe to have.
    const coarse = expectOk(
      computeSplit({
        strategy: "shares",
        amount: rupees("100"),
        participants: [
          shareFlat("101", 1),
          shareFlat("102", 2),
          shareFlat("103", 3),
        ],
      }),
    );
    const fine = expectOk(
      computeSplit({
        strategy: "shares",
        amount: rupees("100"),
        participants: [
          shareFlat("101", 1_000),
          shareFlat("102", 2_000),
          shareFlat("103", 3_000),
        ],
      }),
    );

    expect(ledger(coarse.allocations)).toEqual(ledger(fine.allocations));
  });

  it("gives a lone participant the whole amount", () => {
    const result = expectOk(
      computeSplit({
        strategy: "shares",
        amount: rupees("4999.99"),
        participants: [shareFlat("101", ONE_SHARE)],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:499999"]);
  });

  it("conserves an amount beyond the safe integer range, at the share ceiling", () => {
    // 2^60 paise is ~11.5 quintillion, past `Number.MAX_SAFE_INTEGER`, and the
    // weights are at `chk_apartments_share_units`' ceiling and a thousandth of a
    // share at once. Both sides of the division are bigint, so neither can round.
    const result = expectOk(
      computeSplit({
        strategy: "shares",
        amount: Money.fromPaise(2n ** 60n),
        participants: [
          shareFlat("101", MAX_SHARE_UNITS),
          shareFlat("102", 3_000),
        ],
      }),
    );

    expect(sumPaise(result.allocations)).toBe(2n ** 60n);
    expect(result.residualPaise).toBe(0n);
    for (const allocation of result.allocations) {
      expect(allocation.amount.paise).toBeGreaterThanOrEqual(0n);
      expect(allocation.amount.paise).toBeLessThanOrEqual(2n ** 60n);
    }
  });

  it("does not mutate the caller's participants", () => {
    const participants = [shareFlat("103", 1_000), shareFlat("101", 1_000)];
    const snapshot = participants.map((one) => one.apartmentNumber);

    void computeSplit({
      strategy: "shares",
      amount: rupees("100"),
      participants,
    });

    expect(participants.map((one) => one.apartmentNumber)).toEqual(snapshot);
  });

  it("rejects a zero share rather than allocating ₹0 to nobody", () => {
    // Roadmap T057: "Zero or negative shares rejected". A ₹0 row in a published
    // split is a charge to a flat the treasurer never meant to bill; a flat the
    // society means to exempt is left out of the list instead.
    const error = expectErr(
      computeSplit({
        strategy: "shares",
        amount: rupees("100"),
        participants: [
          shareFlat("101", 1_000),
          { ...flat("102"), share: 0n as unknown as ShareUnits },
        ],
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("participants.share");
    expect(error.message).toContain("greater than zero");
  });

  it("rejects an all-zero share set, and a negative share", () => {
    const allZero = expectErr(
      computeSplit({
        strategy: "shares",
        amount: rupees("100"),
        participants: [
          { ...flat("101"), share: 0n as unknown as ShareUnits },
          { ...flat("102"), share: 0n as unknown as ShareUnits },
        ],
      }),
    );
    expect(allZero.code).toBe("validation");

    const negative = expectErr(
      computeSplit({
        strategy: "shares",
        amount: rupees("100"),
        participants: [
          shareFlat("101", 1_000),
          { ...flat("102"), share: -1_000n as unknown as ShareUnits },
        ],
      }),
    );
    expect(negative.code).toBe("validation");
    expect(negative.details?.field).toBe("participants.share");
  });

  it("rejects a fractional or unsafe share cast past the constructor", () => {
    // `1.5` shares is `1500`. A float here is a caller that has already done share
    // arithmetic in floating point, which is the one thing that must not reach
    // money — so it is refused rather than rounded to 1 or 2.
    const fractional = expectErr(
      computeSplit({
        strategy: "shares",
        amount: rupees("100"),
        participants: [{ ...flat("101"), share: 1.5 as unknown as ShareUnits }],
      }),
    );
    expect(fractional.code).toBe("validation");
    expect(fractional.message).toContain("1500");

    const unsafe = expectErr(
      computeSplit({
        strategy: "shares",
        amount: rupees("100"),
        participants: [
          { ...flat("101"), share: (2 ** 53) as unknown as ShareUnits },
        ],
      }),
    );
    expect(unsafe.code).toBe("validation");
  });

  it("rejects a share above the share_units ceiling", () => {
    // The ceiling is the database's (`chk_apartments_share_units`), so a split
    // above it could never be written to `expense_splits` — and it is also the
    // largest weight that fits `weight numeric(12, 4)`.
    const error = expectErr(
      computeSplit({
        strategy: "shares",
        amount: rupees("100"),
        participants: [
          shareFlat("101", MAX_SHARE_UNITS),
          { ...flat("102"), share: 10_000_001n as unknown as ShareUnits },
        ],
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.message).toContain("10000");
  });

  it("conserves every paise across 300 random share sets", () => {
    const random = makeRandom(0x5eed_5a);
    const shareChoices = [1, 250, 1_000, 2_500, 3_000, 9_999];

    for (let round = 0; round < 300; round += 1) {
      const count = 1 + Math.floor(random() * 12);
      const participants = Array.from({ length: count }, (_, index) =>
        shareFlat(
          String(101 + index),
          shareChoices[Math.floor(random() * shareChoices.length)] ?? 1_000,
        ),
      );
      const amount = Money.fromPaise(1 + Math.floor(random() * 9_000_000));

      const result = expectOk(
        computeSplit({ strategy: "shares", amount, participants }),
      );

      expect(sumPaise(result.allocations)).toBe(amount.paise);
      expect(result.residualPaise).toBe(0n);
      expect(result.allocations).toHaveLength(count);

      for (const allocation of result.allocations) {
        expect(allocation.amount.paise).toBeGreaterThanOrEqual(0n);
        expect(allocation.amount.paise).toBeLessThanOrEqual(amount.paise);
      }

      const reversed = expectOk(
        computeSplit({
          strategy: "shares",
          amount,
          participants: [...participants].reverse(),
        }),
      );
      expect(ledger(reversed.allocations)).toEqual(ledger(result.allocations));
    }
  });
});

describe("shareUnits", () => {
  it("brands a whole number of thousandths", () => {
    expect(shareUnits(3_000)).toBe(3_000n);
    expect(shareUnits(1_000n)).toBe(ONE_SHARE);
    expect(shareUnits(MAX_SHARE_UNITS)).toBe(MAX_SHARE_UNITS);
  });

  it("refuses zero, a negative, a fraction and an unsafe number", () => {
    expect(() => shareUnits(0)).toThrow();
    expect(() => shareUnits(0n)).toThrow();
    expect(() => shareUnits(-1_000)).toThrow();
    expect(() => shareUnits(-1_000n)).toThrow();
    expect(() => shareUnits(1.5)).toThrow();
    expect(() => shareUnits(2 ** 53)).toThrow();
  });

  it("refuses a share above the share_units ceiling", () => {
    expect(() => shareUnits(10_000_001)).toThrow(/10000/);
    expect(() => shareUnits(10_000_001n)).toThrow(/10000/);
  });

  it("is a thousandth of a share", () => {
    // The scale is the column's: `apartments.share_units` is `numeric(8, 3)`.
    expect(ONE_SHARE).toBe(1_000n);
    expect(MAX_SHARE_UNITS).toBe(10_000_000n);
    expect(MAX_SHARE_UNITS / ONE_SHARE).toBe(10_000n);
  });
});
