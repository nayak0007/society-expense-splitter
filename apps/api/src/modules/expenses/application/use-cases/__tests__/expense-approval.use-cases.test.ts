import {
  Money,
  asExpenseCategoryId,
  asExpenseId,
  asMemberId,
  asSocietyId,
  asUserId,
  expenseError,
} from "@ses/domain";
import type {
  ApproveExpenseRecordInput,
  ExpenseId,
  ExpenseListQuery,
  ExpenseMembershipReader,
  ExpensePage,
  ExpenseRecord,
  ExpenseRepository,
  MemberId,
  RejectExpenseRecordInput,
  SocietyId,
  SocietyMembership,
  UpdateExpenseRecordInput,
  UserId,
} from "@ses/domain";

import { AppError } from "../../../../../common/errors/app-error";
import { ApproveExpenseUseCase } from "../approve-expense.use-case";
import { RejectExpenseUseCase } from "../reject-expense.use-case";

/**
 * T070's two decisions over contract doubles — the orchestration, the error
 * precedence and the translation into the module's HTTP vocabulary.
 *
 * ## What the double is, and what it is not
 *
 * It implements the **port's** contract: a store, a version/lifecycle refusal and a
 * failure queue. It decides nothing the domain or the definer function decides — the
 * permission matrix, the reason rule and the version comparison against the
 * *database's* row are the real implementations under test. What only PostgreSQL can
 * prove (the row lock, the grant-level refusals, the guard trigger, "zero financial
 * writes") belongs to `expense-approval.integration-spec.ts`, which proves it against
 * a real database.
 */

const SOCIETY = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const OTHER_SOCIETY = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
const ADMIN = asUserId("11111111-1111-4111-8111-111111111111");
const TREASURER = asUserId("22222222-2222-4222-8222-222222222222");
const COMMITTEE = asUserId("77777777-7777-4777-8777-777777777777");
const RESIDENT = asUserId("33333333-3333-4333-8333-333333333333");
const GUEST = asUserId("44444444-4444-4444-8444-444444444444");

const ADMIN_MEMBER = asMemberId("10000000-0000-4000-8000-000000000001");
const TREASURER_MEMBER = asMemberId("10000000-0000-4000-8000-000000000002");

const EXPENSE_ID = asExpenseId("20000000-0000-4000-8000-000000000001");
const CATEGORY = asExpenseCategoryId("0a000000-0000-4000-8000-000000000001");

function membershipOf(
  actor: UserId,
  role: SocietyMembership["role"],
  id: MemberId,
  societyId: SocietyId = SOCIETY,
  status: SocietyMembership["status"] = "active",
): SocietyMembership {
  return {
    id,
    societyId,
    userId: actor,
    role,
    status,
    occupancyType: "owner",
    joinedAt: "2026-01-01T00:00:00.000Z",
  };
}

class FakeMemberships implements ExpenseMembershipReader {
  readonly memberships = new Map<string, SocietyMembership>();

  seed(membership: SocietyMembership): void {
    this.memberships.set(
      `${membership.societyId}:${membership.userId}`,
      membership,
    );
  }

  findMembership(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyMembership | null> {
    return Promise.resolve(
      this.memberships.get(`${societyId}:${actor}`) ?? null,
    );
  }
}

/** The store, the port's refusals, and a queue of injected failures. */
class FakeExpenses implements ExpenseRepository {
  readonly records = new Map<ExpenseId, ExpenseRecord>();
  readonly calls: {
    readonly name: string;
    readonly id: ExpenseId;
    readonly societyId: SocietyId;
    readonly input: unknown;
    readonly actor: UserId;
  }[] = [];
  approveFailures: Error[] = [];
  rejectFailures: Error[] = [];

  seed(record: ExpenseRecord): void {
    this.records.set(record.id, record);
  }

  private record(id: ExpenseId, societyId: SocietyId): ExpenseRecord {
    const stored = this.records.get(id);
    if (stored === undefined || stored.societyId !== societyId) {
      throw expenseError("not_found", "That expense is not available to you.");
    }
    return stored;
  }

  async create(): Promise<ExpenseRecord> {
    throw new Error("not used");
  }

