import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  DEFAULT_SOCIETY_SETTINGS,
  asExpenseId,
  asMemberId,
  asSocietyId,
  asUserId,
  expenseError,
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
 * `POST /v1/expenses/:expenseId/void` over real HTTP — Roadmap T069, ADR-0010.
 *
 * ## What runs for real
 *
 * The whole guard chain (a real signature, `X-Society-Id` resolved to a membership,
 * the matrix asked for `expense.void`), the Zod pipe parsing the real contract, the
 * `canOnResource` decision against the stored row, the use case's error mapping, the
 * response mapper and the envelope. Only storage is faked: the expense store, the
 * category store, the participant directory, the split writer and the event
 * publisher — the same boundary the T064–T068 suites draw, so a fake here still
 * fails when a rule regresses.
 *
 * ## What this file pins, and what only Postgres can prove
 *
 * Here: which door a stored status opens, the request and response contracts, the
 * reason rule and its field, the optimistic lock, the terminal second void (never a
 * replay), who may call it, the 404-not-403 tenancy rule, and *when* the domain event
 * leaves — after the commit, and never after a refusal. The due lifecycle, the exact
 * balance deltas, the credit conversion, the fail-closed due states, the write
 * surface and the concurrency behaviour are real SQL: they belong to
 * `expense-void.integration-spec.ts`, which proves them against PostgreSQL 18.
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

const draftBody = (overrides: Record<string, unknown> = {}) => ({
  title: "Lift AMC — Q3",
  amountPaise: 40_000,
  expenseDate: "2026-09-30",
  categoryId,
  ...overrides,
});

let publishKeyCounter = 0;

/**
 * Creates a draft, publishes it, and returns the id — the published fixture.
 *
 * The `Idempotency-Key` is unique per call because the key names a *request*
 * (publish is SAD §7.7's retryable money-moving POST, and the record is keyed by
 * `(user, key)`): a constant key reused for a second, different expense is
 * `IDEMPOTENCY_KEY_REUSE`, which is exactly the behaviour the publishing suite
 * pins and not what this fixture is about.
 */
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

  publishKeyCounter += 1;
  const published = await call("post", `/v1/expenses/${expenseId}/publish`, {
    userId: ADMIN,
    societyId: SOCIETY_A,
    idempotencyKey: `publish-key-void-${String(publishKeyCounter).padStart(4, "0")}`,
    body: { expectedVersion: 1 },
  });
  expect(published.status).toBe(200);
  return expenseId;
}

/** Only the void events — the publish path announces itself too. */
function voidedEvents(): readonly string[] {
  return events.dispatched
    .flatMap((batch) => batch)
    .filter((event) => event.name === "expense.voided")
    .map((event) => event.name);
}

function voidExpense(
  expenseId: string,
  body: unknown,
  options: {
    readonly userId?: UserId;
    readonly societyId?: string | null;
  } = {},
) {
  return call("post", `/v1/expenses/${expenseId}/void`, {
    userId: options.userId ?? ADMIN,
    societyId: options.societyId === undefined ? SOCIETY_A : options.societyId,
    body,
  });
}

const REASON = "Duplicate bill; cancelled by the vendor.";

