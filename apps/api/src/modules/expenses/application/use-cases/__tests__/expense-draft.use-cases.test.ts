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
  ApproveExpenseRecordInput,
  AttachmentRepository,
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
  ExpenseRecalculation,
  ExpenseRecord,
  ExpenseRepository,
  RejectExpenseRecordInput,
  SocietyId,
  SocietyMembership,
  StorageProvider,
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
import { ListApprovalQueueUseCase } from "../list-approval-queue.use-case";
import { RecalculateExpenseUseCase } from "../recalculate-expense.use-case";
import type { RecalculateExpenseCommand } from "../recalculate-expense.use-case";
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
      // T070's workflow stamps: a freshly created row carries the aggregate's own
      // (always-clean) values rather than a hard-coded null, so the fake does not
      // invent a state the aggregate could not have written.
      approvedBy: expense.approvedBy,
      approvedAt: expense.approvedAt,
      rejectedBy: expense.rejectedBy,
      rejectedAt: expense.rejectedAt,
      rejectionReason: expense.rejectionReason,
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
      // The aggregate is the post-edit state, so its stamps are the ones to write —
      // `edit()` has already cleared any approval (D8's invalidation).
      approvedBy: expense.approvedBy,
      approvedAt: expense.approvedAt,
      rejectedBy: expense.rejectedBy,
      rejectedAt: expense.rejectedAt,
      rejectionReason: expense.rejectionReason,
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

  /** T070's approval, in memory — the port's four refusals in the definer's order. */
  approve(
    id: ExpenseId,
    societyId: SocietyId,
    input: ApproveExpenseRecordInput,
  ): Promise<ExpenseRecord> {
    this.calls.push("approve");
    const stored = this.records.get(id);
    if (stored === undefined || stored.societyId !== societyId) {
      return Promise.reject(
        expenseError("not_found", "That expense is not available to you."),
      );
    }
    if (stored.status !== "pending_approval") {
      return Promise.reject(
        expenseError("invalid_transition", "Not awaiting approval.", {
          from: stored.status,
          to: "approved",
        }),
      );
    }
    if (stored.version !== input.expectedVersion) {
      return Promise.reject(
        expenseError("version_mismatch", "Stale.", {
          field: "expectedVersion",
          expectedVersion: input.expectedVersion,
          currentVersion: stored.version,
        }),
      );
    }
    if (stored.approvedBy !== null && stored.approvedAt !== null) {
      return Promise.reject(
        expenseError("invalid_transition", "Already approved.", {
          from: "approved",
          to: "approved",
        }),
      );
    }
    const approved: ExpenseRecord = {
      ...stored,
      approvedBy: stored.createdBy,
      approvedAt: "2026-10-01T10:00:00.000Z",
      rejectedBy: null,
      rejectedAt: null,
      rejectionReason: null,
      updatedAt: "2026-10-01T10:00:00.000Z",
      version: stored.version + 1,
    };
    this.records.set(id, approved);
    return Promise.resolve(approved);
  }

  /** T070's rejection, in memory — `pending_approval → draft` with its stamps. */
  reject(
    id: ExpenseId,
    societyId: SocietyId,
    input: RejectExpenseRecordInput,
  ): Promise<ExpenseRecord> {
    this.calls.push("reject");
    const stored = this.records.get(id);
    if (stored === undefined || stored.societyId !== societyId) {
      return Promise.reject(
        expenseError("not_found", "That expense is not available to you."),
      );
    }
    if (stored.status !== "pending_approval") {
      return Promise.reject(
        expenseError("invalid_transition", "Not awaiting approval.", {
          from: stored.status,
          to: "draft",
        }),
      );
    }
    if (stored.version !== input.expectedVersion) {
      return Promise.reject(
        expenseError("version_mismatch", "Stale.", {
          field: "expectedVersion",
          expectedVersion: input.expectedVersion,
          currentVersion: stored.version,
        }),
      );
    }
    const rejected: ExpenseRecord = {
      ...stored,
      status: "draft",
      approvedBy: null,
      approvedAt: null,
      rejectedBy: stored.createdBy,
      rejectedAt: "2026-10-01T10:00:00.000Z",
      rejectionReason: input.reason,
      updatedAt: "2026-10-01T10:00:00.000Z",
      version: stored.version + 1,
    };
    this.records.set(id, rejected);
    return Promise.resolve(rejected);
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

/**
 * T068's published door, recorded — the *dispatch* is what this file observes.
 *
 * A stub rather than the real `RecalculateExpenseUseCase`, because the recalculation's
 * own rules (the pipeline, the patch allow-list, the field mapping) are that class's
 * suite and PostgreSQL is the integration suite's; this file's subject is which door a
 * stored status opens and what travels through it. The cast is the price of the class's
 * private collaborators — the constructor's type is what keeps a *draft* path from
 * reaching for this stub accidentally, which is the property that matters here.
 */
class FakeRecalculation {
  readonly calls: {
    readonly actor: UserId;
    readonly expenseId: ExpenseId;
    readonly patch: RecalculateExpenseCommand;
  }[] = [];
  failure?: Error | undefined;

  recalculate(
    actor: UserId,
    _societyId: SocietyId,
    expenseId: ExpenseId,
    patch: RecalculateExpenseCommand,
  ): Promise<ExpenseRecalculation> {
    this.calls.push({ actor, expenseId, patch });
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return Promise.resolve({
      expense: recordFixture({
        status: "published",
        publishedAt: "2026-10-01T00:00:00.000Z",
        version: 5,
      }),
      summary: {
        duesUpdated: 2,
        duesSuperseded: 0,
        duesCreated: 0,
        totalDelta: Money.fromPaise(100_00),
        affectedMembers: 2,
        blockedByPaidSplits: 0,
      },
    });
  }
}

interface Rig {
  readonly expenses: FakeExpenses;
  readonly categories: FakeCategories;
  readonly memberships: FakeMemberships;
  readonly policies: FakePolicies;
  readonly recalculation: FakeRecalculation;
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

  const recalculation = new FakeRecalculation();

  return {
    expenses,
    categories,
    memberships,
    policies,
    recalculation,
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
      // The published door's target: a recorder, so the dispatch is observable
      // without the recalculation's own rules (that class's suite, and PostgreSQL's)
      // being restated here.
      recalculation as unknown as RecalculateExpenseUseCase,
    ),
    get: new GetExpenseUseCase(expenses),
    list: new ListExpensesUseCase(
      expenses,
      new ListApprovalQueueUseCase(expenses),
    ),
    // T071 (ADR-0012 D6.5): the draft-deletion path also removes the draft's
    // attachment **objects**, after `expense_draft_delete()` has removed their rows.
    // This suite is about the draft lifecycle and has no attachments asset, so the
    // two collaborators are the smallest honest stand-ins: a read that answers
    // "this draft has none" and a store that is never called. The cleanup itself is
    // proven where it belongs — against real PostgreSQL and a real object store, in
    // the T071 integration suites.
    deleteDraft: new DeleteDraftUseCase(
      expenses,
      memberships,
      NO_ATTACHMENT_REPOSITORY,
      NO_STORAGE_PROVIDER,
    ),
  };
}