  async findById(
    id: ExpenseId,
    societyId: SocietyId,
  ): Promise<ExpenseRecord | null> {
    this.calls.push({
      name: "findById",
      id,
      societyId,
      input: null,
      actor: "" as UserId,
    });
    const stored = this.records.get(id);
    return stored === undefined || stored.societyId !== societyId
      ? null
      : stored;
  }

  async update(
    _id: ExpenseId,
    _societyId: SocietyId,
    _expectedVersion: number,
    _input: Omit<UpdateExpenseRecordInput, "expectedVersion">,
  ): Promise<ExpenseRecord> {
    throw new Error("not used");
  }

  async list(
    _societyId: SocietyId,
    _query: ExpenseListQuery,
  ): Promise<ExpensePage> {
    throw new Error("not used");
  }

  async deleteDraft(): Promise<void> {
    throw new Error("not used");
  }

  async approve(
    id: ExpenseId,
    societyId: SocietyId,
    input: ApproveExpenseRecordInput,
    actor: UserId,
  ): Promise<ExpenseRecord> {
    this.calls.push({ name: "approve", id, societyId, input, actor });
    const failure = this.approveFailures.shift();
    if (failure !== undefined) throw failure;

    const stored = this.record(id, societyId);
    if (stored.status !== "pending_approval") {
      throw expenseError("invalid_transition", "Not awaiting approval.", {
        from: stored.status,
        to: "approved",
      });
    }
    if (stored.version !== input.expectedVersion) {
      throw expenseError("version_mismatch", "Stale.", {
        field: "expectedVersion",
        expectedVersion: input.expectedVersion,
        currentVersion: stored.version,
      });
    }

    const approved: ExpenseRecord = {
      ...stored,
      approvedBy: stored.createdBy,
      approvedAt: "2026-10-01T10:00:00.000Z",
      version: stored.version + 1,
    };
    this.records.set(id, approved);
    return approved;
  }

