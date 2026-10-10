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
  id,
  memberFixture,
} from "./utils/fake-participant-directory";
import {
  createFakeRevisionRepository,
  type FakeRevisionRepository,
} from "./utils/fake-revision-repository";
import { createFakeSocietyRepository } from "./utils/fake-society-repository";
import {
  createFakeSplitRepository,
  type FakeSplitRepository,
} from "./utils/fake-split-repository";
import { createTestAuth, type TestAuth } from "./utils/supabase-auth";
import { createTestApp } from "./utils/test-app";

/**
 * `PATCH /v1/expenses/:expenseId` on a published expense and
 * `GET /v1/expenses/:expenseId/revisions` over real HTTP — Roadmap T068.
 *
 * ## What runs for real
 *
 * The whole guard chain (a real signature, `X-Society-Id` resolved to a membership,
 * the matrix asked), the Zod pipes parsing the real contracts, T065's `PATCH`
 * dispatch, T068's recalculation use case with T063's resolver composition and the
 * **real split engine**, the response mappers and the envelope. Only storage is
 * faked: the expense store, the category store, the participant directory, the split
 * writer and the revision reader — the same boundary the T064–T066 suites draw, so a
 * fake here still fails when a rule regresses.
 *
 * ## What this file pins, and what only Postgres can prove
 *
 * Here: which door a stored status opens, the two response shapes, the immutable-field
 * and change-note refusals, the optimistic lock, the `void` refusal, the revision the
 * write appended (pre-edit version, BEFORE snapshot, note), and who may read the
 * history. The due lifecycle, the balance deltas, the paid-obligation block, the
 * conservation invariant, RLS and the concurrency behaviour are real SQL — they belong
 * to `expense-recalculate.integration-spec.ts`, which proves them against PostgreSQL 18.
 */

const SOCIETY_A = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const SOCIETY_B = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

const ADMIN: UserId = asUserId("11111111-1111-4111-8111-111111111111");
const TREASURER: UserId = asUserId("22222222-2222-4222-8222-222222222222");
const COMMITTEE: UserId = asUserId("77777777-7777-4777-8777-777777777777");
const RESIDENT: UserId = asUserId("33333333-3333-4333-8333-333333333333");
const GUEST: UserId = asUserId("44444444-4444-4444-8444-444444444444");
const OUTSIDER: UserId = asUserId("66666666-6666-4666-8666-666666666666");

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
let revisions: FakeRevisionRepository;
let categoryId: string;

