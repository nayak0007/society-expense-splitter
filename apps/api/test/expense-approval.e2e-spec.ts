import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  DEFAULT_SOCIETY_SETTINGS,
  asExpenseId,
  asMemberId,
  asSocietyId,
  asUserId,
} from "@ses/domain";
import type {
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
  createFakeCategoryRepository,
  type FakeCategoryRepository,
} from "./utils/fake-category-repository";
import {
  createFakeExpenseRepository,
  type FakeExpenseRepository,
} from "./utils/fake-expense-repository";
import {
  FakeParticipantDirectory,
  apartmentFixture,
  memberFixture,
} from "./utils/fake-participant-directory";
import { createFakeSocietyRepository } from "./utils/fake-society-repository";
import {
  createFakeEventPublisher,
  createFakeSplitRepository,
  type FakeEventPublisher,
  type FakeSplitRepository,
} from "./utils/fake-split-repository";
import { createTestAuth, type TestAuth } from "./utils/supabase-auth";
import { createTestApp } from "./utils/test-app";

/**
 * `POST /v1/expenses/:expenseId/approve` and `.../reject` over real HTTP — T070,
 * ADR-0011.
 *
 * ## What runs for real
 *
 * The whole guard chain (a real signature, `X-Society-Id` resolved to a membership,
 * the domain matrix asked for `expense.approve`), the Zod pipes parsing the real
 * contracts, the two use cases, the approval threshold rule that routes a new
 * high-value expense into `pending_approval`, the response mapper and the envelope.
 * Only storage is faked — the expense store, the category store, the participant
 * directory, the split writer and the event sink — the same boundary the T064–T069
 * suites draw, so a fake here still fails when a rule regresses.
 *
 * ## What this file pins, and what only Postgres can prove
 *
 * Here: Admin-only authorisation (including that an Admin may approve their own
 * expense and that Administrators are the *only* role that may), the strict payloads
 * (an unknown key and a missing lock are refused), the reason rule and its field,
 * the optimistic lock, the 404-not-403 tenancy rule, the terminal second decision,
 * rejection as `pending_approval → draft`, resubmission clearing the rejection
 * stamps, and that the approval queue is the ordinary listing filtered to
 * `pending_approval`. The definer functions' own refusals, the `BEFORE UPDATE`
 * guard, the row lock, RLS and the "zero financial writes" claim are real SQL: they
 * belong to `integration/expense-approval.integration-spec.ts`.
 */

const SOCIETY_A = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const SOCIETY_B = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

const ADMIN: UserId = asUserId("11111111-1111-4111-8111-111111111111");
const TREASURER: UserId = asUserId("22222222-2222-4222-8222-222222222222");
const COMMITTEE: UserId = asUserId("77777777-7777-4777-8777-777777777777");
const RESIDENT: UserId = asUserId("33333333-3333-4333-8333-333333333333");
const GUEST: UserId = asUserId("44444444-4444-4444-8444-444444444444");