describe("POST /v1/expenses/:expenseId/void", () => {
  it("voids a published expense and answers the row plus the reversal summary", async () => {
    const expenseId = await publishedExpense();

    const response = await voidExpense(expenseId, {
      expectedVersion: 2,
      reason: REASON,
    });

    expect(response.status).toBe(200);
    const { expense, summary } = response.body.data as {
      expense: Record<string, unknown>;
      summary: Record<string, unknown>;
    };
    expect(expense["status"]).toBe("void");
    expect(expense["voidReason"]).toBe(REASON);
    expect(expense["voidedAt"]).not.toBeNull();
    expect(expense["voidedBy"]).not.toBeNull();
    expect(expense["version"]).toBe(3);
    // The summary's own contract: how many dues were superseded, how much paid money
    // became credit, and how many members moved.
    expect(Object.keys(summary).sort()).toEqual([
      "affectedMembers",
      "creditsIssuedPaise",
      "duesSuperseded",
    ]);
    expect(summary["duesSuperseded"]).toBe(4);
    expect(summary["creditsIssuedPaise"]).toBe(0);
  });

  it("leaves the expense published and announces nothing when the write fails", async () => {
    const expenseId = await publishedExpense();
    splits.failNextVoid(new Error("the transaction could not be committed"));

    const response = await voidExpense(expenseId, {
      expectedVersion: 2,
      reason: REASON,
    });

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL");
    // The bill is untouched, and no `expense.voided` left the process.
    expect(expenses.state.records.get(asExpenseId(expenseId))?.status).toBe(
      "published",
    );
    expect(voidedEvents()).toEqual([]);
  });

  it("dispatches expense.voided for a fresh void only, after the commit", async () => {
    const expenseId = await publishedExpense();
    const statusesAtDispatch: string[] = [];
    events.onDispatch = () => {
      // Read from inside the dispatch: the row the void wrote must already be
      // committed, which is the whole meaning of "after".
      statusesAtDispatch.push(
        expenses.state.records.get(asExpenseId(expenseId))?.status ?? "missing",
      );
    };

    await voidExpense(expenseId, { expectedVersion: 2, reason: REASON });

    expect(statusesAtDispatch).toEqual(["void"]);
    expect(voidedEvents()).toEqual(["expense.voided"]);
  });

  it("answers 409 VERSION_MISMATCH with the row's current version and writes nothing", async () => {
    const expenseId = await publishedExpense();

    const response = await voidExpense(expenseId, {
      expectedVersion: 1,
      reason: REASON,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("VERSION_MISMATCH");
    expect(response.body.error.details[0]).toMatchObject({
      field: "expectedVersion",
      code: "STALE",
      current: 2,
    });
    expect(expenses.state.records.get(asExpenseId(expenseId))?.status).toBe(
      "published",
    );
    expect(voidedEvents()).toEqual([]);
  });

  it("refuses a second void as INVALID_TRANSITION rather than replaying", async () => {
    const expenseId = await publishedExpense();
    const first = await voidExpense(expenseId, {
      expectedVersion: 2,
      reason: REASON,
    });
    expect(first.status).toBe(200);

    const second = await voidExpense(expenseId, {
      expectedVersion: 3,
      reason: REASON,
    });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("INVALID_TRANSITION");
    // A void is terminal: the second attempt is a refusal, and nothing is
    // announced a second time.
    expect(voidedEvents()).toEqual(["expense.voided"]);
  });

  it("refuses a draft with INVALID_TRANSITION — only a published bill is voidable", async () => {
    const created = await call("post", "/v1/expenses", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: draftBody(),
    });
    const expenseId = created.body.data.expense.id as string;

    const response = await voidExpense(expenseId, {
      expectedVersion: 1,
      reason: REASON,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVALID_TRANSITION");
  });

  it("enforces the reason: too short, blank and control characters are 422 VALIDATION_ERROR", async () => {
    const expenseId = await publishedExpense();

    for (const reason of ["Too short", "         ", "Bad\tcharacter here"]) {
      const response = await voidExpense(expenseId, {
        expectedVersion: 2,
        reason,
      });
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }

    // The route never wrote, so the expense is still voidable with a real reason.
    const ok = await voidExpense(expenseId, {
      expectedVersion: 2,
      reason: REASON,
    });
    expect(ok.status).toBe(200);
  });

  it("refuses an unknown body field and a missing reason (strict contract)", async () => {
    const expenseId = await publishedExpense();

    // An unknown key is *syntactic* — the envelope refuses it as a 400 before any
    // rule runs (the same distinction the idempotency header keeps: an absent one is
    // syntactic, an unusable one is a value failure).
    const extra = await voidExpense(expenseId, {
      expectedVersion: 2,
      reason: REASON,
      creditPaise: 12_345,
    });
    expect(extra.status).toBe(400);
    expect(extra.body.error.code).toBe("VALIDATION_ERROR");

    // A missing required key is the same class: the pipe's syntactic set covers
    // `invalid_type` and `unrecognized_keys` alike, so both answer 400 and neither
    // reaches a rule.
    const missing = await voidExpense(expenseId, { expectedVersion: 2 });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("allows a Treasurer and refuses a Committee Member's own published bill", async () => {
    const treasurerExpense = await publishedExpense();
    const allowed = await voidExpense(
      treasurerExpense,
      { expectedVersion: 2, reason: REASON },
      { userId: TREASURER },
    );
    expect(allowed.status).toBe(200);

    const committeeExpense = await publishedExpense();
    const refused = await voidExpense(
      committeeExpense,
      { expectedVersion: 2, reason: REASON },
      { userId: COMMITTEE },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("FORBIDDEN");
  });

  it("refuses Resident and Guest at the guard, before the handler runs", async () => {
    const expenseId = await publishedExpense();

    for (const actor of [RESIDENT, GUEST]) {
      const response = await voidExpense(
        expenseId,
        { expectedVersion: 2, reason: REASON },
        { userId: actor },
      );
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }

    expect(expenses.state.records.get(asExpenseId(expenseId))?.status).toBe(
      "published",
    );
  });

  it("answers 404 for another society's expense and for an unknown id, never 403", async () => {
    const expenseId = await publishedExpense();

    const foreign = await voidExpense(
      expenseId,
      { expectedVersion: 2, reason: REASON },
      { societyId: SOCIETY_B },
    );
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("NOT_FOUND");

    const unknown = await voidExpense("ffffffff-ffff-4fff-8fff-ffffffffffff", {
      expectedVersion: 1,
      reason: REASON,
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("NOT_FOUND");

    const outsider = await voidExpense(
      expenseId,
      { expectedVersion: 2, reason: REASON },
      { userId: OUTSIDER },
    );
    expect(outsider.status).toBe(404);
  });

  it("answers 401 without a token, and 403 without a society header", async () => {
    const expenseId = await publishedExpense();

    const anonymous = await call("post", `/v1/expenses/${expenseId}/void`, {
      body: { expectedVersion: 2, reason: REASON },
    });
    expect(anonymous.status).toBe(401);

    const noSociety = await call("post", `/v1/expenses/${expenseId}/void`, {
      userId: ADMIN,
      societyId: null,
      body: { expectedVersion: 2, reason: REASON },
    });
    expect(noSociety.status).toBe(400);
  });

  it("surfaces a domain refusal from the writer as its own stable code", async () => {
    const expenseId = await publishedExpense();
    // T069's fail-closed due state, as the definer function raises it, classified by
    // `expense.rows.ts` and mapped by the module's error table.
    splits.failNextVoid(
      expenseError(
        "void_due_state_unsupported",
        "This expense has an obligation this app cannot reverse yet. Nothing was changed — resolve the obligation first.",
      ),
    );

    const response = await voidExpense(expenseId, {
      expectedVersion: 2,
      reason: REASON,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
    expect(response.body.error.details[0]).toMatchObject({
      code: "DUE_STATE_UNSUPPORTED",
    });
  });
});
