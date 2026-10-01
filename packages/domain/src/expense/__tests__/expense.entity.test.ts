import { fixedClock } from "../../shared/clock";
import { DomainError } from "../../shared/errors";
import {
  asApartmentId,
  asExpenseCategoryId,
  asExpenseId,
  asMemberId,
  asSocietyId,
} from "../../shared/ids";
import { Money, weight } from "../../shared/money.vo";
import type { Result } from "../../shared/result";
import {
  createExpenseDate,
  createExpenseTitle,
  createVoidReason,
  EXPENSE_STATUSES,
  EXPENSE_TRANSITIONS,
  Expense,
  isExpenseStatus,
} from "../expense.entity";
import type {
  CreateExpenseProps,
  ExpenseStatus,
  ReconstituteExpenseProps,
} from "../expense.entity";
import { ExpenseSplit } from "../expense-split.vo";
import type { ExpenseSplitAllocation } from "../expense-split.vo";
import {
  asExpenseError,
  expenseError,
  expenseErrorCode,
  ExpenseError,
  InvalidTransitionError,
  isExpenseError,
} from "../errors";
import { isExpenseEvent } from "../events";

/**
 * T061's entity matrix — every transition the machine has, every refusal it owes,
 * and the one invariant the whole module exists for (SAD §3.2).
 *
 * The vocabulary assertions are written against the *literal* document values
 * rather than against the constants, for the reason `role-rules.test.ts` records: a
 * change to a constant should be a deliberate act with a failing test in front of
 * it. They also mirror `public.expense_status` in the T060 migration, so a value
 * that exists in TypeScript but not in the database is caught here rather than as a
 * `22P02` at publish time.
 */

const NOW = new Date("2026-10-01T10:00:00.000Z");
const CLOCK = fixedClock(NOW);
const LATER = fixedClock("2026-10-02T10:00:00.000Z");

const ID = asExpenseId("33333333-3333-4333-8333-333333333333");
const SOCIETY = asSocietyId("44444444-4444-4444-8444-444444444444");
const CATEGORY = asExpenseCategoryId("55555555-5555-4555-8555-555555555555");
const MEMBER = asMemberId("66666666-6666-4666-8666-666666666666");
const OTHER_MEMBER = asMemberId("77777777-7777-4777-8777-777777777777");

/** ₹10,000 — the amount most publish tests split. */
const AMOUNT = Money.fromPaise(1_000_000);

function makeProps(
  overrides: Partial<CreateExpenseProps> = {},
): CreateExpenseProps {
  return {
    id: ID,
    societyId: SOCIETY,
    categoryId: CATEGORY,
    title: "Lift AMC — Q3",
    amount: AMOUNT,
    expenseDate: "2026-09-30",
    createdBy: MEMBER,
    clock: CLOCK,
    ...overrides,
  };
}

function makeDraft(overrides: Partial<CreateExpenseProps> = {}): Expense {
  const created = Expense.create(makeProps(overrides));
  if (!created.ok) {
    throw new Error(`makeDraft: ${created.error.message}`);
  }
  return created.value;
}

function allocation(
  paise: bigint,
  n: number,
  overrides: Partial<ExpenseSplitAllocation> = {},
): ExpenseSplitAllocation {
  return {
    memberId: asMemberId(`member-${n}`),
    apartmentId: asApartmentId(`apartment-${n}`),
    apartmentNumber: `A-${100 + n}`,
    amount: Money.fromPaise(paise),
    weight: weight(1n),
    ...overrides,
  };
}

function makePublished(): Expense {
  const expense = makeDraft();
  const published = expense.publish(
    [allocation(600_000n, 1), allocation(400_000n, 2)],
    CLOCK,
  );
  if (!published.ok) {
    throw new Error(`makePublished: ${published.error.message}`);
  }
  return expense;
}

function makeVoided(): Expense {
  const expense = makePublished();
  const voided = expense.void_("Duplicate of the August bill", MEMBER, LATER);
  if (!voided.ok) {
    throw new Error(`makeVoided: ${voided.error.message}`);
  }
  return expense;
}

