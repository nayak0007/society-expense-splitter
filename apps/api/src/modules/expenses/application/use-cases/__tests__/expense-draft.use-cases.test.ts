import {
  Money,
  asExpenseCategoryId,
  asExpenseId,
  asMemberId,
  asSocietyId,
  asUserId,
  expenseError,
  fixedClock,
} from "@ses/domain";
import type {
  CreateExpenseRecordInput,
  ExpenseApprovalPolicy,
  ExpenseApprovalPolicyReader,
  ExpenseCategory,
  ExpenseCategoryId,
  ExpenseCategoryRepository,
  ExpenseCursor,
  ExpenseId,
  ExpenseListQuery,
  ExpenseMembershipReader,
  ExpensePage,
  ExpenseRecord,
  ExpenseRepository,
  SocietyId,
  SocietyMembership,
  UpdateExpenseRecordInput,
  UserId,
} from "@ses/domain";

import { AppError } from "../../../../../common/errors/app-error";
import { CreateExpenseUseCase } from "../create-expense.use-case";
import { DeleteDraftUseCase } from "../delete-draft.use-case";
import {
  decodeExpenseCursor,
  encodeExpenseCursor,
  ListExpensesUseCase,
} from "../list-expenses.use-case";
import { GetExpenseUseCase } from "../get-expense.use-case";
import { UpdateExpenseUseCase } from "../update-expense.use-case";

/**
 * T065's five use cases over contract-double dependencies.
 *
 * ## What the doubles are, and what they are not
 *
 * They implement the **ports' contracts** — a store, a version check, a set of
 * filters — and nothing of the production rules beyond the failures a caller must
 * meet: a stale version throws `version_mismatch` carrying the current version, a
 * non-creator delete is refused, a foreign-society id answers `null`. The domain
 * rules under test (lifecycle, title/date, canonical selector, threshold) are the
 * real implementations: a broken domain rule fails here, and the fakes cannot hide
 * it because they are not asked to decide any of it.
 *
 * What only the integration suite can prove — real SQL, RLS, the definer function
 * and the atomic `WHERE version = …` — is asserted there against PostgreSQL; this
 * file pins the orchestration, the error mapping and the merge semantics.
 */

const SOCIETY = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const OTHER_SOCIETY = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
const ADMIN = asUserId("11111111-1111-4111-8111-111111111111");
const TREASURER = asUserId("22222222-2222-4222-8222-222222222222");
const COMMITTEE = asUserId("77777777-7777-4777-8777-777777777777");
const RESIDENT = asUserId("33333333-3333-4333-8333-333333333333");
const CLOCK = fixedClock("2026-10-01T10:00:00.000Z");

const CATEGORY = asExpenseCategoryId("55555555-5555-4555-8555-555555555555");
const OTHER_CATEGORY = asExpenseCategoryId(
  "99999999-9999-4999-8999-999999999999",
);

const ADMIN_MEMBER = asMemberId("10000000-0000-4000-8000-000000000001");
const TREASURER_MEMBER = asMemberId("10000000-0000-4000-8000-000000000002");
const COMMITTEE_MEMBER = asMemberId("10000000-0000-4000-8000-000000000003");

function membershipOf(
  actor: UserId,
  role: SocietyMembership["role"],
  id = asMemberId(`10000000-0000-4000-8000-${actor.slice(24, 36)}`),
): SocietyMembership {
  return {
    id,
    societyId: SOCIETY,
    userId: actor,
    role,
    status: "active",
    occupancyType: "owner",
    joinedAt: null,
  };
}

const ADMIN_MEMBERSHIP = membershipOf(ADMIN, "admin", ADMIN_MEMBER);
const TREASURER_MEMBERSHIP = membershipOf(
  TREASURER,
  "treasurer",
  TREASURER_MEMBER,
);
const COMMITTEE_MEMBERSHIP = membershipOf(
  COMMITTEE,
  "committee_member",
  COMMITTEE_MEMBER,
);

/** The four ports the create/update/delete use cases compose. */
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

class FakeCategories implements ExpenseCategoryRepository {
  readonly categories = new Map<string, ExpenseCategory>();
  /** A title-only edit must not pay for a category read; the update suite asserts this. */
  reads = 0;

  seed(category: ExpenseCategory): void {
    this.categories.set(category.id, category);
  }

  findCategory(
    id: ExpenseCategoryId,
    societyId: SocietyId,
  ): Promise<ExpenseCategory | null> {
    this.reads += 1;
    const category = this.categories.get(id);
    if (category === undefined || category.societyId !== societyId) {
      return Promise.resolve(null);
    }
    return Promise.resolve(category);
  }

  listCategories(): Promise<readonly ExpenseCategory[]> {
    return Promise.resolve([...this.categories.values()]);
  }

  findByName(): Promise<ExpenseCategory | null> {
    return Promise.resolve(null);
  }

  create(): Promise<ExpenseCategory> {
    throw new Error("not used");
  }