  async reject(
    id: ExpenseId,
    societyId: SocietyId,
    input: RejectExpenseRecordInput,
    actor: UserId,
  ): Promise<ExpenseRecord> {
    this.calls.push({ name: "reject", id, societyId, input, actor });
    const failure = this.rejectFailures.shift();
    if (failure !== undefined) throw failure;

    const stored = this.record(id, societyId);
    if (stored.status !== "pending_approval") {
      throw expenseError("invalid_transition", "Not awaiting approval.", {
        from: stored.status,
        to: "draft",
      });
    }
    if (stored.version !== input.expectedVersion) {
      throw expenseError("version_mismatch", "Stale.", {
        field: "expectedVersion",
        expectedVersion: input.expectedVersion,
        currentVersion: stored.version,
      });
    }

    const rejected: ExpenseRecord = {
      ...stored,
      status: "draft",
      approvedBy: null,
      approvedAt: null,
      rejectedBy: stored.createdBy,
      rejectedAt: "2026-10-01T10:00:00.000Z",
      rejectionReason: input.reason,
      version: stored.version + 1,
    };
    this.records.set(id, rejected);
    return rejected;
  }
}

function recordFixture(overrides: Partial<ExpenseRecord> = {}): ExpenseRecord {
  return {
    id: EXPENSE_ID,
    societyId: SOCIETY,
    categoryId: CATEGORY,
    title: "Lift AMC — Q4",
    description: null,
    amount: Money.fromPaise(2_000_000),
    expenseDate: "2026-09-30",
    vendorName: null,
    paymentSource: "society_account",
    paidByMemberId: null,
    splitStrategy: "equal",
    apartmentBasis: null,
    splitConfig: {},
    participantSelector: {},
    status: "pending_approval",
    createdBy: ADMIN_MEMBER,
    publishedAt: null,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    rejectionReason: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

interface Rig {
  readonly expenses: FakeExpenses;
  readonly memberships: FakeMemberships;
  readonly approve: ApproveExpenseUseCase;
  readonly reject: RejectExpenseUseCase;
}

function makeRig(): Rig {
  const expenses = new FakeExpenses();
  const memberships = new FakeMemberships();
  memberships.seed(membershipOf(ADMIN, "admin", ADMIN_MEMBER));
  memberships.seed(membershipOf(TREASURER, "treasurer", TREASURER_MEMBER));
  memberships.seed(membershipOf(COMMITTEE, "committee_member", ADMIN_MEMBER));
  memberships.seed(membershipOf(RESIDENT, "resident", ADMIN_MEMBER));
  memberships.seed(membershipOf(GUEST, "guest", ADMIN_MEMBER));

  return {
    expenses,
    memberships,
    approve: new ApproveExpenseUseCase(expenses, memberships),
    reject: new RejectExpenseUseCase(expenses, memberships),
  };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error: unknown) {
    return error as AppError;
  }
  throw new Error("Expected the call to be refused.");
}

const REASON = "The vendor invoice does not match the quote.";

describe("ApproveExpenseUseCase", () => {
  it("approves a pending_approval expense through the port, with the caller's lock", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());

    const record = await rig.approve.approve(ADMIN, SOCIETY, EXPENSE_ID, {
      expectedVersion: 1,
    });

    expect(record.approvedBy).toBe(ADMIN_MEMBER);
    expect(record.status).toBe("pending_approval");
    expect(record.version).toBe(2);
    const write = rig.expenses.calls.find((call) => call.name === "approve");
    expect(write).toMatchObject({
      id: EXPENSE_ID,
      societyId: SOCIETY,
      input: { expectedVersion: 1 },
      actor: ADMIN,
    });
  });

  it("lets an Admin approve their own expense (D5)", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture({ createdBy: ADMIN_MEMBER }));

    const record = await rig.approve.approve(ADMIN, SOCIETY, EXPENSE_ID, {
      expectedVersion: 1,
    });

    expect(record.approvedBy).toBe(ADMIN_MEMBER);
  });

  it.each([
    ["Treasurer", TREASURER],
    ["Committee Member", COMMITTEE],
    ["Resident", RESIDENT],
    ["Guest", GUEST],
  ])("refuses a %s before any write", async (_label, actor) => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());

    const error = await failure(
      rig.approve.approve(actor, SOCIETY, EXPENSE_ID, { expectedVersion: 1 }),
    );

    expect(error.code).toBe("FORBIDDEN");
    expect(rig.expenses.calls.some((call) => call.name === "approve")).toBe(
      false,
    );
    expect(rig.expenses.records.get(EXPENSE_ID)?.approvedBy).toBeNull();
  });

  it("answers not_found when the caller has no live membership", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());
    rig.memberships.memberships.clear();

    const error = await failure(
      rig.approve.approve(ADMIN, SOCIETY, EXPENSE_ID, { expectedVersion: 1 }),
    );

    expect(error.code).toBe("NOT_FOUND");
  });

  it("answers not_found for another society's expense", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());

    const error = await failure(
      rig.approve.approve(ADMIN, OTHER_SOCIETY, EXPENSE_ID, {
        expectedVersion: 1,
      }),
    );

    expect(error.code).toBe("NOT_FOUND");
  });

  it("refuses anything that is not awaiting approval", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture({ status: "draft" }));

    const error = await failure(
      rig.approve.approve(ADMIN, SOCIETY, EXPENSE_ID, { expectedVersion: 1 }),
    );

    expect(error.code).toBe("INVALID_TRANSITION");
    // The lifecycle's own `from`/`to` stay in the domain error — the wire answer is
    // the catalogue code, exactly as T069's void route answers one.
    expect(rig.expenses.calls.some((call) => call.name === "approve")).toBe(
      false,
    );
  });

  it("refuses a stale version before writing", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());

    const error = await failure(
      rig.approve.approve(ADMIN, SOCIETY, EXPENSE_ID, { expectedVersion: 4 }),
    );

    expect(error.code).toBe("VERSION_MISMATCH");
    expect(error.payload.details?.[0]).toMatchObject({
      field: "expectedVersion",
      received: 4,
      current: 1,
    });
    expect(rig.expenses.calls.some((call) => call.name === "approve")).toBe(
      false,
    );
  });

  it("translates the definer function's already-approved refusal into a conflict", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());
    rig.expenses.approveFailures.push(
      expenseError(
        "invalid_transition",
        "This expense has already been approved.",
        {
          from: "approved",
          to: "approved",
        },
      ),
    );

    const error = await failure(
      rig.approve.approve(ADMIN, SOCIETY, EXPENSE_ID, { expectedVersion: 1 }),
    );

    expect(error.code).toBe("INVALID_TRANSITION");
  });

  it("answers INTERNAL for a failure that is not the module's vocabulary", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());
    rig.expenses.approveFailures.push(new Error("connection reset"));

    const error = await failure(
      rig.approve.approve(ADMIN, SOCIETY, EXPENSE_ID, { expectedVersion: 1 }),
    );

    expect(error.code).toBe("INTERNAL");
  });
});