function reconstitutionProps(
  overrides: Partial<ReconstituteExpenseProps> = {},
): ReconstituteExpenseProps {
  return {
    id: ID,
    societyId: SOCIETY,
    categoryId: CATEGORY,
    title: "Lift AMC — Q3",
    amount: AMOUNT,
    expenseDate: "2026-09-30",
    createdBy: MEMBER,
    status: "draft",
    splits: [],
    publishedAt: null,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

/** The fields a failed operation must leave untouched. */
function stateOf(expense: Expense) {
  return {
    status: expense.status,
    splits: expense.splits.length,
    publishedAt: expense.publishedAt,
    voidedAt: expense.voidedAt,
    voidedBy: expense.voidedBy,
    voidReason: expense.voidReason,
    updatedAt: expense.updatedAt,
    version: expense.version,
  };
}

function expectInvalidTransition(
  result: Result<unknown, ExpenseError>,
  from: ExpenseStatus,
  to: ExpenseStatus,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(InvalidTransitionError);
  expect(result.error).toBeInstanceOf(DomainError);
  expect(result.error.code).toBe("invalid_transition");
  const error = result.error as InvalidTransitionError;
  expect(error.from).toBe(from);
  expect(error.to).toBe(to);
  expect(error.details).toEqual({ from, to });
}

// ─────────────────────────────────────────────────────────────────────────────

describe("the expense vocabulary", () => {
  it("is PRD §7.1's enum, verbatim", () => {
    expect([...EXPENSE_STATUSES]).toEqual([
      "draft",
      "pending_approval",
      "published",
      "void",
    ]);
  });

  it("narrows unknown strings", () => {
    expect(isExpenseStatus("published")).toBe(true);
    expect(isExpenseStatus("approved")).toBe(false);
    expect(isExpenseStatus(undefined)).toBe(false);
  });

  it("declares the transition matrix the documents describe", () => {
    // Draft publishes directly (PRD §3.4) or submits for approval (PRD §2.2);
    // published is reachable from either state (SAD §3.2's sketch); void is only
    // reachable from published (PRD §3.5) and is terminal.
    expect(EXPENSE_TRANSITIONS).toEqual({
      draft: ["pending_approval", "published"],
      pending_approval: ["published"],
      published: ["void"],
      void: [],
    });
  });

  it("keeps canTransitionTo in step with the matrix from every state", () => {
    const expenses: Record<ExpenseStatus, Expense> = {
      draft: makeDraft(),
      pending_approval: makeDraft(),
      published: makePublished(),
      void: makeVoided(),
    };
    const submitted = expenses.pending_approval.submitForApproval(CLOCK);
    expect(submitted.ok).toBe(true);

    for (const state of EXPENSE_STATUSES) {
      const expense = expenses[state];
      for (const target of EXPENSE_STATUSES) {
        expect(expense.canTransitionTo(target)).toBe(
          EXPENSE_TRANSITIONS[state].includes(target),
        );
      }
    }
  });
});

describe("Expense.create", () => {
  it("creates a draft — PRD §3.4's initial state — with clean defaults", () => {
    const expense = makeDraft();

    expect(expense.status).toBe("draft");
    expect(expense.splits).toEqual([]);
    expect(expense.publishedAt).toBeNull();
    expect(expense.voidedAt).toBeNull();
    expect(expense.voidedBy).toBeNull();
    expect(expense.voidReason).toBeNull();
    expect(expense.version).toBe(1);
    expect(expense.id).toBe(ID);
    expect(expense.societyId).toBe(SOCIETY);
    expect(expense.categoryId).toBe(CATEGORY);
    expect(expense.createdBy).toBe(MEMBER);
    expect(expense.amount.equals(AMOUNT)).toBe(true);
    expect(expense.expenseDate).toBe("2026-09-30");
    expect(expense.createdAt).toBe("2026-10-01T10:00:00.000Z");
    expect(expense.updatedAt).toBe(expense.createdAt);
  });

  it("trims the title and the date it is handed", () => {
    const expense = makeDraft({
      title: "  Lift AMC  ",
      expenseDate: " 2026-09-30 ",
    });
    expect(expense.title).toBe("Lift AMC");
    expect(expense.expenseDate).toBe("2026-09-30");
  });

  it("refuses a zero amount", () => {
    const created = Expense.create(makeProps({ amount: Money.zero() }));
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.error.code).toBe("validation");
    expect(created.error.details?.field).toBe("amount");
    expect(created.error.message).toContain("₹0.00");
  });

  it("refuses a negative amount", () => {
    const created = Expense.create(
      makeProps({ amount: Money.fromPaise(-500) }),
    );
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.details?.field).toBe("amount");
  });

  it("accepts the smallest possible amount — one paisa", () => {
    const created = Expense.create(makeProps({ amount: Money.fromPaise(1) }));
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.amount.paise).toBe(1n);
  });

  it("refuses an empty or whitespace-only title", () => {
    for (const title of ["", "   "]) {
      const created = Expense.create(makeProps({ title }));
      expect(created.ok).toBe(false);
      if (!created.ok) {
        expect(created.error.code).toBe("validation");
        expect(created.error.details?.field).toBe("title");
      }
    }
  });

  it("refuses a title over 120 characters and accepts exactly 120", () => {
    const accepted = Expense.create(makeProps({ title: "a".repeat(120) }));
    expect(accepted.ok).toBe(true);

    const refused = Expense.create(makeProps({ title: "a".repeat(121) }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.details?.field).toBe("title");
  });

  it("refuses control characters in the title", () => {
    const created = Expense.create(makeProps({ title: "Lift\u0007 AMC" }));
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.code).toBe("validation");
  });

  it("refuses a malformed expense date", () => {
    for (const expenseDate of [
      "",
      "01-10-2026",
      "2026-9-1",
      "2026-10-01T00:00:00Z",
    ]) {
      const created = Expense.create(makeProps({ expenseDate }));
      expect(created.ok).toBe(false);
      if (!created.ok) {
        expect(created.error.code).toBe("validation");
        expect(created.error.details?.field).toBe("expenseDate");
      }
    }
  });

  it("refuses a date that does not exist on the calendar", () => {
    // `Date` would roll 2026-02-30 forward into March; the round-trip check is what
    // keeps a typo from becoming a March bill.
    const created = Expense.create(makeProps({ expenseDate: "2026-02-30" }));
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.message).toContain("2026-02-30");
  });

  it("accepts today and a past date — the bound is only on the future", () => {
    expect(Expense.create(makeProps({ expenseDate: "2026-10-01" })).ok).toBe(
      true,
    );
    expect(Expense.create(makeProps({ expenseDate: "2020-01-01" })).ok).toBe(
      true,
    );
  });

  it("accepts exactly 30 days ahead and refuses 31", () => {
    expect(Expense.create(makeProps({ expenseDate: "2026-10-31" })).ok).toBe(
      true,
    );

    const refused = Expense.create(makeProps({ expenseDate: "2026-11-01" }));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.message).toContain("30 days");
      expect(expenseErrorCode(refused.error)).toBe("validation");
    }
  });

  it("reads 'today' from the injected clock, never the wall clock", () => {
    const frozen = fixedClock("2026-01-01T00:00:00.000Z");
    const created = Expense.create(
      makeProps({ clock: frozen, expenseDate: "2026-01-31" }),
    );
    expect(created.ok).toBe(true);
    const refused = Expense.create(
      makeProps({ clock: frozen, expenseDate: "2026-02-01" }),
    );
    expect(refused.ok).toBe(false);
  });
});