  update(): Promise<ExpenseCategory> {
    throw new Error("not used");
  }

  remove(): Promise<void> {
    throw new Error("not used");
  }
}

class FakePolicies implements ExpenseApprovalPolicyReader {
  readonly thresholds = new Map<string, bigint>();
  calls = 0;

  seed(societyId: SocietyId, thresholdPaise: bigint): void {
    this.thresholds.set(societyId, thresholdPaise);
  }

  findById(societyId: SocietyId): Promise<ExpenseApprovalPolicy | null> {
    this.calls += 1;
    const threshold = this.thresholds.get(societyId);
    return Promise.resolve(
      threshold === undefined
        ? null
        : {
            settings: {
              approvalThresholdPaise:
                threshold as ExpenseApprovalPolicy["settings"]["approvalThresholdPaise"],
            },
          },
    );
  }
}

/** The store — one Map, the ports' four failure modes, and nothing more. */
class FakeExpenses implements ExpenseRepository {
  readonly records = new Map<ExpenseId, ExpenseRecord>();
  readonly calls: string[] = [];
  deleteCalls = 0;

  seed(record: ExpenseRecord): void {
    this.records.set(record.id, record);
  }

  create(input: CreateExpenseRecordInput): Promise<ExpenseRecord> {
    this.calls.push("create");
    const { expense, fields } = input;
    const record: ExpenseRecord = {
      ...fields,
      id: expense.id,
      societyId: expense.societyId,
      categoryId: expense.categoryId,
      title: expense.title,
      amount: expense.amount,
      expenseDate: expense.expenseDate,
      createdBy: expense.createdBy,
      status: expense.status,
      // One INSERT is version 1, whatever the object's in-memory version became
      // through a promotion — the row is written once.
      version: 1,
      publishedAt: null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      createdAt: expense.createdAt,
      updatedAt: expense.updatedAt,
    };
    this.records.set(record.id, record);
    return Promise.resolve(record);
  }

  findById(id: ExpenseId, societyId: SocietyId): Promise<ExpenseRecord | null> {
    this.calls.push("findById");
    const record = this.records.get(id);
    if (record === undefined || record.societyId !== societyId) {
      return Promise.resolve(null);
    }
    return Promise.resolve(record);
  }

  update(
    id: ExpenseId,
    societyId: SocietyId,
    expectedVersion: number,
    input: Omit<UpdateExpenseRecordInput, "expectedVersion">,
  ): Promise<ExpenseRecord> {
    this.calls.push("update");
    const stored = this.records.get(id);
    if (stored === undefined || stored.societyId !== societyId) {
      return Promise.reject(
        expenseError("not_found", "That expense is not available to you."),
      );
    }
    if (stored.version !== expectedVersion) {
      return Promise.reject(
        expenseError("version_mismatch", "Stale.", {
          field: "expectedVersion",
          expectedVersion,
          currentVersion: stored.version,
        }),
      );
    }
    if (stored.status !== "draft" && stored.status !== "pending_approval") {
      return Promise.reject(
        expenseError("invalid_transition", "Not editable.", {
          from: stored.status,
        }),
      );
    }
    const { expense, fields } = input;
    const record: ExpenseRecord = {
      ...fields,
      id: stored.id,
      societyId: stored.societyId,
      categoryId: expense.categoryId,
      title: expense.title,
      amount: expense.amount,
      expenseDate: expense.expenseDate,
      createdBy: stored.createdBy,
      status: expense.status,
      version: stored.version + 1,
      publishedAt: stored.publishedAt,
      voidedAt: stored.voidedAt,
      voidedBy: stored.voidedBy,
      voidReason: stored.voidReason,
      createdAt: stored.createdAt,
      updatedAt: expense.updatedAt,
    };
    this.records.set(record.id, record);
    return Promise.resolve(record);
  }

  list(societyId: SocietyId, query: ExpenseListQuery): Promise<ExpensePage> {
    this.calls.push("list");
    let rows = [...this.records.values()]
      .filter((record) => record.societyId === societyId)
      .filter(
        (record) =>
          query.categoryId === undefined ||
          record.categoryId === query.categoryId,
      )
      .filter(
        (record) =>
          query.status === undefined || record.status === query.status,
      )
      .filter(
        (record) =>
          query.dateFrom === undefined || record.expenseDate >= query.dateFrom,
      )
      .filter(
        (record) =>
          query.dateTo === undefined || record.expenseDate <= query.dateTo,
      )
      .filter(
        (record) =>
          query.createdBy === undefined || record.createdBy === query.createdBy,
      )
      .filter(
        (record) =>
          query.amountPaiseMin === undefined ||
          record.amount.paise >= query.amountPaiseMin,
      )
      .filter(
        (record) =>
          query.amountPaiseMax === undefined ||
          record.amount.paise <= query.amountPaiseMax,
      )
      .filter(
        (record) =>
          query.search === undefined ||
          record.title.toLowerCase().includes(query.search.toLowerCase()),
      )
      .sort((left, right) =>
        left.expenseDate === right.expenseDate
          ? left.id < right.id
            ? 1
            : -1
          : left.expenseDate < right.expenseDate
            ? 1
            : -1,
      );

    if (query.cursor !== undefined) {
      rows = rows.filter(
        (record) =>
          record.expenseDate < query.cursor!.expenseDate ||
          (record.expenseDate === query.cursor!.expenseDate &&
            record.id < query.cursor!.id),
      );
    }

    const page = rows.slice(0, query.limit);
    return Promise.resolve({
      expenses: page,
      nextCursor:
        rows.length > query.limit && page.length > 0
          ? { expenseDate: page.at(-1)!.expenseDate, id: page.at(-1)!.id }
          : null,
    });
  }

