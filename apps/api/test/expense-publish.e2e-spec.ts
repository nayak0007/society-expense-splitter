import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  DEFAULT_SOCIETY_SETTINGS,
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
 * `POST /v1/expenses/:expenseId/publish` over real HTTP — Roadmap T066.
 *
 * ## What runs for real
 *
 * The whole guard chain (a real signature over a locally held key pair, `X-Society-Id`
 * resolved to a membership, the matrix asked), the header pipe that validates
 * `Idempotency-Key`, the Zod pipe parsing the real publish contract, the publish use
 * case, T063's resolver composition, the **real split engine**, the aggregate's own
 * `publish()`, the response mapper and the envelope. Only storage is faked: the
 * category store, the expense store, the participant directory, the split store and the
 * event sink — the same boundary the T064/T065 suites draw, so a fake here still fails
 * when a rule regresses.
 *
 * ## The matrix this file pins
 *
 * The Roadmap's acceptance and test list plus the tenancy rules the module inherits:
 * authentication and the society header, Guest/Resident/Committee refusals, Admin and
 * Treasurer acceptance, a publish whose summary conserves the amount, the split rows
 * written where the read path sees them, `Idempotency-Replayed` on a retry, the
 * `409 IDEMPOTENCY_KEY_REUSE` for a key reused for another request, a stale
 * `expectedVersion`, an already-published expense, a void one, cross-society
 * `not_found`, the fail-closed unassigned refusal with one detail per flat, the
 * preview/publish parity claim, and the ordering of the event.
 *
 * ## What only the integration suite can prove
 *
 * Real SQL: the `expense_publish()` definer function, the row lock, RLS, the deferred
 * `chk_split_total()` trigger, the `(user_id, idempotency_key)` unique index and the
 * rollback of a mid-transaction failure. This file pins the HTTP surface.
 */

const SOCIETY_A = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const SOCIETY_B = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

const ADMIN: UserId = asUserId("11111111-1111-4111-8111-111111111111");
const TREASURER: UserId = asUserId("22222222-2222-4222-8222-222222222222");
const COMMITTEE: UserId = asUserId("77777777-7777-4777-8777-777777777777");
const RESIDENT: UserId = asUserId("33333333-3333-4333-8333-333333333333");
const GUEST: UserId = asUserId("44444444-4444-4444-8444-444444444444");
const PENDING: UserId = asUserId("55555555-5555-4555-8555-555555555555");
const OUTSIDER: UserId = asUserId("66666666-6666-4666-8666-666666666666");

/**
 * Deterministic membership id, so a response's `createdBy` can be asserted.
 *
 * Not `id(\`membership-${actor}\`)`: that helper keys on the label's first six
 * characters, and every label starting `membership-` collapses to one uuid.
 */
function membershipIdOf(actor: UserId): string {
  return `10000000-0000-4000-8000-${actor.slice(-12)}`;
}

function membershipOf(
  actor: UserId,
  role: MemberRole,
  status: MembershipStatus = "active",
): SocietyMembership {
  return {
    id: asMemberId(membershipIdOf(actor)),
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

/** The guard's resolution: a society plus the caller's membership, or nothing. */
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

/** The use cases' membership read — the same world, a separate seam. */
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
  expenses = createFakeExpenseRepository();
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
    memberNames: directory,
    events,
    participants: directory,
  });
});

afterAll(async () => {
  await app.close();
});