function membershipOf(
  actor: UserId,
  role: MemberRole,
  status: MembershipStatus = "active",
): SocietyMembership {
  return {
    id: asMemberId(`10000000-0000-4000-8000-${actor.slice(-12)}`),
    societyId: SOCIETY_A,
    userId: actor,
    role,
    status,
    occupancyType: "owner",
    joinedAt: "2026-01-01T00:00:00.000Z",
  };
}

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
  [
    SOCIETY_B,
    {
      id: SOCIETY_B,
      name: "Palm Grove",
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
let categories: FakeCategoryRepository;
let expenses: FakeExpenseRepository;
let directory: FakeParticipantDirectory;
let splits: FakeSplitRepository;
let events: FakeEventPublisher;
let categoryId: string;

beforeAll(async () => {
  auth = await createTestAuth();
  categories = createFakeCategoryRepository();
  // The approver's own membership is what the definer function stamps, so the fake
  // is handed the same resolver the fixtures use — without it, `approvedBy` would
  // fall back to the row's creator and the "Admin approves somebody else's expense"
  // assertions would be vacuous.
  expenses = createFakeExpenseRepository({
    memberIdOf: (societyId, actor) =>
      memberships.get(key(societyId, actor))?.id ?? null,
  });
  directory = new FakeParticipantDirectory();
  splits = createFakeSplitRepository(expenses);
  events = createFakeEventPublisher();

  const societyRepository = createFakeSocietyRepository({
    societies: [...societies.values()],
    memberships: [
      membershipOf(ADMIN, "admin"),
      membershipOf(TREASURER, "treasurer"),
      membershipOf(COMMITTEE, "committee_member"),
      membershipOf(RESIDENT, "resident"),
      membershipOf(GUEST, "guest"),
    ],
  });

  app = await createTestApp({
    jwks: auth.jwks,
    reader,
    membershipReader,
    categories,
    repository: societyRepository,
    expenses,
    splits,
    events,
    memberNames: directory,
    participants: directory,
  });
});

afterAll(async () => {
  await app.close();
});

/** Four flats, each with somebody to charge. */
function seedBaseWorld(): void {
  directory.seedDirectory(SOCIETY_A, {
    apartments: [
      apartmentFixture("101"),
      apartmentFixture("102"),
      apartmentFixture("103"),
      apartmentFixture("104"),
    ],
    members: [
      memberFixture("m101", "101"),
      memberFixture("m102", "102"),
      memberFixture("m103", "103"),
      memberFixture("m104", "104"),
    ],
  });
  directory.seedBillVacantFlats(SOCIETY_A, true);
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
  memberships.set(key(SOCIETY_A, GUEST), membershipOf(GUEST, "guest"));
  // An Admin of the *other* tenant, so a cross-society id proves the 404-not-403
  // rule rather than merely failing to authenticate.
  memberships.set(key(SOCIETY_B, ADMIN), {
    ...membershipOf(ADMIN, "admin"),
    societyId: SOCIETY_B,
  });

  categories.state.categories.clear();
  categories.state.calls.length = 0;
  categoryId = categories.seed(SOCIETY_A, {
    id: "0a000000-0000-4000-8000-000000000001",
    name: "Lift AMC",
  }).id;

  expenses.state.records.clear();
  expenses.state.calls.length = 0;
  splits.state.records.clear();
  splits.state.splits.clear();
  splits.state.calls.length = 0;
  events.reset();

  directory.reset();
  seedBaseWorld();
});

const server = () => request(app.getHttpServer());

async function call(
  method: "get" | "post" | "patch" | "delete",
  path: string,
  options: {
    readonly userId?: UserId;
    readonly societyId?: string | null;
    readonly body?: unknown;
    readonly idempotencyKey?: string | null;
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
  if (options.idempotencyKey !== null && options.idempotencyKey !== undefined) {
    pending = pending.set("Idempotency-Key", options.idempotencyKey);
  }
  if (options.body !== undefined) {
    pending = pending.send(options.body as object);
  }
  return pending;
}

const ADMIN_MEMBERSHIP = membershipOf(ADMIN, "admin").id;

const draftBody = (overrides: Record<string, unknown> = {}) => ({
  title: "Lift AMC — Q3",
  amountPaise: 40_000,
  expenseDate: "2026-09-30",
  categoryId,
  ...overrides,
});

/**
 * Creates an expense and returns its id, plus the version it landed with.
 *
 * `amountPaise` above the society's threshold makes the create path route the row
 * into `pending_approval` (D3/D4), which is the fixture every decision test needs.
 */
async function createExpense(
  overrides: Record<string, unknown> = {},
  options: { readonly userId?: UserId } = {},
): Promise<{ id: string; version: number; status: string }> {
  const response = await call("post", "/v1/expenses", {
    userId: options.userId ?? ADMIN,
    societyId: SOCIETY_A,
    body: draftBody(overrides),
  });
  expect(response.status).toBe(201);
  return {
    id: response.body.data.expense.id as string,
    version: response.body.data.expense.version as number,
    status: response.body.data.expense.status as string,
  };
}

/** A `pending_approval` expense — the queue entry an Admin decides on. */
function pendingExpense(
  overrides: Record<string, unknown> = {},
  options: { readonly userId?: UserId } = {},
) {
  return createExpense({ amountPaise: 2_000_000, ...overrides }, options);
}

function approve(
  expenseId: string,
  body: unknown,
  options: { readonly userId?: UserId; readonly societyId?: string } = {},
) {
  return call("post", `/v1/expenses/${expenseId}/approve`, {
    userId: options.userId ?? ADMIN,
    societyId: options.societyId ?? SOCIETY_A,
    body,
  });
}

function reject(
  expenseId: string,
  body: unknown,
  options: { readonly userId?: UserId; readonly societyId?: string } = {},
) {
  return call("post", `/v1/expenses/${expenseId}/reject`, {
    userId: options.userId ?? ADMIN,
    societyId: options.societyId ?? SOCIETY_A,
    body,
  });
}

const REASON = "The vendor invoice does not match the quote.";

describe("POST /v1/expenses/:expenseId/approve", () => {
  it("refuses a path parameter that is not a UUID before any query runs", async () => {
    const response = await call("post", "/v1/expenses/not-a-uuid/approve", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { expectedVersion: 1 },
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("expenseId");
  });

  it("stamps the approval, clears stale rejection metadata and leaves the status awaiting publication", async () => {
    const { id } = await pendingExpense();

    const response = await approve(id, { expectedVersion: 1 });

    expect(response.status).toBe(200);
    const expense = response.body.data.expense as Record<string, unknown>;
    // Approval is a decision, not a publication: the status must not move.
    expect(expense["status"]).toBe("pending_approval");
    expect(expense["approvedBy"]).toBe(ADMIN_MEMBERSHIP);
    expect(expense["approvedAt"]).not.toBeNull();
    expect(expense["rejectedBy"]).toBeNull();
    expect(expense["rejectedAt"]).toBeNull();
    expect(expense["rejectionReason"]).toBeNull();
    expect(expense["version"]).toBe(2);
    // No financial row and no announcement: approval writes nothing but the row.
    expect(splits.state.splits.size).toBe(0);
    expect(events.dispatched).toHaveLength(0);
  });

  it("lets an Admin approve their own expense — the single-Admin society must not deadlock (D5)", async () => {
    const { id } = await pendingExpense({}, { userId: ADMIN });

    const response = await approve(
      id,
      { expectedVersion: 1 },
      { userId: ADMIN },
    );

    expect(response.status).toBe(200);
    expect(response.body.data.expense.approvedBy).toBe(ADMIN_MEMBERSHIP);
  });

  it("refuses a Treasurer who created the expense themselves", async () => {
    const { id } = await pendingExpense({}, { userId: TREASURER });

    const response = await approve(
      id,
      { expectedVersion: 1 },
      {
        userId: TREASURER,
      },
    );

    // The refusal is the role rule, not a self-approval rule (D5).
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(expenses.state.records.get(asExpenseId(id))?.approvedBy).toBeNull();
  });

  it.each([
    ["Committee Member", COMMITTEE],
    ["Resident", RESIDENT],
    ["Guest", GUEST],
  ])("refuses a %s", async (_label, actor) => {
    const { id } = await pendingExpense();

    const response = await approve(
      id,
      { expectedVersion: 1 },
      { userId: actor },
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("requires a session", async () => {
    const { id } = await pendingExpense();

    const response = await call("post", `/v1/expenses/${id}/approve`, {
      societyId: SOCIETY_A,
      body: { expectedVersion: 1 },
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("refuses a body without expectedVersion as syntactic", async () => {
    const { id } = await pendingExpense();

    const response = await approve(id, {});

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details[0]).toMatchObject({
      field: "expectedVersion",
    });
  });

  it("refuses an unknown key rather than ignoring it — the payload is strictly the lock", async () => {
    const { id } = await pendingExpense();

    const response = await approve(id, {
      expectedVersion: 1,
      approvedBy: ADMIN_MEMBERSHIP,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a stale expectedVersion with the row's current one", async () => {
    const { id } = await pendingExpense();

    const response = await approve(id, { expectedVersion: 9 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("VERSION_MISMATCH");
    expect(response.body.error.details[0]).toMatchObject({
      field: "expectedVersion",
      code: "STALE",
      received: 9,
      current: 1,
    });
  });

  it("refuses a draft that never needed approval", async () => {
    const { id } = await createExpense({ amountPaise: 40_000 });

    const response = await approve(id, { expectedVersion: 1 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVALID_TRANSITION");
  });

  it("refuses a second approval rather than replaying the first", async () => {
    const { id } = await pendingExpense();
    expect((await approve(id, { expectedVersion: 1 })).status).toBe(200);

    const response = await approve(id, { expectedVersion: 2 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVALID_TRANSITION");
  });

  it("refuses a published expense", async () => {
    const { id } = await createExpense({ amountPaise: 40_000 });
    await call("post", `/v1/expenses/${id}/publish`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      idempotencyKey: "publish-key-approval-0001",
      body: { expectedVersion: 1 },
    });

    const response = await approve(id, { expectedVersion: 2 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVALID_TRANSITION");
  });

  it("answers not_found for another society's expense — 404, not 403", async () => {
    const { id } = await pendingExpense();

    const response = await approve(
      id,
      { expectedVersion: 1 },
      {
        societyId: SOCIETY_B,
      },
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});

describe("POST /v1/expenses/:expenseId/reject", () => {
  it("requires a session", async () => {
    const response = await call(
      "post",
      "/v1/expenses/20000000-0000-4000-8000-000000000001/reject",
      { societyId: SOCIETY_A, body: { expectedVersion: 1, reason: REASON } },
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("refuses a path parameter that is not a UUID before any query runs", async () => {
    const response = await call("post", "/v1/expenses/not-a-uuid/reject", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { expectedVersion: 1, reason: REASON },
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("expenseId");
  });

  it("returns the expense to draft with the three stamps and the approval cleared", async () => {
    const { id } = await pendingExpense();
    await approve(id, { expectedVersion: 1 });

    const response = await reject(id, { expectedVersion: 2, reason: REASON });

    expect(response.status).toBe(200);
    const expense = response.body.data.expense as Record<string, unknown>;
    // There is no `rejected` status (D1): a rejection is a resubmittable draft.
    expect(expense["status"]).toBe("draft");
    expect(expense["rejectedBy"]).toBe(ADMIN_MEMBERSHIP);
    expect(expense["rejectedAt"]).not.toBeNull();
    expect(expense["rejectionReason"]).toBe(REASON);
    expect(expense["approvedBy"]).toBeNull();
    expect(expense["approvedAt"]).toBeNull();
    expect(expense["version"]).toBe(3);
    expect(splits.state.splits.size).toBe(0);
    expect(events.dispatched).toHaveLength(0);
  });

  it("clears the rejection stamps when the creator resubmits", async () => {
    const { id } = await pendingExpense();
    await reject(id, { expectedVersion: 1, reason: REASON });

    // The edit keeps the amount above the threshold, so the row is routed straight
    // back into the queue — with the Admin's previous decision gone (D1/D2).
    const edited = await call("patch", `/v1/expenses/${id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { expectedVersion: 2, title: "Lift AMC — Q3 (revised)" },
    });

    expect(edited.status).toBe(200);
    const expense = edited.body.data.expense as Record<string, unknown>;
    expect(expense["status"]).toBe("pending_approval");
    expect(expense["rejectedBy"]).toBeNull();
    expect(expense["rejectedAt"]).toBeNull();
    expect(expense["rejectionReason"]).toBeNull();
    expect(expense["approvedBy"]).toBeNull();
  });

  it("refuses a reason shorter than ten characters, against the `reason` field", async () => {
    const { id } = await pendingExpense();

    const response = await reject(id, {
      expectedVersion: 1,
      reason: "too short",
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details[0]).toMatchObject({ field: "reason" });
    expect(expenses.state.records.get(asExpenseId(id))?.status).toBe(
      "pending_approval",
    );
  });

  it("refuses a reason that is only whitespace — the length is measured after trimming", async () => {
    const { id } = await pendingExpense();

    const response = await reject(id, {
      expectedVersion: 1,
      reason: "               ",
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a reason containing a control character", async () => {
    const { id } = await pendingExpense();

    const response = await reject(id, {
      expectedVersion: 1,
      reason: "Duplicate\u0007 bill from the vendor",
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("requires the reason", async () => {
    const { id } = await pendingExpense();

    const response = await reject(id, { expectedVersion: 1 });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details[0]).toMatchObject({ field: "reason" });
  });

  it("refuses an unknown key rather than ignoring it", async () => {
    const { id } = await pendingExpense();

    const response = await reject(id, {
      expectedVersion: 1,
      reason: REASON,
      rejectedBy: ADMIN_MEMBERSHIP,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it.each([
    ["Treasurer", TREASURER],
    ["Committee Member", COMMITTEE],
    ["Resident", RESIDENT],
    ["Guest", GUEST],
  ])("refuses a %s", async (_label, actor) => {
    const { id } = await pendingExpense();

    const response = await reject(
      id,
      { expectedVersion: 1, reason: REASON },
      { userId: actor },
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("refuses a draft — only a decision that is waiting can be refused", async () => {
    const { id } = await createExpense({ amountPaise: 40_000 });

    const response = await reject(id, { expectedVersion: 1, reason: REASON });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVALID_TRANSITION");
  });

  it("refuses a stale lock", async () => {
    const { id } = await pendingExpense();

    const response = await reject(id, { expectedVersion: 5, reason: REASON });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("VERSION_MISMATCH");
  });

  it("refuses a second rejection of the same row", async () => {
    const { id } = await pendingExpense();
    expect(
      (await reject(id, { expectedVersion: 1, reason: REASON })).status,
    ).toBe(200);

    const response = await reject(id, { expectedVersion: 2, reason: REASON });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVALID_TRANSITION");
  });

  it("answers not_found for another society's expense", async () => {
    const { id } = await pendingExpense();

    const response = await reject(
      id,
      { expectedVersion: 1, reason: REASON },
      { societyId: SOCIETY_B },
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});

describe("the approval queue is the ordinary listing, filtered (D7)", () => {
  it("serves pending_approval entries through GET /v1/expenses?status=pending_approval", async () => {
    const pending = await pendingExpense();
    await createExpense({ amountPaise: 40_000 });

    const response = await call("get", "/v1/expenses?status=pending_approval", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    const ids = (response.body.data.expenses as { id: string }[]).map(
      (expense) => expense.id,
    );
    expect(ids).toEqual([pending.id]);
    // The queue's own facts are already on the DTO: requester, amount and the
    // instant the age is measured from.
    const entry = response.body.data.expenses[0] as Record<string, unknown>;
    expect(entry["createdBy"]).toBe(ADMIN_MEMBERSHIP);
    expect(entry["amountPaise"]).toBe(2_000_000);
    expect(entry["createdAt"]).not.toBeNull();
  });

  it("shows an approved entry with its approval visible in the same queue", async () => {
    const { id } = await pendingExpense();
    await approve(id, { expectedVersion: 1 });

    const response = await call("get", "/v1/expenses?status=pending_approval", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    const entry = response.body.data.expenses[0] as Record<string, unknown>;
    expect(entry["id"]).toBe(id);
    expect(entry["approvedBy"]).toBe(ADMIN_MEMBERSHIP);
    expect(entry["approvedAt"]).not.toBeNull();
  });

  it("is readable by a Treasurer, who can see the work but cannot act on it", async () => {
    await pendingExpense();

    const response = await call("get", "/v1/expenses?status=pending_approval", {
      userId: TREASURER,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.expenses).toHaveLength(1);
  });
});