/** "This draft has no attachments" — the fixture's answer, not a claim about the data. */
const NO_ATTACHMENT_REPOSITORY = {
  listStorageKeysForExpense: async (): Promise<readonly string[]> => [],
} as unknown as AttachmentRepository;

/** Never reached: with no keys to clean, the storage adapter is not called. */
const NO_STORAGE_PROVIDER = {
  delete: async (): Promise<void> => undefined,
} as unknown as StorageProvider;

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

  it("treats exactly the threshold as requiring approval — `>=`, not the old `>`", async () => {
    const rig = makeRig();

    const record = await rig.create.create(ADMIN, SOCIETY, {
      ...BASE_CREATE,
      amountPaise: 1_000_000,
    });

    expect(record.status).toBe("pending_approval");
    expect(rig.policies.calls).toBe(1);
  });

  it("treats one paisa below the threshold as requiring no approval", async () => {
    const rig = makeRig();

    const record = await rig.create.create(ADMIN, SOCIETY, {
      ...BASE_CREATE,
      amountPaise: 999_999,
    });

    expect(record.status).toBe("draft");
  });

  it("keeps a Resident-with-no-grant test honest: a Committee Member's above-threshold expense is routed, not stranded", async () => {
    const rig = makeRig();

    const record = await rig.create.create(COMMITTEE, SOCIETY, {
      ...BASE_CREATE,
      amountPaise: 5_000_000,
    });

    // T070's Committee deadlock fix (ADR-0011): the threshold alone decides, so an
    // otherwise-authorized draft creator can submit their own expense for approval
    // rather than being left holding a draft they cannot promote.
    expect(record.status).toBe("pending_approval");
    expect(record.version).toBe(1);
    expect(rig.policies.calls).toBe(1);
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

    const { expense: record } = await rig.update.update(
      ADMIN,
      SOCIETY,
      RECORD_ID,
      {
        expectedVersion: 1,
        title: "Lift AMC — revised",
      },
    );

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

    const { expense: record } = await rig.update.update(
      ADMIN,
      SOCIETY,
      RECORD_ID,
      {
        expectedVersion: 1,
        description: null,
        vendorName: null,
        paidByMemberId: null,
      },
    );

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

  it("revises a published expense through T068's door, never the draft write", async () => {
    const rig = makeRig();
    rig.expenses.seed(
      recordFixture({
        status: "published",
        publishedAt: "2026-10-01T00:00:00.000Z",
        version: 4,
      }),
    );

    const outcome = await rig.update.update(ADMIN, SOCIETY, RECORD_ID, {
      expectedVersion: 4,
      title: "Lift AMC — revised",
      amountPaise: 900_00,
      splitStrategy: "percentage",
      changeNote: "Revised after the AGM",
    });

    expect(rig.recalculation.calls).toHaveLength(1);
    expect(rig.recalculation.calls[0]?.patch).toMatchObject({
      expectedVersion: 4,
      title: "Lift AMC — revised",
      amountPaise: 900_00,
      splitStrategy: "percentage",
      changeNote: "Revised after the AGM",
    });
    // The row it answers with is the one the recalculation wrote, and the draft
    // write never ran: a published bill is moved by the definer transaction alone.
    expect(outcome.recalculation?.summary.duesUpdated).toBe(2);
    expect(outcome.expense.version).toBe(5);
    expect(rig.expenses.calls).not.toContain("update");
  });

  it("refuses a published patch naming an immutable field, before reading anything else", async () => {
    const rig = makeRig();
    rig.expenses.seed(
      recordFixture({
        status: "published",
        publishedAt: "2026-10-01T00:00:00.000Z",
        version: 4,
      }),
    );

    const error = await failure(
      rig.update.update(ADMIN, SOCIETY, RECORD_ID, {
        expectedVersion: 4,
        categoryId: OTHER_CATEGORY,
      }),
    );

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.payload.field).toBe("categoryId");
    expect(rig.recalculation.calls).toHaveLength(0);
    expect(rig.expenses.calls).not.toContain("update");
  });

  it("refuses a void expense with invalid_transition, before any write", async () => {
    const rig = makeRig();
    rig.expenses.seed(
      recordFixture({
        status: "void",
        voidedAt: "2026-10-01T00:00:00.000Z",
        voidReason: "Duplicate of the September bill",
      }),
    );

    const error = await failure(
      rig.update.update(ADMIN, SOCIETY, RECORD_ID, {
        expectedVersion: 1,
        title: "Too late",
      }),
    );

    expect(error.code).toBe("INVALID_TRANSITION");
    expect(error.message).toMatch(/void/);
    expect(rig.expenses.records.get(RECORD_ID)?.version).toBe(1);
    expect(rig.recalculation.calls).toHaveLength(0);
    expect(rig.expenses.calls).not.toContain("update");
  });

  it("refuses a change note on a draft edit, which has no revision to annotate", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());

    const error = await failure(
      rig.update.update(ADMIN, SOCIETY, RECORD_ID, {
        expectedVersion: 1,
        title: "Draft revision",
        changeNote: "Nothing to annotate yet",
      }),
    );

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.payload.field).toBe("changeNote");
    expect(rig.expenses.calls).not.toContain("update");
  });

  it("lets a Committee Member edit their own draft", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture({ createdBy: COMMITTEE_MEMBER }));

    const { expense: record } = await rig.update.update(
      COMMITTEE,
      SOCIETY,
      RECORD_ID,
      {
        expectedVersion: 1,
        title: "Committee revision",
      },
    );

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

    const { expense: record } = await rig.update.update(
      ADMIN,
      SOCIETY,
      RECORD_ID,
      {
        expectedVersion: 1,
        amountPaise: 1_000_001,
      },
    );

    expect(record.status).toBe("pending_approval");
    expect(record.amount.paise).toBe(1_000_001n);
    expect(record.version).toBe(2);
    expect(record.publishedAt).toBeNull();
  });

  it("routes a Committee Member's above-threshold edit into pending_approval", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture({ createdBy: COMMITTEE_MEMBER }));

    const { expense: record } = await rig.update.update(
      COMMITTEE,
      SOCIETY,
      RECORD_ID,
      {
        expectedVersion: 1,
        amountPaise: 5_000_000,
      },
    );

    expect(record.status).toBe("pending_approval");
    expect(record.version).toBe(2);
    expect(rig.policies.calls).toBe(1);
  });

  it("leaves a pending_approval expense pending when it stays above the threshold", async () => {
    const rig = makeRig();
    rig.expenses.seed(
      recordFixture({
        status: "pending_approval",
        amount: Money.fromPaise(2_000_000),
      }),
    );

    const { expense: record } = await rig.update.update(
      ADMIN,
      SOCIETY,
      RECORD_ID,
      {
        expectedVersion: 1,
        title: "Still waiting",
      },
    );

    // The threshold is read on every routed write itself now, because *both*
    // directions matter: this row must stay submitted, and one that fell below the
    // current threshold must return to draft (D8).
    expect(record.status).toBe("pending_approval");
    expect(rig.policies.calls).toBe(1);
  });

  it("clears a pending_approval expense's approval when it is edited — D8 invalidation", async () => {
    const rig = makeRig();
    rig.expenses.seed(
      recordFixture({
        status: "pending_approval",
        amount: Money.fromPaise(2_000_000),
        approvedBy: ADMIN_MEMBER,
        approvedAt: "2026-09-30T10:00:00.000Z",
      }),
    );

    const { expense } = await rig.update.update(ADMIN, SOCIETY, RECORD_ID, {
      expectedVersion: 1,
      title: "Different work entirely",
    });

    // The approval applied to the exact content it approved; a different expense
    // must be decided again — and the amount is unchanged, so it stays submitted.
    expect(expense.status).toBe("pending_approval");
    expect(expense.approvedBy).toBeNull();
    expect(expense.approvedAt).toBeNull();
  });

  it("returns a pending_approval expense to draft when the edit drops it below the threshold", async () => {
    const rig = makeRig();
    rig.expenses.seed(
      recordFixture({
        status: "pending_approval",
        amount: Money.fromPaise(2_000_000),
      }),
    );

    const { expense: record } = await rig.update.update(
      ADMIN,
      SOCIETY,
      RECORD_ID,
      {
        expectedVersion: 1,
        amountPaise: 500_000,
      },
    );

    expect(record.status).toBe("draft");
  });

  it("files the expense under another category of the same society", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());

    const { expense: record } = await rig.update.update(
      ADMIN,
      SOCIETY,
      RECORD_ID,
      {
        expectedVersion: 1,
        categoryId: OTHER_CATEGORY as string,
      },
    );

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

    const { expense: record } = await rig.update.update(
      ADMIN,
      SOCIETY,
      RECORD_ID,
      {
        expectedVersion: 1,
        splitStrategy: "apartment",
      },
    );

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