/** The base world: three flats with members, one vacant with nobody linked. */
function seedBaseWorld(): void {
  directory.seedDirectory(SOCIETY_A, {
    apartments: [
      apartmentFixture("101", {
        floor: 1,
        carpetAreaSqft: 700,
        builtupAreaSqft: 800,
        bhk: 2,
        parkingSlots: 2,
        shareUnits: 2,
      }),
      apartmentFixture("102", {
        floor: 2,
        carpetAreaSqft: 350,
        builtupAreaSqft: 400,
        bhk: 1,
        parkingSlots: 1,
        shareUnits: 1,
      }),
      apartmentFixture("103", {
        floor: 2,
        carpetAreaSqft: 350,
        builtupAreaSqft: 400,
        bhk: 1,
        parkingSlots: 0,
        shareUnits: 1,
        occupancyStatus: "rented",
      }),
      apartmentFixture("104", {
        floor: 3,
        carpetAreaSqft: 350,
        builtupAreaSqft: 400,
        bhk: 1,
        parkingSlots: 0,
      }),
    ],
    // Flat 104 is vacant but has an owner living elsewhere — the case PRD §3.3 bills
    // through (`vacant_owner`), so the base world is fully assignable and the
    // fail-closed test is the one that removes somebody.
    members: [
      memberFixture("m101", "101"),
      memberFixture("m102", "102"),
      memberFixture("t103", "103", { occupancy: "tenant" }),
      memberFixture("o104", "104", { occupancy: "vacant_owner" }),
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
  memberships.set(
    key(SOCIETY_A, PENDING),
    membershipOf(PENDING, "resident", "pending"),
  );
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
  // A category of the other tenant exists, so the resolver's own tenancy is exercised.
  categories.seed(SOCIETY_B, {
    id: "0b000000-0000-4000-8000-000000000002",
    name: "Palm Lift",
  });

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

/** `POST /v1/expenses` as an authenticated member of SOCIETY_A. */
function create(body: unknown, options: { readonly userId?: UserId } = {}) {
  return call("post", "/v1/expenses", {
    userId: options.userId ?? ADMIN,
    societyId: SOCIETY_A,
    body,
  });
}

const draftBody = (overrides: Record<string, unknown> = {}) => ({
  title: "Lift AMC — Q3",
  amountPaise: 90_000,
  expenseDate: "2026-09-30",
  categoryId,
  ...overrides,
});

/** Creates a draft and returns its id — the fixture every publish needs. */
async function createDraft(
  overrides: Record<string, unknown> = {},
  options: { readonly userId?: UserId } = {},
): Promise<string> {
  const response = await create(draftBody(overrides), options);
  expect(response.status).toBe(201);
  return response.body.data.expense.id as string;
}

const KEY = "publish-key-0001";

function publish(
  expenseId: string,
  options: {
    readonly userId?: UserId;
    readonly societyId?: string | null;
    readonly body?: unknown;
    readonly idempotencyKey?: string | null;
  } = {},
) {
  return call("post", `/v1/expenses/${expenseId}/publish`, {
    userId: options.userId ?? ADMIN,
    societyId: options.societyId === undefined ? SOCIETY_A : options.societyId,
    idempotencyKey:
      options.idempotencyKey === undefined ? KEY : options.idempotencyKey,
    body: options.body ?? { expectedVersion: 1 },
  });
}

describe("authentication and the society header", () => {
  it("requires a session before anything else", async () => {
    const expenseId = await createDraft();

    const response = await call("post", `/v1/expenses/${expenseId}/publish`, {
      societyId: SOCIETY_A,
      idempotencyKey: KEY,
      body: { expectedVersion: 1 },
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("requires X-Society-Id, with the field named", async () => {
    const expenseId = await createDraft();

    const response = await call("post", `/v1/expenses/${expenseId}/publish`, {
      userId: ADMIN,
      idempotencyKey: KEY,
      body: { expectedVersion: 1 },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("x-society-id");
  });

  it("answers 404 — not 403 — for a society the caller is not in", async () => {
    const expenseId = await createDraft();

    const response = await publish(expenseId, { userId: OUTSIDER });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("refuses a pending membership with MEMBER_INACTIVE", async () => {
    const expenseId = await createDraft();

    const response = await publish(expenseId, { userId: PENDING });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("MEMBER_INACTIVE");
  });
});

describe("the Idempotency-Key header", () => {
  it("refuses an absent key — publishing is a money-moving POST", async () => {
    const expenseId = await createDraft();

    const response = await publish(expenseId, { idempotencyKey: null });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("idempotency-key");
    expect(splits.state.splits.size).toBe(0);
  });

  it("refuses a key shorter than the bound", async () => {
    const expenseId = await createDraft();

    const response = await publish(expenseId, { idempotencyKey: "short" });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("idempotency-key");
    expect(splits.state.splits.size).toBe(0);
  });

  it("refuses a key longer than the bound", async () => {
    const expenseId = await createDraft();

    const response = await publish(expenseId, {
      idempotencyKey: "k".repeat(129),
    });

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("idempotency-key");
  });

  it("accepts a key at the minimum length", async () => {
    const expenseId = await createDraft();

    const response = await publish(expenseId, { idempotencyKey: "12345678" });

    expect(response.status).toBe(200);
    expect(response.headers["idempotency-replayed"]).toBeUndefined();
  });
});

describe("POST /v1/expenses/:expenseId/publish — the happy path", () => {
  it("publishes a draft and reports the summary measured over the persisted rows", async () => {
    const expenseId = await createDraft({ amountPaise: 90_000 });

    const response = await publish(expenseId);

    expect(response.status).toBe(200);
    const expense = response.body.data.expense as Record<string, unknown>;
    expect(expense.status).toBe("published");
    expect(expense.id).toBe(expenseId);
    expect(expense.societyId).toBe(SOCIETY_A);
    expect(expense.amountPaise).toBe(90_000);
    expect(expense.publishedAt).not.toBeNull();
    expect(expense.version).toBe(2);

    const summary = response.body.data.splitSummary as Record<string, unknown>;
    expect(summary.participantCount).toBe(4);
    expect(summary.totalPaise).toBe(90_000);
    expect(summary.minPaise).toBe(22_500);
    expect(summary.maxPaise).toBe(22_500);

    // The write went where the read path sees it.
    expect(splits.state.splits.size).toBe(1);
    const persisted = [...splits.state.splits.values()][0]!;
    expect(persisted).toHaveLength(4);
    expect(
      persisted.reduce((sum, allocation) => sum + allocation.amount.paise, 0n),
    ).toBe(90_000n);
  });

  it("answers the published row on a later GET — the transition really happened", async () => {
    const expenseId = await createDraft();
    await publish(expenseId);

    const response = await call("get", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.expense.status).toBe("published");
    expect(response.body.data.expense.publishedAt).not.toBeNull();
  });

  it("snapshots the member name and flat number for each split", async () => {
    const expenseId = await createDraft();
    // The fake's own id helper hashes the label, so the fixture — not a hand-written
    // uuid — is what names the member.
    directory.seedMemberName(memberFixture("m101", "101").id, "Asha Menon");

    await publish(expenseId);

    const persisted = [...splits.state.splits.values()][0]!;
    expect(
      persisted.map((allocation) => allocation.snapshot.apartmentNumber),
    ).toEqual(["101", "102", "103", "104"]);
    const flat101 = persisted.find(
      (allocation) => allocation.snapshot.apartmentNumber === "101",
    );
    expect(flat101?.snapshot.memberName).toBe("Asha Menon");
    expect(
      persisted.every((allocation) => allocation.snapshot.memberName !== ""),
    ).toBe(true);
  });

  it("lets a Treasurer publish", async () => {
    const expenseId = await createDraft({}, { userId: TREASURER });

    const response = await publish(expenseId, { userId: TREASURER });

    expect(response.status).toBe(200);
    expect(response.body.data.expense.status).toBe("published");
  });

  it("publishes a pending_approval expense — T070 narrows this later", async () => {
    const expenseId = await createDraft({ amountPaise: 2_000_000 });

    const read = await call("get", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(read.body.data.expense.status).toBe("pending_approval");

    const response = await publish(expenseId, {
      body: { expectedVersion: 1 },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.expense.status).toBe("published");
  });

  it("conserves the amount for a per-sqft split, hand-calculated", async () => {
    const expenseId = await createDraft({
      amountPaise: 60_000,
      splitStrategy: "apartment",
      apartmentBasis: "per_sqft_carpet",
    });

    const response = await publish(expenseId);

    expect(response.status).toBe(200);
    const summary = response.body.data.splitSummary as Record<string, unknown>;
    expect(summary.totalPaise).toBe(60_000);
    expect(summary.participantCount).toBe(4);

    // 700/350/350/350 sqft (1,750 total) over 60,000 paise: 24,000/12,000/12,000/
    // 12,000 — and the four amounts sum to the bill exactly.
    const persisted = [...splits.state.splits.values()][0]!;
    expect(persisted.map((allocation) => allocation.amount.paise)).toEqual([
      24_000n,
      12_000n,
      12_000n,
      12_000n,
    ]);
    expect(
      persisted.reduce((sum, allocation) => sum + allocation.amount.paise, 0n),
    ).toBe(60_000n);
  });

  it("matches the preview's own allocations for identical input", async () => {
    const expenseId = await createDraft({ amountPaise: 10_000 });

    const preview = await call("post", "/v1/expenses/preview-split", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { amountPaise: 10_000, participantSelector: {} },
    });
    expect(preview.status).toBe(200);

    const published = await publish(expenseId);
    expect(published.status).toBe(200);

    type FlatAmount = [string, number];
    const byNumber = (left: FlatAmount, right: FlatAmount): number =>
      left[0] < right[0] ? -1 : 1;

    const previewAmounts = (
      preview.body.data.allocations as {
        apartmentNumber: string;
        amountPaise: number;
      }[]
    )
      .map((allocation): FlatAmount => [
        allocation.apartmentNumber,
        allocation.amountPaise,
      ])
      .sort(byNumber);
    const persisted = [...splits.state.splits.values()][0]!;
    const publishedAmounts = persisted
      .map((allocation): FlatAmount => [
        allocation.snapshot.apartmentNumber,
        Number(allocation.amount.paise),
      ])
      .sort(byNumber);

    expect(publishedAmounts).toEqual(previewAmounts);
  });
});

describe("POST /v1/expenses/:expenseId/publish — refusals", () => {
  it("refuses a Committee Member — draft-only is not publishing", async () => {
    const expenseId = await createDraft({}, { userId: COMMITTEE });

    const response = await publish(expenseId, { userId: COMMITTEE });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(splits.state.splits.size).toBe(0);
  });

  it("refuses a Resident", async () => {
    const expenseId = await createDraft();

    const response = await publish(expenseId, { userId: RESIDENT });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("refuses a Guest", async () => {
    const expenseId = await createDraft();

    const response = await publish(expenseId, { userId: GUEST });

    expect(response.status).toBe(403);
  });

  it("answers 404 for an absent expense", async () => {
    const response = await publish("2f000000-0000-4000-8000-0000000000ff");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("answers 404 for another society's expense", async () => {
    const expenseId = await createDraft();
    // Move the stored row to the other tenant: addressed under SOCIETY_A it must be
    // structurally invisible.
    const stored = [...expenses.state.records.values()][0]!;
    expenses.seed({ ...stored, societyId: SOCIETY_B });

    const response = await publish(expenseId);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(splits.state.splits.size).toBe(0);
  });

  it("refuses a non-uuid id at the boundary", async () => {
    const response = await publish("not-a-uuid");

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a stale expectedVersion with the SAD §7.11 detail", async () => {
    const expenseId = await createDraft();
    await call("patch", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { expectedVersion: 1, title: "Edited first" },
    });

    const response = await publish(expenseId, { body: { expectedVersion: 1 } });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("VERSION_MISMATCH");
    expect(response.body.error.details[0]).toMatchObject({
      field: "expectedVersion",
      code: "STALE",
      received: 1,
      current: 2,
    });
    expect(splits.state.splits.size).toBe(0);
  });

  it("publishes the current version after the caller reloads", async () => {
    const expenseId = await createDraft();
    await call("patch", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { expectedVersion: 1, title: "Edited first" },
    });

    const response = await publish(expenseId, { body: { expectedVersion: 2 } });

    expect(response.status).toBe(200);
    expect(response.body.data.expense.version).toBe(3);
  });

  it("refuses a second publish of the same expense with INVALID_TRANSITION", async () => {
    const expenseId = await createDraft();
    await publish(expenseId);

    const response = await publish(expenseId, {
      body: { expectedVersion: 2 },
      idempotencyKey: "publish-key-0002",
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVALID_TRANSITION");
  });

  it("refuses a void expense", async () => {
    const expenseId = await createDraft();
    const stored = [...expenses.state.records.values()][0]!;
    expenses.seed({
      ...stored,
      status: "void",
      voidedAt: "2026-10-01T00:00:00.000Z",
      voidReason: "Duplicate of last month's bill",
    });

    const response = await publish(expenseId);

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVALID_TRANSITION");
  });

  it("refuses a body without expectedVersion as syntactic", async () => {
    const expenseId = await createDraft();

    const response = await publish(expenseId, { body: {} });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a client-supplied field rather than ignoring it", async () => {
    const expenseId = await createDraft();

    const response = await publish(expenseId, {
      body: { expectedVersion: 1, status: "published" },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a zero expectedVersion", async () => {
    const expenseId = await createDraft();

    const response = await publish(expenseId, { body: { expectedVersion: 0 } });

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("expectedVersion");
  });

  it("fails closed while a billable flat has nobody to charge", async () => {
    const expenseId = await createDraft();
    // Flat 104 is billable and vacant, and nobody is linked to it.
    directory.seedDirectory(SOCIETY_A, {
      apartments: [
        apartmentFixture("101"),
        apartmentFixture("102"),
        apartmentFixture("103", { occupancyStatus: "rented" }),
        apartmentFixture("104"),
      ],
      members: [
        memberFixture("m101", "101"),
        memberFixture("m102", "102"),
        memberFixture("t103", "103", { occupancy: "tenant" }),
      ],
    });

    const response = await publish(expenseId);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("participantSelector");
    expect(response.body.error.details).toHaveLength(1);
    expect(response.body.error.details[0]).toMatchObject({
      code: "UNASSIGNED_PARTICIPANTS",
    });
    // Nothing was written and the row is still a draft.
    expect(splits.state.splits.size).toBe(0);
    const read = await call("get", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(read.body.data.expense.status).toBe("draft");
  });

  it("succeeds once the flagged flat is excluded from the selector", async () => {
    // The same broken world as the refusal above, with flat 104 named as excluded.
    const expenseId = await createDraft({
      participantSelector: { excludeApartments: [id("104")] },
    });
    directory.seedDirectory(SOCIETY_A, {
      apartments: [
        apartmentFixture("101"),
        apartmentFixture("102"),
        apartmentFixture("103", { occupancyStatus: "rented" }),
        apartmentFixture("104"),
      ],
      members: [
        memberFixture("m101", "101"),
        memberFixture("m102", "102"),
        memberFixture("t103", "103", { occupancy: "tenant" }),
      ],
    });

    const response = await publish(expenseId);

    expect(response.status).toBe(200);
    expect(response.body.data.splitSummary.participantCount).toBe(3);
  });
});

describe("idempotency over HTTP — SAD §7.7", () => {
  it("replays the stored response with Idempotency-Replayed: true", async () => {
    const expenseId = await createDraft();

    const first = await publish(expenseId);
    const second = await publish(expenseId);

    expect(first.status).toBe(200);
    expect(first.headers["idempotency-replayed"]).toBeUndefined();

    expect(second.status).toBe(200);
    expect(second.headers["idempotency-replayed"]).toBe("true");
    // Byte-identical `data` — the replay returns what was stored — and no second
    // write. `meta` is deliberately excluded: the request id and timestamp describe
    // *this* request, which is the envelope's job, not the stored body's.
    expect(second.body.data).toEqual(first.body.data);
    expect(
      splits.state.calls.filter((call) => call === "publish"),
    ).toHaveLength(1);
  });

  it("refuses a key reused for a different request with 409", async () => {
    const expenseId = await createDraft();
    await publish(expenseId, { body: { expectedVersion: 1 } });

    const response = await publish(expenseId, {
      body: { expectedVersion: 2 },
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("IDEMPOTENCY_KEY_REUSE");
    expect(response.body.error.field).toBe("idempotency-key");
  });

  it("answers a replay even though the roster has since broken", async () => {
    const expenseId = await createDraft();
    await publish(expenseId);
    directory.seedDirectory(SOCIETY_A, { apartments: [], members: [] });

    const replay = await publish(expenseId);

    expect(replay.status).toBe(200);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
  });

  it("keeps a separate key for a separate expense", async () => {
    const first = await createDraft({ title: "First" });
    const second = await createDraft({ title: "Second" });

    const one = await publish(first, { idempotencyKey: "expense-key-0001" });
    const two = await publish(second, { idempotencyKey: "expense-key-0002" });

    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(two.headers["idempotency-replayed"]).toBeUndefined();
    expect(splits.state.splits.size).toBe(2);
  });

  it("records nothing when the write fails, so the key is reusable", async () => {
    const expenseId = await createDraft();
    splits.failNextPublish(new Error("the transaction died"));

    const failed = await publish(expenseId);

    expect(failed.status).toBe(500);
    expect(splits.state.records.size).toBe(0);
    expect(splits.state.splits.size).toBe(0);

    const retry = await publish(expenseId);

    expect(retry.status).toBe(200);
    expect(retry.headers["idempotency-replayed"]).toBeUndefined();
    expect(retry.body.data.expense.status).toBe("published");
  });
});

describe("domain events — SAD §3.2", () => {
  it("dispatches expense.published once, after the bill committed", async () => {
    const expenseId = await createDraft();
    let statusAtDispatch: string | undefined;
    let splitsAtDispatch = -1;
    events.onDispatch = () => {
      statusAtDispatch = expenses.state.records.get(
        [...expenses.state.records.keys()][0]!,
      )?.status;
      splitsAtDispatch = splits.state.splits.size;
    };

    await publish(expenseId);

    expect(statusAtDispatch).toBe("published");
    expect(splitsAtDispatch).toBe(1);
    expect(events.dispatched).toHaveLength(1);
    expect(events.dispatched[0]?.[0]).toMatchObject({
      name: "expense.published",
      societyId: SOCIETY_A,
    });
  });

  it("announces nothing on a replay", async () => {
    const expenseId = await createDraft();

    await publish(expenseId);
    await publish(expenseId);

    expect(events.dispatched).toHaveLength(1);
  });

  it("announces nothing for a refused publish", async () => {
    const expenseId = await createDraft();

    await publish(expenseId, { userId: COMMITTEE });

    expect(events.dispatched).toEqual([]);
  });

  it("still answers 200 when the notification fails", async () => {
    const expenseId = await createDraft();
    events.failNextDispatch(new Error("push service is down"));

    const response = await publish(expenseId);

    expect(response.status).toBe(200);
    expect(response.body.data.expense.status).toBe("published");
    const read = await call("get", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(read.body.data.expense.status).toBe("published");
  });
});
