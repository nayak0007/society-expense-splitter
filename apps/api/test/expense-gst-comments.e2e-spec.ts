import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  DEFAULT_SOCIETY_SETTINGS,
  Money,
  asExpenseCategoryId,
  asExpenseCommentId,
  asExpenseId,
  asMemberId,
  asSocietyId,
  asUserId,
} from "@ses/domain";
import type {
  ExpenseId,
  ExpenseRecord,
  MemberRole,
  MembershipStatus,
  Society,
  SocietyId,
  SocietyMembership,
  StructureMembershipReader,
  UserId,
} from "@ses/domain";
import request from "supertest";

import type { SocietyAuthorizationContext } from "../src/common/authorization/society-authorization";
import {
  createFakeExpenseRepository,
  type FakeExpenseRepository,
} from "./utils/fake-expense-repository";
import {
  commentRecordFixture,
  createFakeCommentRepository,
  createFakeGstDetailsRepository,
  type FakeCommentRepository,
  type FakeGstDetailsRepository,
} from "./utils/fake-gst-comment-store";
import { createTestAuth, type TestAuth } from "./utils/supabase-auth";
import { createTestApp } from "./utils/test-app";

/**
 * `PUT /v1/expenses/:expenseId/gst` and the comment routes over real HTTP — T072.
 *
 * ## What runs for real
 *
 * The whole guard chain (a real signature, `X-Society-Id` resolved to a membership,
 * the matrix asked for `expense.create` on the GST route and `expense.view` on the
 * comment routes), the Zod pipes parsing the real contracts, the four use cases,
 * their author-or-Admin narrowing, the warning computation and the response mappers
 * and envelope. Only the three stores are faked — the expense store, the GST store
 * and the comment store — the same boundary the T064–T071 suites draw.
 *
 * ## What only the integration suite can prove
 *
 * Real SQL: the `expense_gst_details` atomic upsert and its RLS policies, the
 * `gst_single_regime` constraint, the `expense_comments` RLS + FORCE RLS + grants,
 * the identity sequence's ordering under concurrency, and the
 * `expense_comment_soft_delete()` definer function's own author-or-Admin check.
 * This file pins the HTTP surface and the orchestration the client actually sees.
 */

const SOCIETY_A = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const SOCIETY_B = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

const ADMIN: UserId = asUserId("11111111-1111-4111-8111-111111111111");
const TREASURER: UserId = asUserId("22222222-2222-4222-8222-222222222222");
const COMMITTEE: UserId = asUserId("77777777-7777-4777-8777-777777777777");
const RESIDENT: UserId = asUserId("33333333-3333-4333-8333-333333333333");
const TENANT: UserId = asUserId("55555555-5555-4555-8555-555555555555");
const GUEST: UserId = asUserId("44444444-4444-4444-8444-444444444444");

const EXPENSE = asExpenseId("20000000-0000-4000-8000-000000000001");
const EXPENSE_VOID = asExpenseId("20000000-0000-4000-8000-0000000000b2");
const CATEGORY = asExpenseCategoryId("0a000000-0000-4000-8000-000000000001");
const COMMENT_ID = asExpenseCommentId("30000000-0000-4000-8000-000000000001");

/** A GSTIN whose check digit is genuinely correct (mod-36). */
const VALID_GSTIN = "27AAPFU0939F1ZV";

function membershipOf(
  actor: UserId,
  role: MemberRole,
  status: MembershipStatus = "active",
  societyId: SocietyId = SOCIETY_A,
): SocietyMembership {
  return {
    id: asMemberId(`10000000-0000-4000-8000-${actor.slice(-12)}`),
    societyId,
    userId: actor,
    role,
    status,
    occupancyType: "owner",
    joinedAt: "2026-01-01T00:00:00.000Z",
  };
}

const ADMIN_MEMBERSHIP = membershipOf(ADMIN, "admin").id;
const RESIDENT_MEMBERSHIP = membershipOf(RESIDENT, "resident").id;

