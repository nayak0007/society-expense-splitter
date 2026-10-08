import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  DEFAULT_SOCIETY_SETTINGS,
  asApartmentId,
  asExpenseId,
  asMemberId,
  asSocietyId,
  asUserId,
} from "@ses/domain";
import { Money as MoneyValue, paise as asPaise } from "@ses/domain";
import type {
  ExpenseId,
  ExpenseSplitRecord,
  ExpenseSplitsReader,
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
import { createFakeSocietyRepository } from "./utils/fake-society-repository";
import { id } from "./utils/fake-participant-directory";
import { createTestAuth, type TestAuth } from "./utils/supabase-auth";
import { createTestApp } from "./utils/test-app";

/**
 * The expense draft lifecycle over real HTTP — Roadmap T065.
 *
 * ## What runs for real
 *
 * The whole guard chain (a real signature over a locally held key pair, `X-Society-Id`
 * resolved to a membership, the matrix asked), the Zod pipes parsing the real
 * contracts, the five use cases and the domain's own rules — `Expense.create()`'s
 * title/date/money validation, the lifecycle machine, the canonical participant
 * selector, the threshold policy. Only storage is faked (the category store, the
 * expense store and the society whose settings the threshold reads), which is the
 * same boundary the T064 preview suite draws: a fake here still fails when a rule
 * regresses.
 *
 * ## What only the integration suite can prove
 *
 * Real SQL: the atomic `WHERE version = expectedVersion`, RLS's row visibility, the
 * `expense_draft_delete` definer function, and the absence of split/dues rows after a
 * draft write. This file pins the HTTP surface — the acceptance criteria's matrix, the
 * statuses, the error codes and the contract shape — over fakes that mirror the ports.
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
 * Not `id(\`membership-${actor}\`)`: that helper keys on the label's first six characters,
 * and every label starting `membership-` collapses to one uuid — which would make the
 * resource narrowing in `canOnResource` believe every caller owned every draft. The
 * actor's own last twelve digits are unique, so the fixture keeps them.
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

const ADMIN_MEMBERSHIP = membershipOf(ADMIN, "admin");
const TREASURER_MEMBERSHIP = membershipOf(TREASURER, "treasurer");
const COMMITTEE_MEMBERSHIP = membershipOf(COMMITTEE, "committee_member");
const RESIDENT_MEMBERSHIP = membershipOf(RESIDENT, "resident");
const GUEST_MEMBERSHIP = membershipOf(GUEST, "guest");

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

/**
 * The current-splits read, in memory — T073's route.
 *
 * A fake of the *read* port only: the route under test is the split-table read, and the
 * real adapter's exact-bigint crossing and RLS posture are the integration suite's to
 * prove. Rows are seeded per expense id, so a suite can assert what the route returns
 * without publishing anything.
 */
class FakeSplitsReader implements ExpenseSplitsReader {
  readonly rows = new Map<string, ExpenseSplitRecord[]>();

  seed(expenseId: string, rows: ExpenseSplitRecord[]): void {
    this.rows.set(expenseId, rows);
  }

  listForExpense(
    expenseId: ExpenseId,
    societyId: SocietyId,
  ): Promise<readonly ExpenseSplitRecord[]> {
    // Only this society's rows are addressable — the same visibility the real read has.
    if (societyId !== SOCIETY_A) return Promise.resolve([]);
    return Promise.resolve(this.rows.get(expenseId) ?? []);
  }
}

let app: NestFastifyApplication;
let auth: TestAuth;
let categories: FakeCategoryRepository;
let expenses: FakeExpenseRepository;
let splitsReader: FakeSplitsReader;
let categoryId: string;
let foreignCategoryId: string;

beforeAll(async () => {
  auth = await createTestAuth();
  categories = createFakeCategoryRepository();
  expenses = createFakeExpenseRepository();
  // The threshold read borrows the society repository structurally
  // (`EXPENSE_APPROVAL_POLICY_READER`), so the one fake answers both the settings
  // and the tenancy check the read performs.
  const societyRepository = createFakeSocietyRepository({
    societies: [...societies.values()],
    memberships: [
      ADMIN_MEMBERSHIP,
      TREASURER_MEMBERSHIP,
      COMMITTEE_MEMBERSHIP,
      RESIDENT_MEMBERSHIP,
      GUEST_MEMBERSHIP,
    ],
  });
  splitsReader = new FakeSplitsReader();
  app = await createTestApp({
    jwks: auth.jwks,
    reader,
    membershipReader,
    categories,
    repository: societyRepository,
    expenses,
    splitsReader,
  });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  memberships.clear();
  memberships.set(key(SOCIETY_A, ADMIN), ADMIN_MEMBERSHIP);
  memberships.set(key(SOCIETY_A, TREASURER), TREASURER_MEMBERSHIP);
  memberships.set(key(SOCIETY_A, COMMITTEE), COMMITTEE_MEMBERSHIP);
  memberships.set(key(SOCIETY_A, RESIDENT), RESIDENT_MEMBERSHIP);
  memberships.set(key(SOCIETY_A, GUEST), GUEST_MEMBERSHIP);
  memberships.set(
    key(SOCIETY_A, PENDING),
    membershipOf(PENDING, "resident", "pending"),
  );

  categories.state.categories.clear();
  categories.state.calls.length = 0;
  // Two literal ids rather than `id(label)`: that helper keys on the label's first
  // six characters, so `id("category-palm")` and `id("category-lift")` would be the
  // same uuid and the second seed would overwrite the first.
  categoryId = categories.seed(SOCIETY_A, {
    id: "0a000000-0000-4000-8000-000000000001",
    name: "Lift AMC",
  }).id;
  foreignCategoryId = categories.seed(SOCIETY_B, {
    id: "0b000000-0000-4000-8000-000000000002",
    name: "Palm Lift",
  }).id;

  expenses.state.records.clear();
  expenses.state.calls.length = 0;
  splitsReader.rows.clear();
});

const server = () => request(app.getHttpServer());

async function call(
  method: "get" | "post" | "patch" | "delete",
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

/** `POST /v1/expenses` as an authenticated member of SOCIETY_A. */
function create(
  body: unknown,
  options: {
    readonly userId?: UserId;
    readonly societyId?: string | null;
  } = {},
) {
  return call("post", "/v1/expenses", {
    userId: options.userId ?? ADMIN,
    societyId: options.societyId === undefined ? SOCIETY_A : options.societyId,
    body,
  });
}

const draftBody = (overrides: Record<string, unknown> = {}) => ({
  title: "Lift AMC — Q3",
  amountPaise: 450_000,
  expenseDate: "2026-09-30",
  categoryId,
  ...overrides,
});

/** Creates a draft and returns its id — the fixture every later assertion needs. */
async function createDraft(
  overrides: Record<string, unknown> = {},
  options: { readonly userId?: UserId } = {},
): Promise<string> {
  const response = await create(draftBody(overrides), options);
  expect(response.status).toBe(201);
  return response.body.data.expense.id as string;
}

describe("authentication and the society header", () => {
  it("requires a session before anything else", async () => {
    const response = await call("post", "/v1/expenses", {
      societyId: SOCIETY_A,
      body: draftBody(),
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("requires X-Society-Id, with the field named", async () => {
    const response = await call("post", "/v1/expenses", {
      userId: ADMIN,
      body: draftBody(),
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("x-society-id");
  });

  it("answers 404 — not 403 — for a society the caller is not in", async () => {
    const response = await create(draftBody(), { userId: OUTSIDER });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("refuses a pending membership with MEMBER_INACTIVE", async () => {
    const response = await create(draftBody(), { userId: PENDING });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("MEMBER_INACTIVE");
  });
});

describe("POST /v1/expenses — create", () => {
  it("creates a draft with the server's own defaults, and nothing published", async () => {
    const response = await create(draftBody());

    expect(response.status).toBe(201);
    const expense = response.body.data.expense as Record<string, unknown>;
    expect(expense.status).toBe("draft");
    expect(expense.version).toBe(1);
    expect(expense.createdBy).toBe(membershipIdOf(ADMIN));
    expect(expense.societyId).toBe(SOCIETY_A);
    expect(expense.title).toBe("Lift AMC — Q3");
    expect(expense.amountPaise).toBe(450_000);
    expect(expense.expenseDate).toBe("2026-09-30");
    expect(expense.categoryId).toBe(categoryId);
    expect(expense.paymentSource).toBe("society_account");
    expect(expense.paidByMemberId).toBeNull();
    expect(expense.description).toBeNull();
    expect(expense.vendorName).toBeNull();
    expect(expense.splitStrategy).toBe("equal");
    expect(expense.apartmentBasis).toBeNull();
    expect(expense.publishedAt).toBeNull();
    expect(expense.voidedAt).toBeNull();
  });

  it("promotes an Admin's above-threshold expense into pending_approval", async () => {
    const response = await create(draftBody({ amountPaise: 1_000_001 }));

    expect(response.status).toBe(201);
    expect(response.body.data.expense.status).toBe("pending_approval");
    expect(response.body.data.expense.publishedAt).toBeNull();
  });

  it("keeps an Admin's expense one paisa below the threshold a draft", async () => {
    const response = await create(draftBody({ amountPaise: 999_999 }));

    expect(response.status).toBe(201);
    expect(response.body.data.expense.status).toBe("draft");
  });

  it("routes an Admin's expense at exactly the threshold into pending_approval — `>=`, not the old `>`", async () => {
    const response = await create(draftBody({ amountPaise: 1_000_000 }));

    expect(response.status).toBe(201);
    expect(response.body.data.expense.status).toBe("pending_approval");
  });

  it("routes a Committee Member's above-threshold expense into pending_approval — the deadlock fix", async () => {
    const response = await create(draftBody({ amountPaise: 5_000_000 }), {
      userId: COMMITTEE,
    });

    // T070: the threshold alone decides, so an otherwise-authorized draft creator
    // can submit their own expense for approval instead of being stranded with a
    // draft they cannot promote (ADR-0011, the Committee submission deadlock).
    expect(response.status).toBe(201);
    expect(response.body.data.expense.status).toBe("pending_approval");
    expect(response.body.data.expense.createdBy).toBe(
      membershipIdOf(COMMITTEE),
    );
  });

  it("lets a Treasurer create", async () => {
    const response = await create(draftBody(), { userId: TREASURER });

    expect(response.status).toBe(201);
    expect(response.body.data.expense.createdBy).toBe(
      membershipIdOf(TREASURER),
    );
  });

  it("refuses a Resident — composing an expense is staff work", async () => {
    const response = await create(draftBody(), { userId: RESIDENT });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("refuses a Guest", async () => {
    const response = await create(draftBody(), { userId: GUEST });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("refuses a client-supplied status rather than ignoring it", async () => {
    const response = await create(draftBody({ status: "published" }));

    // Syntactic: an unknown key is a shape the contract does not have — 400, not 422.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a client-supplied createdBy", async () => {
    const response = await create(
      draftBody({ createdBy: membershipIdOf(ADMIN) }),
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a zero amount with the field named", async () => {
    const response = await create(draftBody({ amountPaise: 0 }));

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("amountPaise");
  });

  it("refuses a blank title with the field named", async () => {
    const response = await create(draftBody({ title: "   " }));

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("title");
  });

  it("refuses a far-future expense date — the domain's own rule", async () => {
    const response = await create(draftBody({ expenseDate: "2026-12-31" }));

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("expenseDate");
  });

  it("answers not_found for a category of another society", async () => {
    const response = await create(draftBody({ categoryId: foreignCategoryId }));

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("answers not_found for an absent category", async () => {
    const response = await create(
      draftBody({ categoryId: id("category-missing") }),
    );

    expect(response.status).toBe(404);
  });

  it("refuses an apartment strategy with no basis anywhere, naming the field", async () => {
    const response = await create(draftBody({ splitStrategy: "apartment" }));

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("apartmentBasis");
  });

  it("declares a result to the store only after every rule has passed", async () => {
    await create(draftBody({ amountPaise: 0 }));

    expect(expenses.state.records.size).toBe(0);
    expect(expenses.state.calls).not.toContain("create");
  });
});

describe("GET /v1/expenses/:expenseId — read", () => {
  it("returns the stored expense to any member, draft or not", async () => {
    const expenseId = await createDraft();

    const response = await call("get", `/v1/expenses/${expenseId}`, {
      userId: RESIDENT,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.expense.id).toBe(expenseId);
    expect(response.body.data.expense.status).toBe("draft");
  });

  it("refuses a Guest — expense.view is not theirs", async () => {
    const expenseId = await createDraft();

    const response = await call("get", `/v1/expenses/${expenseId}`, {
      userId: GUEST,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("answers 404 for an absent id", async () => {
    const response = await call("get", `/v1/expenses/${id("no-expense")}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("answers 404 — not 403 — for another society's expense", async () => {
    const expenseId = await createDraft();
    // Move the stored row to the other tenant: addressed under SOCIETY_A it must
    // be structurally invisible.
    const stored = [...expenses.state.records.values()][0]!;
    expenses.seed({ ...stored, societyId: SOCIETY_B });

    const response = await call("get", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(404);
  });

  it("refuses a non-uuid id at the boundary rather than querying with it", async () => {
    const response = await call("get", "/v1/expenses/not-a-uuid", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("PATCH /v1/expenses/:expenseId — edit", () => {
  it("applies a patch and bumps the version", async () => {
    const expenseId = await createDraft();

    const response = await call("patch", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { expectedVersion: 1, title: "Lift AMC — revised" },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.expense.title).toBe("Lift AMC — revised");
    expect(response.body.data.expense.version).toBe(2);
    expect(response.body.data.expense.createdBy).toBe(membershipIdOf(ADMIN));
  });

  it("does not read a category for a title-only edit", async () => {
    const expenseId = await createDraft();
    categories.state.calls.length = 0;

    await call("patch", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { expectedVersion: 1, title: "Lift AMC — revised" },
    });

    expect(categories.state.calls).not.toContain("findCategory");
  });

  it("clears a nullable field sent as null", async () => {
    const expenseId = await createDraft({ description: "Covers Oct" });

    const response = await call("patch", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { expectedVersion: 1, description: null },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.expense.description).toBeNull();
  });

  it("answers 409 VERSION_MISMATCH with the current version, in the SAD §7.11 shape", async () => {
    const expenseId = await createDraft();
    await call("patch", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { expectedVersion: 1, title: "First" },
    });

    const response = await call("patch", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { expectedVersion: 1, title: "Second" },
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("VERSION_MISMATCH");
    expect(response.body.error.details[0]).toMatchObject({
      field: "expectedVersion",
      code: "STALE",
      received: 1,
      current: 2,
    });
  });

  // A published expense's `PATCH` is **no longer** refused here: since T068 it is the
  // recalculation door (200 with `{ expense, recalculation }`), and it is pinned in
  // `expense-revision.e2e-spec.ts` — the suite that owns the published write, the
  // revision it appends and the history route that reads it.

  it("lets a Committee Member edit their own draft", async () => {
    const expenseId = await createDraft({}, { userId: COMMITTEE });

    const response = await call("patch", `/v1/expenses/${expenseId}`, {
      userId: COMMITTEE,
      societyId: SOCIETY_A,
      body: { expectedVersion: 1, title: "Committee revision" },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.expense.version).toBe(2);
  });

  it("refuses a Committee Member another member's draft", async () => {
    const expenseId = await createDraft({}, { userId: ADMIN });

    const response = await call("patch", `/v1/expenses/${expenseId}`, {
      userId: COMMITTEE,
      societyId: SOCIETY_A,
      body: { expectedVersion: 1, title: "Not mine" },
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("requires expectedVersion", async () => {
    const expenseId = await createDraft();

    const response = await call("patch", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { title: "No lock" },
    });

    // A missing required key is syntactic — 400 — like every other shape failure.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a patch that carries nothing but the version", async () => {
    const expenseId = await createDraft();

    const response = await call("patch", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { expectedVersion: 1 },
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a Resident", async () => {
    const expenseId = await createDraft();

    const response = await call("patch", `/v1/expenses/${expenseId}`, {
      userId: RESIDENT,
      societyId: SOCIETY_A,
      body: { expectedVersion: 1, title: "Nope" },
    });

    expect(response.status).toBe(403);
  });
});

describe("DELETE /v1/expenses/:expenseId — hard delete", () => {
  it("lets the creator delete their draft, and the row is gone", async () => {
    const expenseId = await createDraft();

    const deleted = await call("delete", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(deleted.status).toBe(204);
    expect(deleted.body).toEqual({});

    const read = await call("get", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(read.status).toBe(404);
  });

  it("refuses an Admin somebody else's draft — creator only", async () => {
    const expenseId = await createDraft({}, { userId: COMMITTEE });

    const response = await call("delete", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(expenses.state.records.has(asExpenseId(expenseId))).toBe(true);
  });

  it("refuses a published expense — its door is voiding", async () => {
    const expenseId = await createDraft();
    const stored = [...expenses.state.records.values()][0]!;
    expenses.seed({
      ...stored,
      status: "published",
      publishedAt: "2026-10-01T00:00:00.000Z",
    });

    const response = await call("delete", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVALID_TRANSITION");
  });

  it("answers 404 on a second delete", async () => {
    const expenseId = await createDraft();
    await call("delete", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    const response = await call("delete", `/v1/expenses/${expenseId}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(404);
  });

  it("refuses a Resident", async () => {
    const expenseId = await createDraft();

    const response = await call("delete", `/v1/expenses/${expenseId}`, {
      userId: RESIDENT,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
  });
});

describe("GET /v1/expenses — list", () => {
  it("lists the society's expenses newest first", async () => {
    await createDraft({ title: "Older", expenseDate: "2026-09-01" });
    await createDraft({ title: "Newer", expenseDate: "2026-09-20" });

    const response = await call("get", "/v1/expenses", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    const titles = (response.body.data.expenses as { title: string }[]).map(
      (expense) => expense.title,
    );
    expect(titles).toEqual(["Newer", "Older"]);
    expect(response.body.data.hasMore).toBe(false);
    expect(response.body.data.nextCursor).toBeNull();
  });

  it("applies the status filter", async () => {
    await createDraft({ title: "Draft one" });
    await createDraft({ title: "Waiting", amountPaise: 2_000_000 });

    const response = await call("get", "/v1/expenses?status=pending_approval", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.expenses).toHaveLength(1);
    expect(response.body.data.expenses[0].title).toBe("Waiting");
  });

  it("refuses a filter the schema does not have rather than ignoring it", async () => {
    // `buildingId` became a supported filter in T073, so the example of an
    // unsupported one is now `hasAttachments` (a join the schema still does not have).
    const response = await call("get", "/v1/expenses?hasAttachments=true", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("accepts the buildingId filter T073 added", async () => {
    const response = await call("get", `/v1/expenses?buildingId=${id("b1")}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data.expenses)).toBe(true);
  });

  it("refuses a malformed cursor rather than starting over", async () => {
    const response = await call("get", "/v1/expenses?cursor=not-a-cursor", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("cursor");
  });

  it("paginates with the opaque cursor without repeating a row", async () => {
    await createDraft({ title: "First", expenseDate: "2026-09-20" });
    await createDraft({ title: "Second", expenseDate: "2026-09-10" });

    const first = await call("get", "/v1/expenses?limit=1", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(first.status).toBe(200);
    expect(first.body.data.expenses[0].title).toBe("First");
    expect(first.body.data.hasMore).toBe(true);

    const cursor = first.body.data.nextCursor as string;
    const second = await call(
      "get",
      `/v1/expenses?limit=1&cursor=${encodeURIComponent(cursor)}`,
      { userId: ADMIN, societyId: SOCIETY_A },
    );
    expect(second.status).toBe(200);
    expect(second.body.data.expenses[0].title).toBe("Second");
    expect(second.body.data.hasMore).toBe(false);
  });

  it("lets a Resident read the ledger — expense.view is green for them", async () => {
    await createDraft();

    const response = await call("get", "/v1/expenses", {
      userId: RESIDENT,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
  });

  it("refuses a Guest", async () => {
    const response = await call("get", "/v1/expenses", {
      userId: GUEST,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T073's current-splits read
// ─────────────────────────────────────────────────────────────────────────────

/** One stored split row, for the read route. */
function splitRow(
  index: number,
  amountPaise: bigint,
  overrides: Partial<ExpenseSplitRecord> = {},
): ExpenseSplitRecord {
  return {
    id: `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    expenseId: asExpenseId(EXPENSE_PLACEHOLDER),
    memberId: asMemberId(
      `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ),
    apartmentId: asApartmentId(
      `60000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    ),
    amount: MoneyValue.fromPaise(asPaise(amountPaise)),
    weight: "1.0000",
    percent: null,
    assignedReason: null,
    snapshot: {
      memberName: `Member ${index}`,
      apartmentNumber: `A-10${index}`,
    },
    createdAt: `2026-10-07T09:0${index}:00.000Z`,
    ...overrides,
  };
}

const EXPENSE_PLACEHOLDER = "00000000-0000-4000-8000-000000000000";

/** The split route, with a session and the society header actually set. */
function getSplits(
  expenseId: string,
  options: { readonly userId?: UserId } = {},
) {
  return call("get", `/v1/expenses/${expenseId}/splits`, {
    userId: options.userId ?? ADMIN,
    societyId: SOCIETY_A,
  });
}

describe("GET /v1/expenses/:expenseId/splits", () => {
  it("requires a session before anything else", async () => {
    const response = await call(
      "get",
      `/v1/expenses/${EXPENSE_PLACEHOLDER}/splits`,
      {
        societyId: SOCIETY_A,
      },
    );
    expect(response.status).toBe(401);
  });

  it("answers an empty table for a draft that has not been allocated", async () => {
    const expenseId = await createDraft();

    const response = await getSplits(expenseId);

    expect(response.status).toBe(200);
    expect(response.body.data.splits).toEqual([]);
  });

  it("returns the persisted splits oldest first, money as integer paise", async () => {
    const expenseId = await createDraft();
    splitsReader.seed(expenseId, [
      splitRow(1, 250_000n),
      splitRow(2, 200_000n),
    ]);

    const response = await getSplits(expenseId);

    expect(response.status).toBe(200);
    const splits = response.body.data.splits as {
      amountPaise: number;
      weight: string | null;
      snapshot: { memberName: string | null };
    }[];
    expect(splits).toHaveLength(2);
    expect(splits[0]?.amountPaise).toBe(250_000);
    expect(splits[1]?.amountPaise).toBe(200_000);
    // The conservation the split table exists for, asserted on the wire's own numbers.
    expect(splits.reduce((total, row) => total + row.amountPaise, 0)).toBe(
      450_000,
    );
    expect(splits[0]?.weight).toBe("1.0000");
    expect(splits[0]?.snapshot.memberName).toBe("Member 1");
  });

  it("lets a Resident read the split table — expense.view is green for them", async () => {
    const expenseId = await createDraft();
    const response = await getSplits(expenseId, { userId: RESIDENT });
    expect(response.status).toBe(200);
  });

  it("refuses a Guest", async () => {
    const expenseId = await createDraft();
    const response = await getSplits(expenseId, { userId: GUEST });
    expect(response.status).toBe(403);
  });

  it("answers 404 for an unknown expense id", async () => {
    const response = await getSplits(EXPENSE_PLACEHOLDER);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("refuses a path parameter that is not a UUID before any query runs", async () => {
    const response = await call("get", "/v1/expenses/not-a-uuid/splits", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("expenseId");
  });
});
