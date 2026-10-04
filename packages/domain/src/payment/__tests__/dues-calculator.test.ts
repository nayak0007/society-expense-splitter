import { paise } from "../../shared/money";
import { isMoneyError } from "../../shared/money.vo";
import {
  DUE_KINDS,
  OUTSTANDING_DUE_STATUSES,
  ZERO_BALANCE,
  calculateOutstanding,
  isOutstandingDue,
  projectDueCreation,
  type CreatedDue,
  type MemberBalanceState,
  type OutstandingDueLine,
} from "../dues-calculator";

/**
 * `dues-calculator` — Roadmap T067's blocking 100% row, and SAD §15.2's
 * `**\/dues-calculator*` 100 / 100 threshold.
 *
 * The tests are the formula: PRD §3.5's
 * `outstanding = Σdues − Σverified payments − Σcredits + Σlate fees`, credits,
 * late fees and partial payments each exercised, plus the two things money tests
 * exist for — exactness at the edge of `Number` and a typed refusal rather than a
 * rounded or clamped answer.
 */

function line(overrides: Partial<OutstandingDueLine> = {}): OutstandingDueLine {
  return {
    kind: "principal",
    status: "pending",
    amountPaise: paise(100_000n),
    paidPaise: paise(0n),
    dueDate: "2026-10-10",
    ...overrides,
  };
}

