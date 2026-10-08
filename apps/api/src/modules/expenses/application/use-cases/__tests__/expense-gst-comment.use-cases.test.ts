import {
  Money,
  asExpenseCategoryId,
  asExpenseCommentId,
  asExpenseId,
  asMemberId,
  asSocietyId,
  asUserId,
  expenseError,
  paise,
} from "@ses/domain";
import type {
  ExpenseCommentDraft,
  ExpenseCommentId,
  ExpenseCommentRecord,
  ExpenseCommentRepository,
  ExpenseGstDetailsInput,
  ExpenseGstDetailsRecord,
  ExpenseGstDetailsRepository,
  ExpenseId,
  ExpenseListQuery,
  ExpenseMembershipReader,
  ExpensePage,
  ExpenseRecord,
  ExpenseRepository,
  MemberId,
  SocietyId,
  SocietyMembership,
  UserId,
} from "@ses/domain";

import { AppError } from "../../../../../common/errors/app-error";
import { AddCommentUseCase } from "../add-comment.use-case";
import { DeleteCommentUseCase } from "../delete-comment.use-case";
import { ListCommentsUseCase } from "../list-comments.use-case";
import { UpsertGstDetailsUseCase } from "../upsert-gst-details.use-case";

/**
 * T072's orchestration over contract doubles — the error precedence, the
 * narrowing, the warning and the author-or-Admin delete rule.
 *
 * The doubles implement the **ports**: the store and the refusals the use cases
 * read back. What only PostgreSQL can prove (RLS, FORCE RLS, the grants, the row
 * lock, the identity sequence, "the approval stamps survive") belongs to the
 * real-backend integration spec.
 */

const SOCIETY = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const ADMIN = asUserId("11111111-1111-4111-8111-111111111111");
const COMMITTEE = asUserId("77777777-7777-4777-8777-777777777777");
const RESIDENT = asUserId("33333333-3333-4333-8333-333333333333");

const ADMIN_MEMBER = asMemberId("10000000-0000-4000-8000-000000000001");
const COMMITTEE_MEMBER = asMemberId("10000000-0000-4000-8000-000000000007");
const RESIDENT_MEMBER = asMemberId("10000000-0000-4000-8000-000000000003");

const EXPENSE_ID = asExpenseId("20000000-0000-4000-8000-000000000001");
const CATEGORY = asExpenseCategoryId("0a000000-0000-4000-8000-000000000001");
const COMMENT_ID = asExpenseCommentId("30000000-0000-4000-8000-000000000001");

function membershipOf(
  actor: UserId,
  role: SocietyMembership["role"],
  id: MemberId,
): SocietyMembership {
  return {
    id,
    societyId: SOCIETY,
    userId: actor,
    role,
    status: "active",
    occupancyType: "owner",
    joinedAt: "2026-01-01T00:00:00.000Z",
  };
}