const societies = new Map<string, Society>([
  [
    SOCIETY_A,
    {
      id: SOCIETY_A,
      name: "Green Meadows",
      city: "Pune",
      type: "apartment",
      deletedAt: null,
      settings: { ...DEFAULT_SOCIETY_SETTINGS },
    } as unknown as Society,
  ],
]);

const memberships = new Map<string, SocietyMembership>();
const key = (societyId: string, actor: string) => `${societyId}:${actor}`;

const reader = {
  load(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyAuthorizationContext | null> {
    const membership = memberships.get(key(societyId, actor));
    const society = societies.get(societyId);
    if (membership === undefined || society === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ society, membership });
  },
};

const membershipReader: StructureMembershipReader = {
  findMembership(societyId, actor) {
    return Promise.resolve(memberships.get(key(societyId, actor)) ?? null);
  },
};

let app: NestFastifyApplication;
let auth: TestAuth;
let expenses: FakeExpenseRepository;
let gstDetails: FakeGstDetailsRepository;
let comments: FakeCommentRepository;

beforeAll(async () => {
  auth = await createTestAuth();
  expenses = createFakeExpenseRepository({
    memberIdOf: (societyId, actor) =>
      memberships.get(key(societyId, actor))?.id ?? null,
  });
  gstDetails = createFakeGstDetailsRepository();
  comments = createFakeCommentRepository();

  app = await createTestApp({
    jwks: auth.jwks,
    reader,
    membershipReader,
    expenses,
    gstDetails,
    comments,
  });
});

afterAll(async () => {
  await app.close();
});