describe("RejectExpenseUseCase", () => {
  it("rejects a pending_approval expense, returning it to draft with the reason", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());

    const record = await rig.reject.reject(ADMIN, SOCIETY, EXPENSE_ID, {
      expectedVersion: 1,
      reason: REASON,
    });

    expect(record.status).toBe("draft");
    expect(record.rejectionReason).toBe(REASON);
    expect(record.rejectedBy).toBe(ADMIN_MEMBER);
    expect(record.approvedBy).toBeNull();
    expect(record.version).toBe(2);
  });

  it("trims the reason before the port sees it", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());

    const record = await rig.reject.reject(ADMIN, SOCIETY, EXPENSE_ID, {
      expectedVersion: 1,
      reason: `   ${REASON}   `,
    });

    expect(record.rejectionReason).toBe(REASON);
  });

  it("refuses a short reason as a field error on `reason`, before any write", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());

    const error = await failure(
      rig.reject.reject(ADMIN, SOCIETY, EXPENSE_ID, {
        expectedVersion: 1,
        reason: "Too short",
      }),
    );

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.payload.field).toBe("reason");
    expect(rig.expenses.calls.some((call) => call.name === "reject")).toBe(
      false,
    );
  });

  it("refuses control characters in the reason", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());

    const error = await failure(
      rig.reject.reject(ADMIN, SOCIETY, EXPENSE_ID, {
        expectedVersion: 1,
        reason: "Duplicate\u0007 bill from the vendor",
      }),
    );

    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("answers the lifecycle and the lock before the reason — the database's order", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture({ status: "published" }));

    const lifecycle = await failure(
      rig.reject.reject(ADMIN, SOCIETY, EXPENSE_ID, {
        expectedVersion: 1,
        reason: "short",
      }),
    );
    expect(lifecycle.code).toBe("INVALID_TRANSITION");

    const rig2 = makeRig();
    rig2.expenses.seed(recordFixture());
    const stale = await failure(
      rig2.reject.reject(ADMIN, SOCIETY, EXPENSE_ID, {
        expectedVersion: 9,
        reason: "short",
      }),
    );
    expect(stale.code).toBe("VERSION_MISMATCH");
  });

  it.each([
    ["Treasurer", TREASURER],
    ["Committee Member", COMMITTEE],
    ["Resident", RESIDENT],
    ["Guest", GUEST],
  ])("refuses a %s", async (_label, actor) => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());

    const error = await failure(
      rig.reject.reject(actor, SOCIETY, EXPENSE_ID, {
        expectedVersion: 1,
        reason: REASON,
      }),
    );

    expect(error.code).toBe("FORBIDDEN");
    expect(rig.expenses.records.get(EXPENSE_ID)?.status).toBe(
      "pending_approval",
    );
  });

  it("answers not_found for another society's expense", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());

    const error = await failure(
      rig.reject.reject(ADMIN, OTHER_SOCIETY, EXPENSE_ID, {
        expectedVersion: 1,
        reason: REASON,
      }),
    );

    expect(error.code).toBe("NOT_FOUND");
  });

  it("translates a definer function failure and an unknown failure", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());
    rig.expenses.rejectFailures.push(
      expenseError("not_found", "That expense is not available to you."),
    );

    const notFound = await failure(
      rig.reject.reject(ADMIN, SOCIETY, EXPENSE_ID, {
        expectedVersion: 1,
        reason: REASON,
      }),
    );
    expect(notFound.code).toBe("NOT_FOUND");

    rig.expenses.rejectFailures.push(new Error("connection reset"));
    const internal = await failure(
      rig.reject.reject(ADMIN, SOCIETY, EXPENSE_ID, {
        expectedVersion: 1,
        reason: REASON,
      }),
    );
    expect(internal.code).toBe("INTERNAL");
  });
});
