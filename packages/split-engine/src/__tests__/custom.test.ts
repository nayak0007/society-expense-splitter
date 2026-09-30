import { Money } from "@ses/domain";

import { computeSplit, type CustomParticipant } from "../index";
import {
  customFlat,
  expectErr,
  expectOk,
  flat,
  ledger,
  rupees,
  sumPaise,
} from "./fixtures";

/**
 * Custom split (PRD §3.5.5, Roadmap T057).
 *
 * "Treasurer types an exact amount per participant. Live 'remaining: ₹X'
 * indicator; save blocked until remaining is ₹0. Supports excluding participants
 * entirely." Every test here is that sentence made mechanical: the amounts are the
 * allocations, an unbalanced ledger is refused and the refusal names the gap, and
 * a flat is excluded by leaving it out of the list.
 *
 * Two failures the other strategies' suites have do not exist here, and their
 * absence is a property of the *type* rather than of a check: a custom amount that
 * belongs to no participant, and a participant with no amount. Both are
 * unwritable, because `CustomParticipant` carries its own `Money` — there is no
 * parallel array and no id-keyed map to misalign. A duplicate participant is still
 * expressible and is refused by the engine's shared check, which the conflict test
 * below pins.
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

describe("custom split", () => {
  it("assigns exactly the amounts the treasurer typed", () => {
    // ₹100 split ₹40 + ₹35 + ₹25. Nothing is proportional here: the numbers are
    // the answer, and the weights echo them because the amount is the basis that
    // produced each allocation.
    const result = expectOk(
      computeSplit({
        strategy: "custom",
        amount: rupees("100"),
        participants: [
          customFlat("101", "40"),
          customFlat("102", "35"),
          customFlat("103", "25"),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual([
      "101:4000",
      "102:3500",
      "103:2500",
    ]);
    expect(result.allocations.map((allocation) => allocation.weight)).toEqual([
      4_000n,
      3_500n,
      2_500n,
    ]);
    expect(sumPaise(result.allocations)).toBe(10_000n);
    expect(result.residualPaise).toBe(0n);
  });

  it("is exact to the paisa, not a rounded proportional share", () => {
    // Amounts no proportion would produce — ₹123.45 against ₹300.00 and ₹76.55.
    // A "custom implemented as weights then rounded" bug would move a paisa; the
    // assertion is that none moves.
    const result = expectOk(
      computeSplit({
        strategy: "custom",
        amount: rupees("500"),
        participants: [
          customFlat("101", "123.45"),
          customFlat("102", "300"),
          customFlat("103", "76.55"),
        ],
      }),
    );

    expect(ledger(result.allocations)).toEqual([
      "101:12345",
      "102:30000",
      "103:7655",
    ]);
    expect(sumPaise(result.allocations)).toBe(50_000n);
    expect(result.residualPaise).toBe(0n);
  });

  it("names the shortfall when the amounts do not add up", () => {
    // The roadmap's case: a custom split that does not sum returns an error naming
    // the shortfall. ₹95 assigned of ₹100 leaves ₹5, and the error says which.
    const error = expectErr(
      computeSplit({
        strategy: "custom",
        amount: rupees("100"),
        participants: [
          customFlat("101", "40"),
          customFlat("102", "35"),
          customFlat("103", "20"),
        ],
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("participants.amount");
    expect(error.details?.shortfallPaise).toBe("500");
    expect(error.message).toContain("₹5.00");
    expect(error.message).toContain("unassigned");
  });

  it("names the amount over-assigned when the amounts are too much", () => {
    const error = expectErr(
      computeSplit({
        strategy: "custom",
        amount: rupees("100"),
        participants: [
          customFlat("101", "40"),
          customFlat("102", "40"),
          customFlat("103", "30"),
        ],
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.shortfallPaise).toBe("-1000");
    expect(error.message).toContain("₹10.00");
    expect(error.message).toContain("more than");
  });

  it("returns an error when every participant is excluded", () => {
    // "Supports excluding participants entirely" does not mean "all of them": a
    // split that assigns ₹0 of ₹100 is not a split, and the shortfall error names
    // the whole amount.
    const error = expectErr(
      computeSplit({
        strategy: "custom",
        amount: rupees("100"),
        participants: [
          customFlat("101", "0"),
          customFlat("102", "0"),
          customFlat("103", "0"),
        ],
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.shortfallPaise).toBe("10000");
    expect(error.message).toContain("₹100.00");
  });

  it("allows a ₹0 amount to sit alongside the flats that pay", () => {
    // Exclusion is expressed by leaving a flat out of the list; a listed ₹0 is an
    // explicit "this flat owes nothing" — a caretaker's quarter, a shop billed
    // separately — and `expense_splits.amount_paise` is `CHECK (>= 0)` precisely
    // so the row can exist and be seen on the split table.
    const result = expectOk(
      computeSplit({
        strategy: "custom",
        amount: rupees("100"),
        participants: [customFlat("102", "100"), customFlat("101", "0")],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:0", "102:10000"]);
    expect(result.allocations[0]?.weight).toBe(0n);
    expect(result.residualPaise).toBe(0n);
  });

  it("takes the whole amount when one participant holds all of it", () => {
    const result = expectOk(
      computeSplit({
        strategy: "custom",
        amount: rupees("4999.99"),
        participants: [customFlat("101", "4999.99")],
      }),
    );

    expect(ledger(result.allocations)).toEqual(["101:499999"]);
  });

  it("is a function of the participant set, not of the array order", () => {
    const participants = [
      customFlat("103", "25"),
      customFlat("101", "40"),
      customFlat("102", "35"),
    ];

    const forward = expectOk(
      computeSplit({
        strategy: "custom",
        amount: rupees("100"),
        participants,
      }),
    );
    const reversed = expectOk(
      computeSplit({
        strategy: "custom",
        amount: rupees("100"),
        participants: [...participants].reverse(),
      }),
    );

    expect(ledger(forward.allocations)).toEqual([
      "101:4000",
      "102:3500",
      "103:2500",
    ]);
    expect(ledger(reversed.allocations)).toEqual(ledger(forward.allocations));
  });

  it("refuses a negative amount cast past the constructor", () => {
    // `expense_splits.amount_paise` is `CHECK (amount_paise >= 0)`: a resident
    // cannot owe less than nothing, and a credit is a different object (T012/T061).
    const error = expectErr(
      computeSplit({
        strategy: "custom",
        amount: rupees("100"),
        participants: [
          customFlat("101", "110"),
          { ...flat("102"), amount: Money.fromPaise(-1_000) },
        ],
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("participants.amount");
    expect(error.message).toContain("-₹10.00");
  });

  it("refuses an amount that is not Money at all", () => {
    // The declared type is `Money`, but the value can arrive off the wire as a
    // plain `amountPaise` number, or through a cast. A `TypeError` out of a
    // function that promises a `Result` would be the wrong answer to a caller
    // mistake, so the shape is checked like every other branded value.
    const plain = expectErr(
      computeSplit({
        strategy: "custom",
        amount: rupees("100"),
        participants: [
          { ...flat("101"), amount: { paise: 10_000 } as unknown as Money },
        ],
      }),
    );
    expect(plain.code).toBe("validation");
    expect(plain.message).toContain("amountPaise");

    const absent = expectErr(
      computeSplit({
        strategy: "custom",
        amount: rupees("100"),
        participants: [{ ...flat("101"), amount: null as unknown as Money }],
      }),
    );
    expect(absent.code).toBe("validation");
    expect(absent.details?.field).toBe("participants.amount");
  });

  it("refuses the same member and flat twice, through the shared check", () => {
    // Duplication is the engine's check, not the strategy's, so every strategy
    // gets it — and it runs *before* the strategy, which is why this is a
    // `conflict` rather than the shortfall error the amounts would also produce.
    const error = expectErr(
      computeSplit({
        strategy: "custom",
        amount: rupees("100"),
        participants: [customFlat("101", "50"), customFlat("101", "50")],
      }),
    );

    expect(error.code).toBe("conflict");
    expect(error.details?.field).toBe("participants");
  });

  it("behaves like every other strategy for a zero or negative expense", () => {
    // The amount is validated before the strategy is asked for weights, so custom
    // cannot grow its own opinion about a zero bill.
    const zero = expectErr(
      computeSplit({
        strategy: "custom",
        amount: Money.zero(),
        participants: [customFlat("101", "0")],
      }),
    );
    expect(zero.code).toBe("validation");
    expect(zero.details?.field).toBe("amount");

    const negative = expectErr(
      computeSplit({
        strategy: "custom",
        amount: Money.fromPaise(-100),
        participants: [customFlat("101", "-1")],
      }),
    );
    expect(negative.code).toBe("validation");
    expect(negative.details?.field).toBe("amount");
  });

  it("does not mutate the caller's participants", () => {
    const participants = [customFlat("103", "25"), customFlat("101", "75")];
    const snapshot = participants.map((one) => one.apartmentNumber);

    void computeSplit({
      strategy: "custom",
      amount: rupees("100"),
      participants,
    });

    expect(participants.map((one) => one.apartmentNumber)).toEqual(snapshot);
  });

  it("conserves every paise across 200 randomly partitioned amounts", () => {
    const random = makeRandom(0xca_5e_ed);

    for (let round = 0; round < 200; round += 1) {
      const count = 1 + Math.floor(random() * 8);
      const totalPaise = 1 + Math.floor(random() * 500_000);

      // Random parts that sum to the total by construction: each of the first
      // `count - 1` takes a random slice of what is left, and the last takes the
      // remainder — including zero, which is a legal (excluded) participant.
      const parts: number[] = [];
      let left = totalPaise;
      for (let index = 0; index < count - 1; index += 1) {
        const part = Math.floor(random() * (left + 1));
        parts.push(part);
        left -= part;
      }
      parts.push(left);

      const participants: readonly CustomParticipant[] = parts.map(
        (part, index) => ({
          ...flat(String(101 + index)),
          amount: Money.fromPaise(part),
        }),
      );

      const result = expectOk(
        computeSplit({
          strategy: "custom",
          amount: Money.fromPaise(totalPaise),
          participants,
        }),
      );

      expect(sumPaise(result.allocations)).toBe(BigInt(totalPaise));
      expect(result.residualPaise).toBe(0n);
      expect(
        result.allocations.map((allocation) => allocation.amount.paise),
      ).toEqual(parts.map((part) => BigInt(part)));

      const reversed = expectOk(
        computeSplit({
          strategy: "custom",
          amount: Money.fromPaise(totalPaise),
          participants: [...participants].reverse(),
        }),
      );
      expect(ledger(reversed.allocations)).toEqual(ledger(result.allocations));
    }
  });
});