  deleteDraft(id: ExpenseId, societyId: SocietyId, act: UserId): Promise<void> {
    this.calls.push("deleteDraft");
    this.deleteCalls += 1;
    const stored = this.records.get(id);
    if (stored === undefined || stored.societyId !== societyId) {
      return Promise.reject(
        expenseError("not_found", "That expense is not available to you."),
      );
    }
    void act;
    if (stored.status !== "draft") {
      return Promise.reject(
        expenseError("invalid_transition", "Not a draft.", {
          from: stored.status,
        }),
      );
    }
    this.records.delete(id);
    return Promise.resolve();
  }
}

function categoryFixture(
  id: ExpenseCategoryId,
  societyId: SocietyId,
  overrides: Partial<ExpenseCategory> = {},
): ExpenseCategory {
  return {
    id,
    societyId,
    name: "Lift",
    icon: null,
    color: null,
    defaultSplitStrategy: "equal",
    defaultApartmentBasis: null,
    isOwnerOnly: false,
    isCapital: false,
    gstApplicable: false,
    isActive: true,
    displayOrder: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function recordFixture(overrides: Partial<ExpenseRecord> = {}): ExpenseRecord {
  return {
    id: asExpenseId("20000000-0000-4000-8000-000000000001"),
    societyId: SOCIETY,
    categoryId: CATEGORY,
    title: "Lift AMC",
    description: null,
    amount: Money.fromPaise(500_00),
    expenseDate: "2026-09-30",
    vendorName: null,
    paymentSource: "society_account",
    paidByMemberId: null,
    splitStrategy: "equal",
    apartmentBasis: null,
    splitConfig: {},
    participantSelector: {},
    status: "draft",
    createdBy: ADMIN_MEMBER,
    publishedAt: null,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    version: 1,
    ...overrides,
  };
}

interface Rig {
  readonly expenses: FakeExpenses;
  readonly categories: FakeCategories;
  readonly memberships: FakeMemberships;
  readonly policies: FakePolicies;
  readonly create: CreateExpenseUseCase;
  readonly update: UpdateExpenseUseCase;
  readonly get: GetExpenseUseCase;
  readonly list: ListExpensesUseCase;
  readonly deleteDraft: DeleteDraftUseCase;
}

function makeRig(): Rig {
  const expenses = new FakeExpenses();
  const categories = new FakeCategories();
  const memberships = new FakeMemberships();
  const policies = new FakePolicies();

  memberships.seed(ADMIN_MEMBERSHIP);
  memberships.seed(TREASURER_MEMBERSHIP);
  memberships.seed(COMMITTEE_MEMBERSHIP);
  memberships.seed(membershipOf(RESIDENT, "resident"));
  categories.seed(categoryFixture(CATEGORY, SOCIETY));
  categories.seed(categoryFixture(OTHER_CATEGORY, SOCIETY));
  policies.seed(SOCIETY, 1_000_000n);

  return {
    expenses,
    categories,
    memberships,
    policies,
    create: new CreateExpenseUseCase(
      expenses,
      categories,
      memberships,
      policies,
      CLOCK,
    ),
    update: new UpdateExpenseUseCase(
      expenses,
      categories,
      memberships,
      policies,
      CLOCK,
    ),
    get: new GetExpenseUseCase(expenses),
    list: new ListExpensesUseCase(expenses),
    deleteDraft: new DeleteDraftUseCase(expenses, memberships),
  };
}

const BASE_CREATE = {
  title: "Lift AMC — Q3",
  amountPaise: 450_000,
  expenseDate: "2026-09-30",
  categoryId: CATEGORY as string,
} as const;

const RECORD_ID = recordFixture().id;

/** Distinct row ids for the list suite — the order is the fixture, not the data. */
function expenseId(n: number): ExpenseId {
  return asExpenseId(`20000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
}

/** The thrown `AppError`, for asserting the code and the payload detail. */
async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error: unknown) {
    return error as AppError;
  }
  throw new Error("Expected the call to be refused.");
}

describe("CreateExpenseUseCase", () => {
  it("creates a draft, with the actor as its creator and the defaults resolved", async () => {
    const rig = makeRig();

    const record = await rig.create.create(ADMIN, SOCIETY, BASE_CREATE);

    expect(record.status).toBe("draft");
    expect(record.version).toBe(1);
    expect(record.createdBy).toBe(ADMIN_MEMBER);
    expect(record.paymentSource).toBe("society_account");
    expect(record.paidByMemberId).toBeNull();
    expect(record.splitStrategy).toBe("equal");
    expect(record.apartmentBasis).toBeNull();
    expect(record.splitConfig).toEqual({});
    // The selector is stored canonically — "not stated" is `null`, not absence.
    expect(record.participantSelector).toMatchObject({
      scope: "society",
      includeVacant: null,
      ownerOnly: false,
    });
    expect(record.amount.paise).toBe(450_000n);
    expect(record.publishedAt).toBeNull();
    expect(rig.expenses.records.size).toBe(1);
  });

  it("takes the strategy and basis from the category's defaults", async () => {
    const rig = makeRig();
    rig.categories.seed(
      categoryFixture(CATEGORY, SOCIETY, {
        defaultSplitStrategy: "apartment",
        defaultApartmentBasis: "per_sqft_carpet",
      }),
    );

    const record = await rig.create.create(ADMIN, SOCIETY, BASE_CREATE);

    expect(record.splitStrategy).toBe("apartment");
    expect(record.apartmentBasis).toBe("per_sqft_carpet");
  });

  it("refuses an apartment strategy with no basis anywhere", async () => {
    const rig = makeRig();

    const error = await failure(
      rig.create.create(ADMIN, SOCIETY, {
        ...BASE_CREATE,
        splitStrategy: "apartment",
      }),
    );

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.payload.field).toBe("apartmentBasis");
    expect(rig.expenses.records.size).toBe(0);
  });

  it("refuses a caller whose role has no expense.create — a Resident", async () => {
    const rig = makeRig();

    const error = await failure(
      rig.create.create(RESIDENT, SOCIETY, BASE_CREATE),
    );

    expect(error.code).toBe("FORBIDDEN");
    expect(rig.expenses.records.size).toBe(0);
  });

  it("lets a Committee Member create — the matrix's 🟡 draft cell", async () => {
    const rig = makeRig();

    const record = await rig.create.create(COMMITTEE, SOCIETY, BASE_CREATE);

    expect(record.status).toBe("draft");
    expect(record.createdBy).toBe(COMMITTEE_MEMBER);
  });

  it("keeps an Admin's below-threshold expense a draft", async () => {
    const rig = makeRig();

    const record = await rig.create.create(ADMIN, SOCIETY, BASE_CREATE);

    expect(record.status).toBe("draft");
    expect(record.amount.paise).toBe(450_000n);
    // The threshold is read for a full-grant holder even when it does not promote.
    expect(rig.policies.calls).toBe(1);
  });

  it("promotes an Admin's above-threshold expense to pending_approval", async () => {
    const rig = makeRig();

    const record = await rig.create.create(ADMIN, SOCIETY, {
      ...BASE_CREATE,
      amountPaise: 1_000_001,
    });

    expect(record.status).toBe("pending_approval");
    expect(record.publishedAt).toBeNull();
  });

  it("treats exactly the threshold as below it — the PRD says *above*", async () => {
    const rig = makeRig();

    const record = await rig.create.create(ADMIN, SOCIETY, {
      ...BASE_CREATE,
      amountPaise: 1_000_000,
    });

    expect(record.status).toBe("draft");
  });

  it("keeps a Committee Member's above-threshold expense a draft, and reads no settings", async () => {
    const rig = makeRig();

    const record = await rig.create.create(COMMITTEE, SOCIETY, {
      ...BASE_CREATE,
      amountPaise: 5_000_000,
    });

    expect(record.status).toBe("draft");
    expect(rig.policies.calls).toBe(0);
  });

  it("answers not_found for a category of another society", async () => {
    const rig = makeRig();
    const foreign = asExpenseCategoryId("30000000-0000-4000-8000-000000000001");
    rig.categories.seed(categoryFixture(foreign, OTHER_SOCIETY));

    const error = await failure(
      rig.create.create(ADMIN, SOCIETY, {
        ...BASE_CREATE,
        categoryId: foreign as string,
      }),
    );

    expect(error.code).toBe("NOT_FOUND");
  });

  it("answers not_found for a missing category", async () => {
    const rig = makeRig();

    const error = await failure(
      rig.create.create(ADMIN, SOCIETY, {
        ...BASE_CREATE,
        categoryId: "40000000-0000-4000-8000-000000000001",
      }),
    );

    expect(error.code).toBe("NOT_FOUND");
  });

  it("surfaces the domain's title and date rules with their fields", async () => {
    const rig = makeRig();

    const blank = await failure(
      rig.create.create(ADMIN, SOCIETY, { ...BASE_CREATE, title: "   " }),
    );
    expect(blank.code).toBe("VALIDATION_ERROR");
    expect(blank.payload.field).toBe("title");

    const far = await failure(
      rig.create.create(ADMIN, SOCIETY, {
        ...BASE_CREATE,
        expenseDate: "2026-12-31",
      }),
    );
    expect(far.code).toBe("VALIDATION_ERROR");
    expect(far.payload.field).toBe("expenseDate");
    expect(rig.expenses.records.size).toBe(0);
  });

  it("stores a canonical selector and the form fields it was given", async () => {
    const rig = makeRig();

    const record = await rig.create.create(ADMIN, SOCIETY, {
      ...BASE_CREATE,
      description: " Covers Oct–Dec ",
      vendorName: "Kone India",
      paidByMemberId: TREASURER_MEMBER as string,
      paymentSource: "member_paid",
      participantSelector: {
        ownerOnly: true,
        buildings: [
          "b2000000-0000-4000-8000-000000000002",
          "b1000000-0000-4000-8000-000000000001",
        ],
      },
    });

    expect(record.description).toBe(" Covers Oct–Dec ");
    expect(record.vendorName).toBe("Kone India");
    expect(record.paidByMemberId).toBe(TREASURER_MEMBER);
    expect(record.paymentSource).toBe("member_paid");
    const selector = record.participantSelector as {
      buildings: readonly string[];
      ownerOnly: boolean;
    };
    // Canonical: de-duplicated and sorted, so two equivalent selectors are one value.
    expect(selector.buildings).toEqual([
      "b1000000-0000-4000-8000-000000000001",
      "b2000000-0000-4000-8000-000000000002",
    ]);
    expect(selector.ownerOnly).toBe(true);
  });
});

describe("UpdateExpenseUseCase", () => {
  it("applies a patch, bumps the version, and leaves everything else alone", async () => {
    const rig = makeRig();
    rig.expenses.seed(
      recordFixture({ description: "Covers Oct", vendorName: "Kone" }),
    );

    const record = await rig.update.update(ADMIN, SOCIETY, RECORD_ID, {
      expectedVersion: 1,
      title: "Lift AMC — revised",
    });

    expect(record.title).toBe("Lift AMC — revised");
    expect(record.version).toBe(2);
    // Absent fields are the stored ones, not nulls.
    expect(record.description).toBe("Covers Oct");
    expect(record.vendorName).toBe("Kone");
    expect(record.amount.paise).toBe(50_000n);
    expect(record.status).toBe("draft");
    // A title-only edit costs no category read.
    expect(rig.categories.reads).toBe(0);
  });

  it("clears a nullable field the caller sends as null", async () => {
    const rig = makeRig();
    rig.expenses.seed(
      recordFixture({
        description: "Covers Oct",
        vendorName: "Kone",
        paidByMemberId: TREASURER_MEMBER,
        paymentSource: "member_paid",
      }),
    );

    const record = await rig.update.update(ADMIN, SOCIETY, RECORD_ID, {
      expectedVersion: 1,
      description: null,
      vendorName: null,
      paidByMemberId: null,
    });

    expect(record.description).toBeNull();
    expect(record.vendorName).toBeNull();
    expect(record.paidByMemberId).toBeNull();
    // An absent `paymentSource` is unchanged — only an explicit value moves it.
    expect(record.paymentSource).toBe("member_paid");
  });

  it("answers 409 VERSION_MISMATCH with the row's current version, and writes nothing", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture({ version: 3, title: "Lift AMC" }));

    const error = await failure(
      rig.update.update(ADMIN, SOCIETY, RECORD_ID, {
        expectedVersion: 1,
        title: "Mine wins",
      }),
    );

    expect(error.code).toBe("VERSION_MISMATCH");
    expect(error.payload.details?.[0]).toMatchObject({
      field: "expectedVersion",
      code: "STALE",
      received: 1,
      current: 3,
    });
    expect(rig.expenses.records.get(RECORD_ID)?.title).toBe("Lift AMC");
    expect(rig.expenses.records.get(RECORD_ID)?.version).toBe(3);
  });

  it("refuses a published expense with invalid_transition, before any write", async () => {
    const rig = makeRig();
    rig.expenses.seed(
      recordFixture({
        status: "published",
        publishedAt: "2026-10-01T00:00:00.000Z",
      }),
    );

    const error = await failure(
      rig.update.update(ADMIN, SOCIETY, RECORD_ID, {
        expectedVersion: 1,
        title: "Too late",
      }),
    );

    expect(error.code).toBe("INVALID_TRANSITION");
    expect(error.message).toMatch(/published/);
    expect(rig.expenses.records.get(RECORD_ID)?.version).toBe(1);
    expect(rig.expenses.calls).not.toContain("update");
  });

  it("lets a Committee Member edit their own draft", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture({ createdBy: COMMITTEE_MEMBER }));

    const record = await rig.update.update(COMMITTEE, SOCIETY, RECORD_ID, {
      expectedVersion: 1,
      title: "Committee revision",
    });

    expect(record.title).toBe("Committee revision");
    expect(record.version).toBe(2);
  });

  it("refuses a Committee Member another member's draft", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture({ createdBy: ADMIN_MEMBER }));

    const error = await failure(
      rig.update.update(COMMITTEE, SOCIETY, RECORD_ID, {
        expectedVersion: 1,
        title: "Not mine",
      }),
    );

    expect(error.code).toBe("FORBIDDEN");
    expect(rig.expenses.calls).not.toContain("update");
  });

  it("refuses a Committee Member their own expense once it awaits approval", async () => {
    // The stricter reading of the 🟡 "own drafts" cell: `pending_approval` is not a
    // draft, and the RLS update policy agrees.
    const rig = makeRig();
    rig.expenses.seed(
      recordFixture({
        createdBy: COMMITTEE_MEMBER,
        status: "pending_approval",
      }),
    );

    const error = await failure(
      rig.update.update(COMMITTEE, SOCIETY, RECORD_ID, {
        expectedVersion: 1,
        title: "Let me back in",
      }),
    );

    expect(error.code).toBe("FORBIDDEN");
  });

  it("refuses a Resident", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture({ createdBy: ADMIN_MEMBER }));

    const error = await failure(
      rig.update.update(RESIDENT, SOCIETY, RECORD_ID, {
        expectedVersion: 1,
        title: "Nope",
      }),
    );

    expect(error.code).toBe("FORBIDDEN");
  });

  it("promotes an Admin's above-threshold edit into pending_approval", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());

    const record = await rig.update.update(ADMIN, SOCIETY, RECORD_ID, {
      expectedVersion: 1,
      amountPaise: 1_000_001,
    });

    expect(record.status).toBe("pending_approval");
    expect(record.amount.paise).toBe(1_000_001n);
    expect(record.version).toBe(2);
    expect(record.publishedAt).toBeNull();
  });

  it("keeps a Committee Member's above-threshold edit a draft, and reads no settings", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture({ createdBy: COMMITTEE_MEMBER }));

    const record = await rig.update.update(COMMITTEE, SOCIETY, RECORD_ID, {
      expectedVersion: 1,
      amountPaise: 5_000_000,
    });

    expect(record.status).toBe("draft");
    expect(rig.policies.calls).toBe(0);
  });

  it("leaves a pending_approval expense pending when it stays above the threshold", async () => {
    const rig = makeRig();
    rig.expenses.seed(
      recordFixture({
        status: "pending_approval",
        amount: Money.fromPaise(2_000_000),
      }),
    );

    const record = await rig.update.update(ADMIN, SOCIETY, RECORD_ID, {
      expectedVersion: 1,
      title: "Still waiting",
    });

    expect(record.status).toBe("pending_approval");
    // Already submitted: the promotion rule is skipped rather than re-entered.
    expect(rig.policies.calls).toBe(0);
  });

  it("files the expense under another category of the same society", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());

    const record = await rig.update.update(ADMIN, SOCIETY, RECORD_ID, {
      expectedVersion: 1,
      categoryId: OTHER_CATEGORY as string,
    });

    expect(record.categoryId).toBe(OTHER_CATEGORY);
    expect(rig.categories.reads).toBe(1);
  });

  it("answers not_found for a cross-society category", async () => {
    const rig = makeRig();
    const foreign = asExpenseCategoryId("30000000-0000-4000-8000-000000000001");
    rig.categories.seed(categoryFixture(foreign, OTHER_SOCIETY));
    rig.expenses.seed(recordFixture());

    const error = await failure(
      rig.update.update(ADMIN, SOCIETY, RECORD_ID, {
        expectedVersion: 1,
        categoryId: foreign as string,
      }),
    );

    expect(error.code).toBe("NOT_FOUND");
  });

  it("answers not_found for a cross-society expense id", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture({ societyId: OTHER_SOCIETY }));

    const error = await failure(
      rig.update.update(ADMIN, SOCIETY, RECORD_ID, {
        expectedVersion: 1,
        title: "Foreign",
      }),
    );

    expect(error.code).toBe("NOT_FOUND");
  });

  it("surfaces the domain's title and date rules with their fields", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());

    const blank = await failure(
      rig.update.update(ADMIN, SOCIETY, RECORD_ID, {
        expectedVersion: 1,
        title: "   ",
      }),
    );
    expect(blank.code).toBe("VALIDATION_ERROR");
    expect(blank.payload.field).toBe("title");

    const far = await failure(
      rig.update.update(ADMIN, SOCIETY, RECORD_ID, {
        expectedVersion: 1,
        expenseDate: "2026-12-31",
      }),
    );
    expect(far.code).toBe("VALIDATION_ERROR");
    expect(far.payload.field).toBe("expenseDate");
    expect(rig.expenses.calls).not.toContain("update");
  });

  it("re-resolves the split plan when the strategy moves, and stores the new basis", async () => {
    const rig = makeRig();
    rig.categories.seed(
      categoryFixture(CATEGORY, SOCIETY, {
        defaultSplitStrategy: "apartment",
        defaultApartmentBasis: "per_sqft_builtup",
      }),
    );
    rig.expenses.seed(recordFixture({ splitStrategy: "equal" }));

    const record = await rig.update.update(ADMIN, SOCIETY, RECORD_ID, {
      expectedVersion: 1,
      splitStrategy: "apartment",
    });

    expect(record.splitStrategy).toBe("apartment");
    expect(record.apartmentBasis).toBe("per_sqft_builtup");
  });
});

describe("GetExpenseUseCase", () => {
  it("returns the stored expense to a member of the society", async () => {
    const rig = makeRig();
    const stored = recordFixture({ status: "pending_approval" });
    rig.expenses.seed(stored);

    const record = await rig.get.get(COMMITTEE, SOCIETY, RECORD_ID);

    expect(record).toEqual(stored);
  });

  it("answers not_found for an id that is not in the caller's society", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture({ societyId: OTHER_SOCIETY }));

    const error = await failure(rig.get.get(ADMIN, SOCIETY, RECORD_ID));

    expect(error.code).toBe("NOT_FOUND");
  });

  it("answers not_found for an absent id", async () => {
    const rig = makeRig();

    const error = await failure(rig.get.get(ADMIN, SOCIETY, RECORD_ID));

    expect(error.code).toBe("NOT_FOUND");
  });
});

describe("ListExpensesUseCase", () => {
  function seedList(rig: Rig): void {
    rig.expenses.seed(
      recordFixture({
        id: expenseId(1),
        title: "Lift AMC",
        description: "Quarterly",
        expenseDate: "2026-09-30",
        categoryId: CATEGORY,
        status: "draft",
        amount: Money.fromPaise(50_000),
        createdBy: ADMIN_MEMBER,
      }),
    );
    rig.expenses.seed(
      recordFixture({
        id: expenseId(2),
        title: "Diwali decor",
        description: null,
        expenseDate: "2026-09-15",
        categoryId: OTHER_CATEGORY,
        status: "pending_approval",
        amount: Money.fromPaise(1_500_000),
        createdBy: COMMITTEE_MEMBER,
      }),
    );
    rig.expenses.seed(
      recordFixture({
        id: expenseId(3),
        title: "Security salary",
        description: null,
        expenseDate: "2026-08-31",
        categoryId: CATEGORY,
        status: "published",
        amount: Money.fromPaise(200_000),
        createdBy: TREASURER_MEMBER,
      }),
    );
  }

  function idsOf(result: { expenses: readonly ExpenseRecord[] }): string[] {
    return result.expenses.map((record) => record.id);
  }

  it("returns every expense of the society, newest first, when no filter is given", async () => {
    const rig = makeRig();
    seedList(rig);

    const result = await rig.list.list(ADMIN, SOCIETY, {});

    expect(idsOf(result)).toEqual([expenseId(1), expenseId(2), expenseId(3)]);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it("never returns another society's rows", async () => {
    const rig = makeRig();
    seedList(rig);
    rig.expenses.seed(
      recordFixture({ id: expenseId(9), societyId: OTHER_SOCIETY }),
    );

    const result = await rig.list.list(ADMIN, SOCIETY, {});

    expect(result.expenses).toHaveLength(3);
  });

  it.each([
    ["categoryId", { categoryId: CATEGORY as string }, [1, 3]],
    ["status", { status: "pending_approval" as const }, [2]],
    ["dateFrom", { dateFrom: "2026-09-01" }, [1, 2]],
    ["dateTo", { dateTo: "2026-09-20" }, [2, 3]],
    ["amountPaiseMin", { amountPaiseMin: 200_000 }, [2, 3]],
    ["amountPaiseMax", { amountPaiseMax: 50_000 }, [1]],
    ["createdBy", { createdBy: COMMITTEE_MEMBER as string }, [2]],
    ["q", { q: "lift" }, [1]],
  ])("applies the %s filter", async (_name, command, expected) => {
    const rig = makeRig();
    seedList(rig);

    const result = await rig.list.list(ADMIN, SOCIETY, command);

    expect(idsOf(result)).toEqual(expected.map(expenseId));
  });

  it("combines a date range with a search term", async () => {
    const rig = makeRig();
    seedList(rig);

    const result = await rig.list.list(ADMIN, SOCIETY, {
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
      q: "amc",
    });

    expect(idsOf(result)).toEqual([expenseId(1)]);
  });

  it("paginates with an opaque cursor, and the tuple round-trips", async () => {
    const rig = makeRig();
    seedList(rig);

    const first = await rig.list.list(ADMIN, SOCIETY, { limit: 1 });
    expect(idsOf(first)).toEqual([expenseId(1)]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(decodeExpenseCursor(first.nextCursor as string)).toEqual({
      expenseDate: "2026-09-30",
      id: expenseId(1),
    });

    const second = await rig.list.list(ADMIN, SOCIETY, {
      limit: 1,
      cursor: first.nextCursor as string,
    });
    expect(idsOf(second)).toEqual([expenseId(2)]);
    expect(second.hasMore).toBe(true);

    const third = await rig.list.list(ADMIN, SOCIETY, {
      limit: 1,
      cursor: second.nextCursor as string,
    });
    expect(idsOf(third)).toEqual([expenseId(3)]);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();
  });

  it("encodes and decodes the sort tuple symmetrically", () => {
    const tuple: ExpenseCursor = { expenseDate: "2026-09-30", id: RECORD_ID };

    expect(decodeExpenseCursor(encodeExpenseCursor(tuple))).toEqual(tuple);
  });

  it.each(["not-a-cursor", Buffer.from("hello", "utf8").toString("base64")])(
    "refuses the malformed cursor %s as validation rather than starting over",
    async (cursor) => {
      const rig = makeRig();
      seedList(rig);

      const error = await failure(rig.list.list(ADMIN, SOCIETY, { cursor }));

      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.payload.field).toBe("cursor");
      expect(rig.expenses.calls).not.toContain("list");
    },
  );

  it("clamps a limit above 100 to the SAD's maximum", async () => {
    const rig = makeRig();
    seedList(rig);
    const spy = jest.spyOn(rig.expenses, "list");

    await rig.list.list(ADMIN, SOCIETY, { limit: 500 });

    expect(spy.mock.calls[0]?.[1]?.limit).toBe(100);
  });

  it("defaults to the SAD's page size of 20", async () => {
    const rig = makeRig();
    for (let index = 1; index <= 21; index += 1) {
      rig.expenses.seed(
        recordFixture({
          id: expenseId(index),
          expenseDate: "2026-09-30",
          createdBy: ADMIN_MEMBER,
        }),
      );
    }

    const result = await rig.list.list(ADMIN, SOCIETY, {});

    expect(result.expenses).toHaveLength(20);
    expect(result.hasMore).toBe(true);
  });
});

describe("DeleteDraftUseCase", () => {
  it("lets a creator delete their own draft, and the row is gone", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture({ createdBy: ADMIN_MEMBER }));

    await rig.deleteDraft.delete(ADMIN, SOCIETY, RECORD_ID);

    expect(rig.expenses.records.has(RECORD_ID)).toBe(false);
    expect(rig.expenses.deleteCalls).toBe(1);
  });

  it("lets a Committee Member delete their own draft", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture({ createdBy: COMMITTEE_MEMBER }));

    await rig.deleteDraft.delete(COMMITTEE, SOCIETY, RECORD_ID);

    expect(rig.expenses.records.size).toBe(0);
  });

  it("refuses an Admin somebody else's draft — creator only, not creator-or-manager", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture({ createdBy: COMMITTEE_MEMBER }));

    const error = await failure(
      rig.deleteDraft.delete(ADMIN, SOCIETY, RECORD_ID),
    );

    expect(error.code).toBe("FORBIDDEN");
    expect(rig.expenses.records.has(RECORD_ID)).toBe(true);
    expect(rig.expenses.deleteCalls).toBe(0);
  });

  it("refuses a Committee Member somebody else's draft", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture({ createdBy: ADMIN_MEMBER }));

    const error = await failure(
      rig.deleteDraft.delete(COMMITTEE, SOCIETY, RECORD_ID),
    );

    expect(error.code).toBe("FORBIDDEN");
  });

  it("refuses a Resident, even their own draft", async () => {
    const rig = makeRig();
    rig.expenses.seed(
      recordFixture({
        createdBy: asMemberId("10000000-0000-4000-8000-333333333333"),
      }),
    );

    const error = await failure(
      rig.deleteDraft.delete(RESIDENT, SOCIETY, RECORD_ID),
    );

    expect(error.code).toBe("FORBIDDEN");
  });

  it("refuses a published expense with invalid_transition — its door is voiding", async () => {
    const rig = makeRig();
    rig.expenses.seed(
      recordFixture({ status: "published", createdBy: ADMIN_MEMBER }),
    );

    const error = await failure(
      rig.deleteDraft.delete(ADMIN, SOCIETY, RECORD_ID),
    );

    expect(error.code).toBe("INVALID_TRANSITION");
    expect(error.message).toMatch(/published/);
    expect(rig.expenses.records.has(RECORD_ID)).toBe(true);
  });

  it("refuses a pending_approval expense it created", async () => {
    const rig = makeRig();
    rig.expenses.seed(
      recordFixture({ status: "pending_approval", createdBy: ADMIN_MEMBER }),
    );

    const error = await failure(
      rig.deleteDraft.delete(ADMIN, SOCIETY, RECORD_ID),
    );

    expect(error.code).toBe("INVALID_TRANSITION");
    expect(rig.expenses.deleteCalls).toBe(0);
  });

  it("answers not_found for a cross-society id, deleting nothing", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture({ societyId: OTHER_SOCIETY }));

    const error = await failure(
      rig.deleteDraft.delete(ADMIN, SOCIETY, RECORD_ID),
    );

    expect(error.code).toBe("NOT_FOUND");
    expect(rig.expenses.deleteCalls).toBe(0);
  });
});