describe("calculateOutstanding", () => {
  it("returns a zero, unsigned-empty balance for no dues and no credits", () => {
    const balance = calculateOutstanding({ dues: [] });

    expect(balance).toEqual({
      principalPaise: 0n,
      lateFeePaise: 0n,
      adjustmentPaise: 0n,
      totalDuePaise: 0n,
      paidPaise: 0n,
      creditsPaise: 0n,
      outstandingPaise: 0n,
      oldestDueDate: null,
    });
  });

  it("sums open principal dues and reports the oldest due date", () => {
    const balance = calculateOutstanding({
      dues: [
        line({ amountPaise: paise(600_000n), dueDate: "2026-10-10" }),
        line({ amountPaise: paise(400_000n), dueDate: "2026-09-15" }),
        // Later than both: the oldest must not move.
        line({ amountPaise: paise(1n), dueDate: "2026-11-01" }),
      ],
    });

    expect(balance.principalPaise).toBe(1_000_001n);
    expect(balance.totalDuePaise).toBe(1_000_001n);
    expect(balance.outstandingPaise).toBe(1_000_001n);
    expect(balance.oldestDueDate).toBe("2026-09-15");
  });

  it("adds late fees and adjustments to the same Σdues term, without double counting", () => {
    const balance = calculateOutstanding({
      dues: [
        line({ amountPaise: paise(500_000n) }),
        line({
          kind: "late_fee",
          amountPaise: paise(2_500n),
          dueDate: "2026-10-20",
        }),
        line({
          kind: "adjustment",
          amountPaise: paise(100n),
          dueDate: "2026-10-25",
        }),
      ],
    });

    expect(balance.principalPaise).toBe(500_000n);
    expect(balance.lateFeePaise).toBe(2_500n);
    expect(balance.adjustmentPaise).toBe(100n);
    expect(balance.totalDuePaise).toBe(502_600n);
    expect(balance.outstandingPaise).toBe(502_600n);
  });

  it("subtracts partial payments recorded on the dues themselves", () => {
    const balance = calculateOutstanding({
      dues: [
        line({
          status: "partial",
          amountPaise: paise(100_000n),
          paidPaise: paise(40_000n),
        }),
        line({ status: "overdue", amountPaise: paise(50_000n) }),
      ],
    });

    expect(balance.paidPaise).toBe(40_000n);
    expect(balance.totalDuePaise).toBe(150_000n);
    expect(balance.outstandingPaise).toBe(110_000n);
  });

  it("subtracts credits exactly once, and reports a negative balance for a member in credit", () => {
    const balance = calculateOutstanding({
      dues: [line({ amountPaise: paise(30_000n) })],
      creditsPaise: paise(50_000n),
    });

    expect(balance.creditsPaise).toBe(50_000n);
    expect(balance.outstandingPaise).toBe(-20_000n);
  });

  it("treats a zero credit as the same zero", () => {
    const withZero = calculateOutstanding({
      dues: [line()],
      creditsPaise: paise(0n),
    });
    const withoutCredits = calculateOutstanding({ dues: [line()] });

    expect(withZero).toEqual(withoutCredits);
  });

  it("ignores settled, waived and written-off dues entirely — amount, paid and date", () => {
    const balance = calculateOutstanding({
      dues: [
        line({
          status: "paid",
          amountPaise: paise(500n),
          paidPaise: paise(500n),
        }),
        line({ status: "waived", amountPaise: paise(700n) }),
        line({
          status: "written_off",
          amountPaise: paise(900n),
          dueDate: "2020-01-01",
        }),
        line({
          status: "pending",
          amountPaise: paise(1_000n),
          dueDate: "2026-10-10",
        }),
      ],
    });

    expect(balance.totalDuePaise).toBe(1_000n);
    expect(balance.paidPaise).toBe(0n);
    expect(balance.oldestDueDate).toBe("2026-10-10");
  });

  it("keeps every paisa exact above Number.MAX_SAFE_INTEGER", () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const balance = calculateOutstanding({
      dues: [
        line({ amountPaise: paise(huge) }),
        line({ amountPaise: paise(1n), dueDate: "2026-10-11" }),
      ],
    });

    expect(balance.outstandingPaise).toBe(huge + 1n);
  });

  it("refuses a negative due amount as a corrupted row", () => {
    try {
      calculateOutstanding({ dues: [line({ amountPaise: paise(-1n) })] });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(isMoneyError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("invariant");
    }
  });

  it("refuses a negative paid amount", () => {
    expect(() =>
      calculateOutstanding({ dues: [line({ paidPaise: paise(-1n) })] }),
    ).toThrow(/negative paidPaise/);
  });

  it("refuses a paid amount above the due amount", () => {
    expect(() =>
      calculateOutstanding({
        dues: [line({ amountPaise: paise(100n), paidPaise: paise(101n) })],
      }),
    ).toThrow(/cannot exceed/);
  });

  it("refuses a negative credit as a caller error, not a row error", () => {
    try {
      calculateOutstanding({ dues: [], creditsPaise: paise(-1n) });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(isMoneyError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("validation");
    }
  });

  it("refuses a non-ISO due date on an open line", () => {
    expect(() =>
      calculateOutstanding({ dues: [line({ dueDate: "10/10/2026" })] }),
    ).toThrow(/ISO/);
  });

  it("does not validate the date of a line it counts nowhere", () => {
    const balance = calculateOutstanding({
      dues: [line({ status: "paid", dueDate: "not-a-date" })],
    });

    expect(balance.oldestDueDate).toBeNull();
  });
});

describe("the vocabulary", () => {
  it("exposes exactly the three kinds the dues CHECK allows", () => {
    expect(DUE_KINDS).toEqual(["principal", "late_fee", "adjustment"]);
  });
});

describe("isOutstandingDue", () => {
  it("accepts exactly the open set", () => {
    for (const status of OUTSTANDING_DUE_STATUSES) {
      expect(isOutstandingDue(status)).toBe(true);
    }
  });

  it("refuses the settled set and anything unknown", () => {
    for (const status of ["paid", "waived", "written_off", "advance", ""]) {
      expect(isOutstandingDue(status)).toBe(false);
    }
  });
});

const STATE: MemberBalanceState = {
  totalDuePaise: paise(150_000n),
  totalPaidPaise: paise(25_000n),
  advancePaise: paise(5_000n),
  outstandingPaise: paise(125_000n),
  oldestDueDate: "2026-10-10",
};

function created(amountPaise: bigint, dueDate: string): CreatedDue {
  return { amountPaise: paise(amountPaise), dueDate };
}

describe("projectDueCreation", () => {
  it("creates the first balance row from nothing", () => {
    const next = projectDueCreation(null, [
      created(600_000n, "2026-11-10"),
      created(400_000n, "2026-11-10"),
    ]);

    expect(next).toEqual({
      totalDuePaise: 1_000_000n,
      totalPaidPaise: 0n,
      advancePaise: 0n,
      outstandingPaise: 1_000_000n,
      oldestDueDate: "2026-11-10",
    });
  });

  it("adds the delta to an existing row and keeps the older due date", () => {
    const next = projectDueCreation(STATE, [created(300_000n, "2026-11-10")]);

    expect(next.totalDuePaise).toBe(450_000n);
    expect(next.outstandingPaise).toBe(425_000n);
    expect(next.oldestDueDate).toBe("2026-10-10");
    // Nothing about payments or credits changes: a publication settles nothing.
    expect(next.totalPaidPaise).toBe(25_000n);
    expect(next.advancePaise).toBe(5_000n);
  });

  it("moves the oldest due date earlier when the new dues are older", () => {
    const next = projectDueCreation(STATE, [created(1n, "2026-09-01")]);

    expect(next.oldestDueDate).toBe("2026-09-01");
  });

  it("is the identity for an empty creation set", () => {
    expect(projectDueCreation(STATE, [])).toBe(STATE);
    expect(projectDueCreation(null, [])).toBe(ZERO_BALANCE);
  });

  it("keeps a member already in credit negative by exactly the delta", () => {
    const inCredit: MemberBalanceState = {
      ...STATE,
      outstandingPaise: paise(-10_000n),
    };
    const next = projectDueCreation(inCredit, [created(4_000n, "2026-11-10")]);

    expect(next.outstandingPaise).toBe(-6_000n);
  });

  it("refuses a negative amount and a non-ISO date", () => {
    expect(() =>
      projectDueCreation(null, [created(-1n, "2026-11-10")]),
    ).toThrow(/negative/);
    expect(() =>
      projectDueCreation(null, [created(1n, "2026-11-10T00:00:00Z")]),
    ).toThrow(/ISO/);
  });
});