describe("submitForApproval", () => {
  it("moves draft to pending_approval, stamping and bumping the version", () => {
    const expense = makeDraft();
    const result = expense.submitForApproval(LATER);

    expect(result.ok).toBe(true);
    expect(expense.status).toBe("pending_approval");
    expect(expense.updatedAt).toBe("2026-10-02T10:00:00.000Z");
    expect(expense.version).toBe(2);
    expect(expense.createdAt).toBe("2026-10-01T10:00:00.000Z");
  });

  it("refuses a draft that is already pending approval", () => {
    const expense = makeDraft();
    expect(expense.submitForApproval(CLOCK).ok).toBe(true);

    expectInvalidTransition(
      expense.submitForApproval(CLOCK),
      "pending_approval",
      "pending_approval",
    );
  });

  it("refuses a published expense", () => {
    const expense = makePublished();
    expectInvalidTransition(
      expense.submitForApproval(CLOCK),
      "published",
      "pending_approval",
    );
  });

  it("refuses a voided expense", () => {
    const expense = makeVoided();
    expectInvalidTransition(
      expense.submitForApproval(CLOCK),
      "void",
      "pending_approval",
    );
  });
});

describe("publish", () => {
  it("publishes a draft whose splits balance exactly, and raises the event", () => {
    const expense = makeDraft();
    const result = expense.publish(
      [allocation(600_000n, 1), allocation(400_000n, 2)],
      CLOCK,
    );

    expect(result.ok).toBe(true);
    expect(expense.status).toBe("published");
    expect(expense.publishedAt).toBe("2026-10-01T10:00:00.000Z");
    expect(expense.updatedAt).toBe(expense.publishedAt);
    expect(expense.version).toBe(2);
    expect(expense.splits).toHaveLength(2);
    expect(expense.splits[0]?.amount.paise).toBe(600_000n);
    expect(expense.splits[1]?.amount.paise).toBe(400_000n);

    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    const event = result.value[0];
    expect(event?.name).toBe("expense.published");
    if (event?.name === "expense.published") {
      expect(event.expenseId).toBe(ID);
      expect(event.societyId).toBe(SOCIETY);
      expect(event.amount.equals(AMOUNT)).toBe(true);
      expect(event.occurredAt).toBe(expense.publishedAt);
    }
    expect(isExpenseEvent(event)).toBe(true);
  });

  it("publishes a pending-approval expense — the direct path the threshold uses", () => {
    const expense = makeDraft();
    expect(expense.submitForApproval(CLOCK).ok).toBe(true);

    const result = expense.publish([allocation(1_000_000n, 1)], CLOCK);
    expect(result.ok).toBe(true);
    expect(expense.status).toBe("published");
    expect(expense.version).toBe(3);
  });

  it("freezes the splits it accepts", () => {
    const expense = makePublished();
    expect(Object.isFrozen(expense.splits)).toBe(true);
    expect(expense.splits.every((split) => Object.isFrozen(split))).toBe(true);
    expect(expense.splits.every((split) => split instanceof ExpenseSplit)).toBe(
      true,
    );
  });

  it("allocates an amount that does not divide evenly, exactly", () => {
    const expense = makeDraft({ amount: Money.fromPaise(10_000) });
    const result = expense.publish(
      [allocation(3_334n, 1), allocation(3_333n, 2), allocation(3_333n, 3)],
      CLOCK,
    );
    expect(result.ok).toBe(true);
    expect(
      expense.splits.reduce((sum, split) => sum + split.amount.paise, 0n),
    ).toBe(10_000n);
  });

  it("allows a deliberately exempt zero allocation", () => {
    const expense = makeDraft({ amount: Money.fromPaise(10_000) });
    const result = expense.publish(
      [allocation(10_000n, 1), allocation(0n, 2)],
      CLOCK,
    );
    expect(result.ok).toBe(true);
    expect(expense.splits[1]?.amount.isZero()).toBe(true);
  });

  it("refuses a one-paisa shortfall and leaves the expense untouched", () => {
    const expense = makeDraft();
    const before = stateOf(expense);

    const result = expense.publish(
      [allocation(600_000n, 1), allocation(399_999n, 2)],
      CLOCK,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("split_mismatch");
      expect(result.error.details?.totalPaise).toBe("999999");
      expect(result.error.details?.amountPaise).toBe("1000000");
    }
    expect(stateOf(expense)).toEqual(before);
  });

  it("refuses a one-paisa over-allocation", () => {
    const expense = makeDraft();
    const before = stateOf(expense);

    const result = expense.publish(
      [allocation(600_000n, 1), allocation(400_001n, 2)],
      CLOCK,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("split_mismatch");
    expect(stateOf(expense)).toEqual(before);
  });

  it("refuses a larger mismatch in both directions", () => {
    for (const paise of [500_000n, 1_500_000n]) {
      const expense = makeDraft();
      const result = expense.publish([allocation(paise, 1)], CLOCK);
      expect(result.ok).toBe(false);
    }
  });

  it("refuses no allocations at all — an empty sum is not the amount", () => {
    const expense = makeDraft();
    const before = stateOf(expense);

    const result = expense.publish([], CLOCK);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("split_mismatch");
    expect(stateOf(expense)).toEqual(before);
  });

  it("refuses a negative allocation without changing state", () => {
    const expense = makeDraft();
    const before = stateOf(expense);

    const result = expense.publish(
      [allocation(1_200_000n, 1), allocation(-200_000n, 2)],
      CLOCK,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
      expect(expenseErrorCode(result.error)).toBe("validation");
    }
    expect(stateOf(expense)).toEqual(before);
  });

  it("refuses an allocation with no flat label", () => {
    const expense = makeDraft();
    const result = expense.publish(
      [allocation(1_000_000n, 1, { apartmentNumber: "  " })],
      CLOCK,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("refuses publishing an already-published expense", () => {
    const expense = makePublished();
    const before = stateOf(expense);

    expectInvalidTransition(
      expense.publish([allocation(1_000_000n, 1)], CLOCK),
      "published",
      "published",
    );
    expect(stateOf(expense)).toEqual(before);
  });

  it("refuses publishing a voided expense", () => {
    const expense = makeVoided();
    expectInvalidTransition(
      expense.publish([allocation(1_000_000n, 1)], CLOCK),
      "void",
      "published",
    );
  });
});

describe("void_", () => {
  it("voids a published expense with its reason, author and instant", () => {
    const expense = makePublished();
    const result = expense.void_(
      "Duplicate of the August bill",
      OTHER_MEMBER,
      LATER,
    );

    expect(result.ok).toBe(true);
    expect(expense.status).toBe("void");
    expect(expense.voidReason).toBe("Duplicate of the August bill");
    expect(expense.voidedBy).toBe(OTHER_MEMBER);
    expect(expense.voidedAt).toBe("2026-10-02T10:00:00.000Z");
    expect(expense.updatedAt).toBe(expense.voidedAt);
    expect(expense.version).toBe(3);

    if (!result.ok) return;
    const event = result.value[0];
    expect(event?.name).toBe("expense.voided");
    if (event?.name === "expense.voided") {
      expect(event.expenseId).toBe(ID);
      expect(event.societyId).toBe(SOCIETY);
      expect(event.voidedBy).toBe(OTHER_MEMBER);
      expect(event.reason).toBe("Duplicate of the August bill");
      expect(event.occurredAt).toBe(expense.voidedAt);
    }
  });

  it("stores the trimmed reason and accepts exactly ten characters", () => {
    const expense = makePublished();
    const result = expense.void_("  ten chars!  ", MEMBER, CLOCK);
    expect(result.ok).toBe(true);
    expect(expense.voidReason).toBe("ten chars!");
  });

  it("refuses a reason shorter than ten characters", () => {
    const expense = makePublished();
    const before = stateOf(expense);

    const result = expense.void_("too short", MEMBER, CLOCK);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("void_reason_too_short");
      expect(result.error.details?.field).toBe("voidReason");
      expect(expenseErrorCode(result.error)).toBe("void_reason_too_short");
    }
    expect(stateOf(expense)).toEqual(before);
  });

  it("refuses a reason that is only whitespace", () => {
    const expense = makePublished();
    const result = expense.void_("               ", MEMBER, CLOCK);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("void_reason_too_short");
  });

  it("refuses control characters in the reason", () => {
    const expense = makePublished();
    const result = expense.void_("Bad\u0007 reason here", MEMBER, CLOCK);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation");
  });

  it("validates the reason before the transition — the field error wins", () => {
    // SAD §3.2's sketch checks the reason first, and the test states the consequence:
    // a draft voided with a short reason answers "what should I type", not
    // "this is a draft".
    const expense = makeDraft();
    const result = expense.void_("short", MEMBER, CLOCK);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("void_reason_too_short");
  });

  it("refuses a draft, whatever the reason says", () => {
    const expense = makeDraft();
    const before = stateOf(expense);

    expectInvalidTransition(
      expense.void_("A perfectly good reason", MEMBER, CLOCK),
      "draft",
      "void",
    );
    expect(stateOf(expense)).toEqual(before);
  });

  it("refuses a pending-approval expense", () => {
    const expense = makeDraft();
    expect(expense.submitForApproval(CLOCK).ok).toBe(true);

    expectInvalidTransition(
      expense.void_("A perfectly good reason", MEMBER, CLOCK),
      "pending_approval",
      "void",
    );
  });

  it("refuses a second void and keeps the first reason", () => {
    const expense = makeVoided();
    const before = stateOf(expense);

    expectInvalidTransition(
      expense.void_("A different reason", MEMBER, LATER),
      "void",
      "void",
    );
    expect(stateOf(expense)).toEqual(before);
    expect(expense.voidReason).toBe("Duplicate of the August bill");
  });

  it("is terminal — no transition leaves void", () => {
    const expense = makeVoided();

    expectInvalidTransition(
      expense.publish([allocation(1_000_000n, 1)], CLOCK),
      "void",
      "published",
    );
    expectInvalidTransition(
      expense.submitForApproval(CLOCK),
      "void",
      "pending_approval",
    );
  });
});

describe("Expense.reconstitute", () => {
  it("rebuilds a draft without re-running creation's rules", () => {
    // The title and date were judged on the day the expense was written; a read
    // must not make a stored row unreadable because the clock moved or because a
    // longer title was legal under an older bound.
    const rebuilt = Expense.reconstitute(
      reconstitutionProps({
        title: "A title that would not pass create() today".repeat(3),
        expenseDate: "2030-01-01",
        status: "draft",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
        version: 4,
      }),
    );

    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.value.status).toBe("draft");
    expect(rebuilt.value.createdAt).toBe("2026-09-01T00:00:00.000Z");
    expect(rebuilt.value.updatedAt).toBe("2026-09-02T00:00:00.000Z");
    expect(rebuilt.value.version).toBe(4);
  });

  it("rebuilds a published expense with its balanced splits", () => {
    const rebuilt = Expense.reconstitute(
      reconstitutionProps({
        status: "published",
        splits: [allocation(600_000n, 1), allocation(400_000n, 2)],
        publishedAt: "2026-09-30T12:00:00.000Z",
        version: 2,
      }),
    );

    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.value.status).toBe("published");
    expect(rebuilt.value.publishedAt).toBe("2026-09-30T12:00:00.000Z");
    expect(rebuilt.value.splits).toHaveLength(2);
    expect(rebuilt.value.splits[0]).toBeInstanceOf(ExpenseSplit);
    expect(Object.isFrozen(rebuilt.value.splits)).toBe(true);
  });

  it("rebuilds a voided expense", () => {
    const rebuilt = Expense.reconstitute(
      reconstitutionProps({
        status: "void",
        splits: [allocation(600_000n, 1), allocation(400_000n, 2)],
        publishedAt: "2026-09-30T12:00:00.000Z",
        voidedAt: "2026-10-01T09:00:00.000Z",
        voidedBy: OTHER_MEMBER,
        voidReason: "Duplicate of the August bill",
        version: 3,
      }),
    );
    expect(rebuilt.ok).toBe(true);
    if (rebuilt.ok) {
      expect(rebuilt.value.voidReason).toBe("Duplicate of the August bill");
      expect(rebuilt.value.voidedBy).toBe(OTHER_MEMBER);
    }
  });

  it("keeps splits on a draft — the database allows an incomplete ledger", () => {
    const rebuilt = Expense.reconstitute(
      reconstitutionProps({
        status: "draft",
        splits: [allocation(1_000n, 1)],
      }),
    );
    expect(rebuilt.ok).toBe(true);
    if (rebuilt.ok) expect(rebuilt.value.splits).toHaveLength(1);
  });

  it("refuses a published expense without its instant", () => {
    const rebuilt = Expense.reconstitute(
      reconstitutionProps({
        status: "published",
        splits: [allocation(1_000_000n, 1)],
        publishedAt: null,
      }),
    );
    expect(rebuilt.ok).toBe(false);
    if (!rebuilt.ok) {
      expect(rebuilt.error.code).toBe("invariant");
      expect(rebuilt.error.details?.field).toBe("publishedAt");
    }
  });

  it("refuses a published expense whose splits no longer balance", () => {
    // The same rule the T060 deferred trigger enforces at COMMIT; a read that
    // violates it is a corrupt bill, not a form mistake.
    const rebuilt = Expense.reconstitute(
      reconstitutionProps({
        status: "published",
        splits: [allocation(600_000n, 1), allocation(399_999n, 2)],
        publishedAt: "2026-09-30T12:00:00.000Z",
      }),
    );
    expect(rebuilt.ok).toBe(false);
    if (!rebuilt.ok) expect(rebuilt.error.code).toBe("split_mismatch");
  });

  it("refuses a voided expense that lost its reason", () => {
    const rebuilt = Expense.reconstitute(
      reconstitutionProps({
        status: "void",
        voidedAt: "2026-10-01T09:00:00.000Z",
        voidedBy: OTHER_MEMBER,
        voidReason: null,
      }),
    );
    expect(rebuilt.ok).toBe(false);
    if (!rebuilt.ok) expect(rebuilt.error.code).toBe("invariant");
  });

  it("refuses void fields on an expense that is not void", () => {
    const rebuilt = Expense.reconstitute(
      reconstitutionProps({
        status: "published",
        splits: [allocation(1_000_000n, 1)],
        publishedAt: "2026-09-30T12:00:00.000Z",
        voidedAt: "2026-10-01T09:00:00.000Z",
        voidedBy: OTHER_MEMBER,
        voidReason: "A reason that exists",
      }),
    );
    expect(rebuilt.ok).toBe(false);
    if (!rebuilt.ok) expect(rebuilt.error.details?.field).toBe("status");
  });

  it("refuses a status the enum does not have", () => {
    const rebuilt = Expense.reconstitute(
      reconstitutionProps({
        status: "approved" as unknown as ExpenseStatus,
      }),
    );
    expect(rebuilt.ok).toBe(false);
    if (!rebuilt.ok) expect(rebuilt.error.code).toBe("invariant");
  });

  it("refuses a version below one, or a fractional one", () => {
    for (const version of [0, -1, 1.5]) {
      const rebuilt = Expense.reconstitute(reconstitutionProps({ version }));
      expect(rebuilt.ok).toBe(false);
      if (!rebuilt.ok) expect(rebuilt.error.details?.field).toBe("version");
    }
  });

  it("refuses a negative persisted split", () => {
    const rebuilt = Expense.reconstitute(
      reconstitutionProps({ splits: [allocation(-1n, 1)] }),
    );
    expect(rebuilt.ok).toBe(false);
    if (!rebuilt.ok) expect(rebuilt.error.code).toBe("validation");
  });
});

describe("the exported field rules", () => {
  it("createExpenseTitle keeps internal spacing and trims the edges", () => {
    const title = createExpenseTitle("  Lift  AMC — Q3  ");
    expect(title.ok).toBe(true);
    if (title.ok) expect(title.value).toBe("Lift  AMC — Q3");
  });

  it("createExpenseDate rejects a rolled-over calendar date", () => {
    expect(createExpenseDate("2026-02-29", NOW).ok).toBe(false);
    expect(createExpenseDate("2024-02-29", NOW).ok).toBe(true);
  });

  it("createVoidReason refuses nine characters and accepts ten", () => {
    expect(createVoidReason("123456789").ok).toBe(false);
    expect(createVoidReason("1234567890").ok).toBe(true);
  });

  it("expenseErrorCode reports unknown for anything else", () => {
    expect(expenseErrorCode(new Error("boom"))).toBe("unknown");
    expect(expenseErrorCode(undefined)).toBe("unknown");
  });

  it("exposes the module's error helpers", () => {
    const error = expenseError("validation", "boom", { field: "amount" });
    expect(error).toBeInstanceOf(ExpenseError);
    expect(error).toBeInstanceOf(DomainError);
    expect(error.name).toBe("ExpenseError");
    expect(error.details).toEqual({ field: "amount" });

    expect(isExpenseError(error)).toBe(true);
    expect(isExpenseError(new Error("boom"))).toBe(false);

    // An adapter throw is classified as `unknown`; the adapter is expected to have
    // classified its own failures.
    expect(asExpenseError(error)).toBe(error);
    expect(asExpenseError(new Error("boom")).code).toBe("unknown");
  });

  it("isExpenseEvent narrows the two event names and nothing else", () => {
    expect(isExpenseEvent({ name: "expense.published" })).toBe(true);
    expect(isExpenseEvent({ name: "expense.voided" })).toBe(true);
    expect(isExpenseEvent({ name: "expense.approved" })).toBe(false);
    expect(isExpenseEvent(null)).toBe(false);
    expect(isExpenseEvent("expense.published")).toBe(false);
  });
});