class FakeMemberships implements ExpenseMembershipReader {
  private readonly memberships = new Map<string, SocietyMembership>();
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

class FakeExpenses implements ExpenseRepository {
  readonly records = new Map<ExpenseId, ExpenseRecord>();
  seed(record: ExpenseRecord): void {
    this.records.set(record.id, record);
  }
  async findById(
    id: ExpenseId,
    societyId: SocietyId,
  ): Promise<ExpenseRecord | null> {
    const stored = this.records.get(id);
    if (stored === undefined || stored.societyId !== societyId) return null;
    return stored;
  }
  async create(): Promise<ExpenseRecord> {
    throw new Error("not used");
  }
  async update(): Promise<ExpenseRecord> {
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
  async approve(): Promise<ExpenseRecord> {
    throw new Error("not used");
  }
  async reject(): Promise<ExpenseRecord> {
    throw new Error("not used");
  }
}

class FakeGst implements ExpenseGstDetailsRepository {
  row: ExpenseGstDetailsRecord | null = null;
  upserts = 0;
  async findByExpense(): Promise<ExpenseGstDetailsRecord | null> {
    return this.row;
  }
  async upsertForExpense(
    expenseId: ExpenseId,
    societyId: SocietyId,
    input: ExpenseGstDetailsInput,
  ): Promise<ExpenseGstDetailsRecord> {
    this.upserts += 1;
    this.row = { expenseId, societyId, ...input };
    return this.row;
  }
}

class FakeComments implements ExpenseCommentRepository {
  rows: ExpenseCommentRecord[] = [];
  deleted: ExpenseCommentId[] = [];
  async listForExpense(): Promise<readonly ExpenseCommentRecord[]> {
    return this.rows;
  }
  async findById(
    commentId: ExpenseCommentId,
    expenseId: ExpenseId,
  ): Promise<ExpenseCommentRecord | null> {
    return (
      this.rows.find(
        (row) => row.id === commentId && row.expenseId === expenseId,
      ) ?? null
    );
  }
  async add(draft: ExpenseCommentDraft): Promise<ExpenseCommentRecord> {
    const row = commentFixture({
      id: asExpenseCommentId(
        `30000000-0000-4000-8000-0000000000${(this.rows.length + 2)
          .toString()
          .padStart(2, "0")}`,
      ),
      expenseId: draft.expenseId,
      societyId: draft.societyId,
      authorId: draft.authorId,
      body: draft.body,
      sequence: this.rows.length + 1,
    });
    this.rows.push(row);
    return row;
  }
  async softDelete(commentId: ExpenseCommentId): Promise<ExpenseCommentRecord> {
    this.deleted.push(commentId);
    const stored =
      this.rows.find((row) => row.id === commentId) ?? commentFixture();
    return { ...stored, deletedAt: "2026-10-08T00:00:00.000Z" };
  }
}

function recordFixture(overrides: Partial<ExpenseRecord> = {}): ExpenseRecord {
  return {
    id: EXPENSE_ID,
    societyId: SOCIETY,
    categoryId: CATEGORY,
    title: "Lift AMC — Q4",
    description: null,
    amount: Money.fromPaise(4_500_000),
    expenseDate: "2026-09-30",
    vendorName: null,
    paymentSource: "society_account",
    paidByMemberId: null,
    splitStrategy: "equal",
    apartmentBasis: null,
    splitConfig: {},
    participantSelector: {},
    status: "draft",
    createdBy: COMMITTEE_MEMBER,
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

function commentFixture(
  overrides: Partial<ExpenseCommentRecord> = {},
): ExpenseCommentRecord {
  return {
    id: COMMENT_ID,
    expenseId: EXPENSE_ID,
    societyId: SOCIETY,
    authorId: RESIDENT_MEMBER,
    body: "Why did this cost ₹40,000?",
    sequence: 1,
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    deletedAt: null,
    deletedBy: null,
    ...overrides,
  };
}

function makeRig() {
  const expenses = new FakeExpenses();
  const memberships = new FakeMemberships();
  const gst = new FakeGst();
  const comments = new FakeComments();
  memberships.seed(membershipOf(ADMIN, "admin", ADMIN_MEMBER));
  memberships.seed(
    membershipOf(COMMITTEE, "committee_member", COMMITTEE_MEMBER),
  );
  memberships.seed(membershipOf(RESIDENT, "resident", RESIDENT_MEMBER));
  return {
    expenses,
    memberships,
    gst,
    comments,
    upsertGst: new UpsertGstDetailsUseCase(expenses, gst, memberships),
    addComment: new AddCommentUseCase(expenses, comments, memberships),
    listComments: new ListCommentsUseCase(expenses, comments, memberships),
    deleteComment: new DeleteCommentUseCase(expenses, comments, memberships),
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

describe("UpsertGstDetailsUseCase", () => {
  it("records GST details and warns when the tax total does not reconcile", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());
    const outcome = await rig.upsertGst.upsert(ADMIN, SOCIETY, EXPENSE_ID, {
      taxableValuePaise: 3_000_000,
      cgstPaise: 500_000,
      sgstPaise: 500_000,
    });
    expect(rig.gst.upserts).toBe(1);
    expect(outcome.gst.taxableValuePaise).toBe(3_000_000n);
    expect(outcome.warnings).toHaveLength(1);
    expect(outcome.warnings[0]?.code).toBe("TAX_TOTAL_MISMATCH");
  });

  it("emits no warning when the components reconcile exactly", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());
    const outcome = await rig.upsertGst.upsert(ADMIN, SOCIETY, EXPENSE_ID, {
      taxableValuePaise: 3_500_000,
      cgstPaise: 500_000,
      sgstPaise: 500_000,
    });
    expect(outcome.warnings).toEqual([]);
  });

  it("refuses a void expense before any write (D4)", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture({ status: "void" }));
    const error = await failure(
      rig.upsertGst.upsert(ADMIN, SOCIETY, EXPENSE_ID, { cgstPaise: 100 }),
    );
    expect(error.code).toBe("INVALID_TRANSITION");
    expect(rig.gst.upserts).toBe(0);
  });