beforeAll(async () => {
  auth = await createTestAuth();
  categories = createFakeCategoryRepository();
  expenses = createFakeExpenseRepository();
  directory = new FakeParticipantDirectory();
  revisions = createFakeRevisionRepository();
  // The revision *write* belongs to the recalculation transaction, so the split fake
  // appends to the revision store — exactly as `expense_recalculate()` writes the row
  // inside its own transaction, and the reason a separately-written fake would be a
  // second writer nothing exercises.
  splits = createFakeSplitRepository(expenses, undefined, revisions);

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
    revisions,
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
  revisions.reset();

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

const draftBody = (overrides: Record<string, unknown> = {}) => ({
  title: "Lift AMC — Q3",
  amountPaise: 40_000,
  expenseDate: "2026-09-30",
  categoryId,
  ...overrides,
});

/** Creates a draft, publishes it, and returns the id — the published fixture. */
async function publishedExpense(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const created = await call("post", "/v1/expenses", {
    userId: ADMIN,
    societyId: SOCIETY_A,
    body: draftBody(overrides),
  });
  expect(created.status).toBe(201);
  const expenseId = created.body.data.expense.id as string;

  const published = await call("post", `/v1/expenses/${expenseId}/publish`, {
    userId: ADMIN,
    societyId: SOCIETY_A,
    idempotencyKey: "publish-key-0001",
    body: { expectedVersion: 1 },
  });
  expect(published.status).toBe(200);
  return expenseId;
}

function revise(
  expenseId: string,
  body: unknown,
  options: {
    readonly userId?: UserId;
    readonly societyId?: string | null;
  } = {},
) {
  return call("patch", `/v1/expenses/${expenseId}`, {
    userId: options.userId ?? ADMIN,
    societyId: options.societyId === undefined ? SOCIETY_A : options.societyId,
    body,
  });
}

function history(
  expenseId: string,
  options: {
    readonly userId?: UserId;
    readonly societyId?: string | null;
  } = {},
) {
  return call("get", `/v1/expenses/${expenseId}/revisions`, {
    userId: options.userId ?? ADMIN,
    societyId: options.societyId === undefined ? SOCIETY_A : options.societyId,
  });
}

describe("PATCH /v1/expenses/:expenseId on a published expense", () => {
  it("revises it and answers the row plus the diff, with the splits re-persisted", async () => {
    const expenseId = await publishedExpense();
    expect(splits.state.splits.get(asExpenseId(expenseId))).toHaveLength(4);

    const response = await revise(expenseId, {
      expectedVersion: 2,
      title: "Lift AMC — Q3 revised",
      amountPaise: 60_000,
      changeNote: "Revised after the AGM",
    });

    expect(response.status).toBe(200);
    expect(response.body.data.expense.title).toBe("Lift AMC — Q3 revised");
    expect(response.body.data.expense.amountPaise).toBe(60_000);
    expect(response.body.data.expense.status).toBe("published");
    expect(response.body.data.expense.version).toBe(3);
    expect(response.body.data.recalculation).toMatchObject({
      duesUpdated: 4,
      duesSuperseded: 0,
      duesCreated: 0,
      totalDeltaPaise: 20_000,
      affectedMembers: 4,
      blockedByPaidSplits: 0,
    });

    // The persisted split set is the new plan, and it conserves the new amount.
    const persisted = splits.state.splits.get(asExpenseId(expenseId)) ?? [];
    expect(persisted).toHaveLength(4);
    expect(
      persisted.reduce((sum, allocation) => sum + allocation.amount.paise, 0n),
    ).toBe(60_000n);
  });

  it("supersedes a removed participant's share and reports it", async () => {
    const expenseId = await publishedExpense();

    const response = await revise(expenseId, {
      expectedVersion: 2,
      participantSelector: { excludeApartments: [id("104")] },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.recalculation).toMatchObject({
      duesUpdated: 3,
      duesSuperseded: 1,
      duesCreated: 0,
      totalDeltaPaise: 0,
      affectedMembers: 4,
    });
    expect(splits.state.splits.get(asExpenseId(expenseId))).toHaveLength(3);
  });

  it("records exactly one revision, with the pre-edit version and the BEFORE snapshot", async () => {
    const expenseId = await publishedExpense();
    await revise(expenseId, {
      expectedVersion: 2,
      title: "Lift AMC — revised",
      changeNote: "Revised after the AGM",
    });

    const response = await history(expenseId);

    expect(response.status).toBe(200);
    expect(response.body.data.revisions).toHaveLength(1);
    const [revision] = response.body.data.revisions as {
      version: number;
      changeNote: string | null;
      snapshot: { expense: Record<string, unknown>; splits: unknown[] };
      changedBy: string;
      expenseId: string;
    }[];
    expect(revision?.version).toBe(2);
    expect(revision?.expenseId).toBe(expenseId);
    expect(revision?.changeNote).toBe("Revised after the AGM");
    expect(revision?.changedBy).toBe("10000000-0000-4000-8000-111111111111");
    // The snapshot is the state the revision replaced: the old title, and the whole
    // authoritative split set of that state.
    expect(revision?.snapshot.expense).toMatchObject({
      title: "Lift AMC — Q3",
      amountPaise: "40000",
      status: "published",
      version: 2,
    });
    expect(revision?.snapshot.splits).toHaveLength(4);
  });

  it("answers an empty history for an expense that has never been revised", async () => {
    const expenseId = await publishedExpense();

    const response = await history(expenseId);

    expect(response.status).toBe(200);
    expect(response.body.data.revisions).toEqual([]);
  });

  it("keeps a draft edit on the draft door — no diff in the body", async () => {
    const created = await call("post", "/v1/expenses", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: draftBody(),
    });
    const expenseId = created.body.data.expense.id as string;

    const response = await revise(expenseId, {
      expectedVersion: 1,
      title: "Still a draft",
    });

    expect(response.status).toBe(200);
    expect(response.body.data.expense.title).toBe("Still a draft");
    expect(response.body.data.recalculation).toBeUndefined();
    expect(revisions.state.records).toHaveLength(0);
  });

  it("refuses an immutable field by name, before any revision", async () => {
    const expenseId = await publishedExpense();

    const response = await revise(expenseId, {
      expectedVersion: 2,
      categoryId: "0a000000-0000-4000-8000-00000000000f",
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("categoryId");
    expect(revisions.state.records).toHaveLength(0);
    expect(expenses.state.calls).not.toContain("update");
  });

  it("refuses a change note on a draft edit", async () => {
    const created = await call("post", "/v1/expenses", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: draftBody(),
    });
    const expenseId = created.body.data.expense.id as string;

    const response = await revise(expenseId, {
      expectedVersion: 1,
      title: "Still a draft",
      changeNote: "Nothing to annotate",
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("changeNote");
  });

  it("answers 409 VERSION_MISMATCH with the row's current version", async () => {
    const expenseId = await publishedExpense();

    const response = await revise(expenseId, {
      expectedVersion: 1,
      title: "Stale",
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("VERSION_MISMATCH");
    expect(response.body.error.details[0]).toMatchObject({
      field: "expectedVersion",
      code: "STALE",
      received: 1,
      current: 2,
    });
    expect(revisions.state.records).toHaveLength(0);
  });

  it("refuses a void expense with INVALID_TRANSITION", async () => {
    const expenseId = await publishedExpense();
    const stored = expenses.state.records.get(asExpenseId(expenseId));
    expect(stored).toBeDefined();
    expenses.seed({
      ...(stored as NonNullable<typeof stored>),
      status: "void",
      voidedAt: "2026-10-01T00:00:00.000Z",
      voidReason: "Duplicate of the September bill",
    });

    const response = await revise(expenseId, {
      expectedVersion: 2,
      title: "Too late",
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVALID_TRANSITION");
    expect(revisions.state.records).toHaveLength(0);
  });

  it("refuses a Committee Member, whose grant is draft-only", async () => {
    const expenseId = await publishedExpense();

    const response = await revise(
      expenseId,
      { expectedVersion: 2, title: "Committee revision" },
      { userId: COMMITTEE },
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("refuses a Guest", async () => {
    const expenseId = await publishedExpense();

    const response = await revise(
      expenseId,
      { expectedVersion: 2, title: "Guest revision" },
      { userId: GUEST },
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("answers 404 — not 403 — for a society the caller is not in", async () => {
    const expenseId = await publishedExpense();

    const response = await revise(
      expenseId,
      { expectedVersion: 2, title: "Outsider revision" },
      { userId: OUTSIDER, societyId: SOCIETY_B },
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("requires a session before anything else", async () => {
    const expenseId = await publishedExpense();

    const response = await call("patch", `/v1/expenses/${expenseId}`, {
      societyId: SOCIETY_A,
      body: { expectedVersion: 2, title: "Anonymous" },
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });
});

describe("GET /v1/expenses/:expenseId/revisions", () => {
  it("requires a session before anything else", async () => {
    const response = await call(
      "get",
      "/v1/expenses/20000000-0000-4000-8000-000000000001/revisions",
      { societyId: SOCIETY_A },
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("refuses a path parameter that is not a UUID before any query runs", async () => {
    const response = await call("get", "/v1/expenses/not-a-uuid/revisions", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("expenseId");
  });

  it("is readable by a Resident — the history is a transparency feature", async () => {
    const expenseId = await publishedExpense();
    await revise(expenseId, { expectedVersion: 2, title: "Revised" });

    const response = await history(expenseId, { userId: RESIDENT });

    expect(response.status).toBe(200);
    expect(response.body.data.revisions).toHaveLength(1);
  });

  it("is readable by the Treasurer too", async () => {
    const expenseId = await publishedExpense();
    await revise(expenseId, { expectedVersion: 2, title: "Revised" });

    const response = await history(expenseId, { userId: TREASURER });

    expect(response.status).toBe(200);
    expect(response.body.data.revisions).toHaveLength(1);
  });

  it("refuses a Guest", async () => {
    const expenseId = await publishedExpense();

    const response = await history(expenseId, { userId: GUEST });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("answers 404 for an unknown expense, and for another society", async () => {
    const unknown = await history("20000000-0000-4000-8000-00000000dead");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("NOT_FOUND");

    const expenseId = await publishedExpense();
    const crossTenant = await history(expenseId, {
      userId: OUTSIDER,
      societyId: SOCIETY_B,
    });
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.body.error.code).toBe("NOT_FOUND");
  });
});