function expenseRecord(overrides: Partial<ExpenseRecord> = {}): ExpenseRecord {
  return {
    id: EXPENSE,
    societyId: SOCIETY_A,
    categoryId: CATEGORY,
    title: "Lift AMC — Q3",
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
    createdBy: ADMIN_MEMBERSHIP,
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

beforeEach(() => {
  memberships.clear();
  memberships.set(key(SOCIETY_A, ADMIN), membershipOf(ADMIN, "admin"));
  memberships.set(
    key(SOCIETY_A, TREASURER),
    membershipOf(TREASURER, "treasurer"),
  );
  memberships.set(
    key(SOCIETY_A, COMMITTEE),
    membershipOf(COMMITTEE, "committee_member"),
  );
  memberships.set(key(SOCIETY_A, RESIDENT), membershipOf(RESIDENT, "resident"));
  memberships.set(key(SOCIETY_A, TENANT), membershipOf(TENANT, "tenant"));
  memberships.set(key(SOCIETY_A, GUEST), membershipOf(GUEST, "guest"));
  memberships.set(
    key(SOCIETY_B, ADMIN),
    membershipOf(ADMIN, "admin", "active", SOCIETY_B),
  );

  expenses.state.records.clear();
  expenses.state.calls.length = 0;
  gstDetails.state.rows.clear();
  comments.state.rows.length = 0;
  comments.state.deleted.length = 0;

  expenses.seed(expenseRecord());
  expenses.seed(expenseRecord({ id: EXPENSE_VOID, status: "void" }));
});

const server = () => request(app.getHttpServer());

async function call(
  method: "get" | "post" | "put" | "delete",
  path: string,
  options: {
    readonly userId?: UserId;
    readonly societyId?: string | null;
    readonly body?: unknown;
  } = {},
): Promise<request.Response> {
  let pending = server()[method](path);
  if (options.userId !== undefined) {
    pending = pending.set(
      "Authorization",
      `Bearer ${await auth.token(options.userId)}`,
    );
  }
  if (options.societyId !== null && options.societyId !== undefined) {
    pending = pending.set("X-Society-Id", options.societyId);
  }
  if (options.body !== undefined) {
    pending = pending.send(options.body as object);
  }
  return pending;
}

const putGst = (
  body: unknown,
  options: { readonly userId?: UserId; readonly expenseId?: ExpenseId } = {},
) =>
  call("put", `/v1/expenses/${options.expenseId ?? EXPENSE}/gst`, {
    userId: options.userId ?? ADMIN,
    societyId: SOCIETY_A,
    body,
  });

const listComments = (options: { readonly userId?: UserId } = {}) =>
  call("get", `/v1/expenses/${EXPENSE}/comments`, {
    userId: options.userId ?? RESIDENT,
    societyId: SOCIETY_A,
  });

const addComment = (
  body: unknown,
  options: { readonly userId?: UserId } = {},
) =>
  call("post", `/v1/expenses/${EXPENSE}/comments`, {
    userId: options.userId ?? RESIDENT,
    societyId: SOCIETY_A,
    body,
  });

const deleteComment = (options: { readonly userId?: UserId } = {}) =>
  call("delete", `/v1/expenses/${EXPENSE}/comments/${COMMENT_ID}`, {
    userId: options.userId ?? RESIDENT,
    societyId: SOCIETY_A,
  });

describe("authentication and the society header", () => {
  it("requires a session for both routes", async () => {
    expect(
      (
        await call("put", `/v1/expenses/${EXPENSE}/gst`, {
          societyId: SOCIETY_A,
          body: {},
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await call("get", `/v1/expenses/${EXPENSE}/comments`, {
          societyId: SOCIETY_A,
        })
      ).status,
    ).toBe(401);
  });

  it("requires X-Society-Id", async () => {
    expect(
      (
        await call("put", `/v1/expenses/${EXPENSE}/gst`, {
          userId: ADMIN,
          body: {},
        })
      ).status,
    ).toBe(400);
  });
});

describe("GST details", () => {
  it("records GST and returns no warning when the components reconcile", async () => {
    const response = await putGst({
      gstin: VALID_GSTIN,
      invoiceNumber: "KON/26-27/1187",
      invoiceDate: "2026-09-15",
      taxableValuePaise: 4_000_000,
      cgstPaise: 250_000,
      sgstPaise: 250_000,
      hsnSac: "998719",
      placeOfSupply: "Maharashtra",
    });
    expect(response.status).toBe(200);
    expect(response.body.data.gst.gstin).toBe(VALID_GSTIN);
    expect(response.body.data.warnings).toEqual([]);
  });

  it("warns, without failing, when the tax total does not reconcile (D7)", async () => {
    const response = await putGst({
      taxableValuePaise: 4_000_000,
      cgstPaise: 250_000,
    });
    expect(response.status).toBe(200);
    expect(response.body.data.warnings).toHaveLength(1);
    expect(response.body.data.warnings[0].code).toBe("TAX_TOTAL_MISMATCH");
    expect(response.body.data.warnings[0].differencePaise).toBe(250_000);
  });

  it("refuses an unknown field and a mixed tax regime at the contract", async () => {
    const unknown = await putGst({ unexpected: true });
    expect(unknown.status).toBe(400);

    const mixed = await putGst({ igstPaise: 100, cgstPaise: 100 });
    expect(mixed.status).toBe(422);
  });

  it("refuses an invalid GSTIN checksum", async () => {
    const response = await putGst({ gstin: "27AABCK1234M1Z5" });
    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("gstin");
  });

  it("allows a Committee Member to record GST on a draft and refuses it outside a draft", async () => {
    const draft = await putGst({ cgstPaise: 1 }, { userId: COMMITTEE });
    expect(draft.status).toBe(200);

    expenses.state.records.set(EXPENSE, expenseRecord({ status: "published" }));
    const published = await putGst({ cgstPaise: 1 }, { userId: COMMITTEE });
    expect(published.status).toBe(403);
  });

  it("refuses GST on a void expense (D4)", async () => {
    const response = await putGst(
      { cgstPaise: 100 },
      { expenseId: EXPENSE_VOID },
    );
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVALID_TRANSITION");
  });

  it("leaves approval stamps untouched (D5)", async () => {
    expenses.state.records.set(
      EXPENSE,
      expenseRecord({
        approvedBy: ADMIN_MEMBERSHIP,
        approvedAt: "2026-10-02T00:00:00.000Z",
      }),
    );
    const response = await putGst({ cgstPaise: 100 });
    expect(response.status).toBe(200);
    const stored = expenses.state.records.get(EXPENSE)!;
    expect(stored.approvedBy).toBe(ADMIN_MEMBERSHIP);
    expect(stored.approvedAt).toBe("2026-10-02T00:00:00.000Z");
  });

  it("answers 404 for an expense in another society", async () => {
    const response = await call("put", `/v1/expenses/${EXPENSE}/gst`, {
      userId: ADMIN,
      societyId: SOCIETY_B,
      body: { cgstPaise: 1 },
    });
    expect(response.status).toBe(404);
  });

  it("refuses a role without expense.create", async () => {
    const response = await putGst({ cgstPaise: 1 }, { userId: RESIDENT });
    expect(response.status).toBe(403);
  });
});

describe("comments", () => {
  it("lets every non-Guest role comment and refuses a Guest", async () => {
    for (const userId of [ADMIN, TREASURER, COMMITTEE, RESIDENT, TENANT]) {
      const response = await addComment(
        { body: `Hello from ${userId}` },
        { userId },
      );
      expect(response.status).toBe(201);
    }
    const guest = await addComment({ body: "nope" }, { userId: GUEST });
    expect(guest.status).toBe(403);
  });

  it("attributes the comment to the caller and orders the stream oldest first", async () => {
    await addComment({ body: "first" }, { userId: RESIDENT });
    await addComment({ body: "second" }, { userId: ADMIN });

    const response = await listComments({ userId: TENANT });
    expect(response.status).toBe(200);
    expect(
      response.body.data.comments.map((c: { body: string }) => c.body),
    ).toEqual(["first", "second"]);
    expect(response.body.data.comments[0].authorId).toBe(RESIDENT_MEMBERSHIP);
  });

  it("refuses a blank or control-character body", async () => {
    expect((await addComment({ body: "   " })).status).toBe(422);
    expect((await addComment({ body: "bad\u0007body" })).status).toBe(422);
  });

  it("lets the author soft-delete their own comment and hides the body afterwards", async () => {
    comments.seed(commentRecordFixture({ authorId: RESIDENT_MEMBERSHIP }));
    const response = await deleteComment({ userId: RESIDENT });
    expect(response.status).toBe(204);

    const after = await listComments({ userId: RESIDENT });
    const [comment] = after.body.data.comments;
    expect(comment.deleted).toBe(true);
    expect(comment.body).toBeNull();
    expect(comment.sequence).toBe(1);
  });

  it("refuses a member who is neither the author nor an Admin", async () => {
    comments.seed(commentRecordFixture({ authorId: ADMIN_MEMBERSHIP }));
    const response = await deleteComment({ userId: RESIDENT });
    expect(response.status).toBe(403);
  });

  it("lets an Admin soft-delete somebody else's comment", async () => {
    comments.seed(commentRecordFixture({ authorId: RESIDENT_MEMBERSHIP }));
    const response = await deleteComment({ userId: ADMIN });
    expect(response.status).toBe(204);
  });

  it("answers 404 for a comment outside the caller's society", async () => {
    const response = await call(
      "delete",
      `/v1/expenses/${EXPENSE}/comments/${COMMENT_ID}`,
      { userId: ADMIN, societyId: SOCIETY_B },
    );
    expect(response.status).toBe(404);
  });

  it("does not change an expense's approval by commenting", async () => {
    expenses.state.records.set(
      EXPENSE,
      expenseRecord({
        approvedBy: ADMIN_MEMBERSHIP,
        approvedAt: "2026-10-02T00:00:00.000Z",
      }),
    );
    await addComment({ body: "why so expensive?" });
    const stored = expenses.state.records.get(EXPENSE)!;
    expect(stored.approvedBy).toBe(ADMIN_MEMBERSHIP);
  });
});