  it("refuses a Committee Member on a non-draft expense, but allows a draft", async () => {
    const draft = makeRig();
    draft.expenses.seed(recordFixture({ status: "draft" }));
    await expect(
      draft.upsertGst.upsert(COMMITTEE, SOCIETY, EXPENSE_ID, {
        cgstPaise: 100,
      }),
    ).resolves.toBeDefined();

    const published = makeRig();
    published.expenses.seed(recordFixture({ status: "published" }));
    const error = await failure(
      published.upsertGst.upsert(COMMITTEE, SOCIETY, EXPENSE_ID, {
        cgstPaise: 100,
      }),
    );
    expect(error.code).toBe("FORBIDDEN");
    expect(published.gst.upserts).toBe(0);
  });

  it("refuses a malformed GSTIN with a validation error (D7)", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());
    const error = await failure(
      rig.upsertGst.upsert(ADMIN, SOCIETY, EXPENSE_ID, {
        gstin: "27AABCK1234M1Z5",
      }),
    );
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(rig.gst.upserts).toBe(0);
  });
});

describe("comment use cases", () => {
  it("attributes an added comment to the caller's own membership", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());
    const comment = await rig.addComment.add(RESIDENT, SOCIETY, EXPENSE_ID, {
      body: "Why did this cost ₹40,000?",
    });
    expect(comment.authorId).toBe(RESIDENT_MEMBER);
  });

  it("lets the author soft-delete their own comment", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());
    rig.comments.rows = [commentFixture({ authorId: RESIDENT_MEMBER })];
    await expect(
      rig.deleteComment.softDelete(RESIDENT, SOCIETY, EXPENSE_ID, COMMENT_ID),
    ).resolves.toBeDefined();
    expect(rig.comments.deleted).toContain(COMMENT_ID);
  });

  it("refuses a non-author non-Admin and writes nothing", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());
    rig.comments.rows = [commentFixture({ authorId: ADMIN_MEMBER })];
    const error = await failure(
      rig.deleteComment.softDelete(RESIDENT, SOCIETY, EXPENSE_ID, COMMENT_ID),
    );
    expect(error.code).toBe("FORBIDDEN");
    expect(rig.comments.deleted).toHaveLength(0);
  });

  it("lets an Admin soft-delete somebody else's comment (D2)", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());
    rig.comments.rows = [commentFixture({ authorId: RESIDENT_MEMBER })];
    await expect(
      rig.deleteComment.softDelete(ADMIN, SOCIETY, EXPENSE_ID, COMMENT_ID),
    ).resolves.toBeDefined();
    expect(rig.comments.deleted).toContain(COMMENT_ID);
  });

  it("answers not_found for an expense the caller cannot see", async () => {
    const rig = makeRig();
    const error = await failure(
      rig.listComments.list(RESIDENT, SOCIETY, EXPENSE_ID),
    );
    expect(error.code).toBe("NOT_FOUND");
  });

  it("returns the stream oldest-first through the port", async () => {
    const rig = makeRig();
    rig.expenses.seed(recordFixture());
    rig.comments.rows = [
      commentFixture({ sequence: 1 }),
      commentFixture({
        id: asExpenseCommentId("30000000-0000-4000-8000-000000000002"),
        sequence: 2,
      }),
    ];
    const comments = await rig.listComments.list(RESIDENT, SOCIETY, EXPENSE_ID);
    expect(comments.map((comment) => comment.sequence)).toEqual([1, 2]);
  });
});

describe("fixture sanity", () => {
  it("uses exact bigint paise for GST amounts", () => {
    expect(paise(100n)).toBe(100n);
    const error = expenseError("validation", "x");
    expect(error.code).toBe("validation");
  });
});
