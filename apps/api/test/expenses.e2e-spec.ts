import { randomUUID } from "node:crypto";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asMemberId, asSocietyId, asUserId } from "@ses/domain";
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
import { createTestAuth, type TestAuth } from "./utils/supabase-auth";
import { createTestApp } from "./utils/test-app";

/**
 * The expense-category routes over real HTTP (Roadmap T062).
 *
 * ## What runs for real
 *
 * The whole guard chain — the global auth guard verifying a real signature against a
 * locally held key pair, `SocietyGuard` resolving `X-Society-Id` to a membership,
 * `PermissionGuard` asking the domain's matrix — plus the Zod pipe parsing the real
 * contract schema, the real use cases, the real mappers, the response envelope and the
 * exception filter.
 *
 * ## What does not
 *
 * Storage and RLS. Two seams are substituted: the category store (no Postgres) and the
 * membership read the *use cases* perform. The second is deliberate rather than
 * convenient — the guard has its own membership read, and pointing them at the same
 * fixture is what lets this suite assert that a refusal comes from the layer it claims to
 * come from. Nothing here evaluates a policy, so a mistake in the committed SQL is
 * invisible; `scripts/db/rls-canary.sql` and the integration suite cover that side.
 *
 * ## The four cases the Roadmap names
 *
 * These routes exist to satisfy T062's acceptance and test list, and each of the four
 * has a describe block below: CRUD happy paths (`create`/`list`/`patch`/`delete`), a
 * deletion blocked by a reference with its own wire code (`delete`), a Resident refused a
 * write (`permissions`), and a duplicate name rejected (`create`, `patch`).
 */

const SOCIETY_A = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const SOCIETY_B = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

const ADMIN: UserId = asUserId("11111111-1111-4111-8111-111111111111");
const TREASURER: UserId = asUserId("22222222-2222-4222-8222-222222222222");
const RESIDENT: UserId = asUserId("33333333-3333-4333-8333-333333333333");
const COMMITTEE: UserId = asUserId("77777777-7777-4777-8777-777777777777");
const GUEST: UserId = asUserId("44444444-4444-4444-8444-444444444444");
const PENDING: UserId = asUserId("55555555-5555-4555-8555-555555555555");
const OUTSIDER: UserId = asUserId("66666666-6666-4666-8666-666666666666");

const societies = new Map<string, Society>([
  [
    SOCIETY_A,
    {
      id: SOCIETY_A,
      name: "Green Meadows",
      city: "Pune",
    } as unknown as Society,
  ],
  [
    SOCIETY_B,
    { id: SOCIETY_B, name: "Palm Grove", city: "Pune" } as unknown as Society,
  ],
]);

function membershipOf(
  actor: UserId,
  role: MemberRole,
  status: MembershipStatus = "active",
): SocietyMembership {
  return {
    id: asMemberId(randomUUID()),
    societyId: SOCIETY_A,
    userId: actor,
    role,
    status,
    occupancyType: "owner",
    joinedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** (society, actor) → membership. One map, read by both seams on purpose. */
const memberships = new Map<string, SocietyMembership>();
const key = (societyId: string, actor: string) => `${societyId}:${actor}`;

const guardReads: string[] = [];

/** The guard's read: one society + one membership, from one lookup. */
const reader = {
  load(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyAuthorizationContext | null> {
    guardReads.push(key(societyId, actor));
    const membership = memberships.get(key(societyId, actor));
    const society = societies.get(societyId);
    if (membership === undefined || society === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ society, membership });
  },
};

/** The use cases' read — the same fixture, so the two gates agree by design. */
const membershipReader: StructureMembershipReader = {
  findMembership(societyId, actor) {
    return Promise.resolve(memberships.get(key(societyId, actor)) ?? null);
  },
};

let app: NestFastifyApplication;
let auth: TestAuth;
let categories: FakeCategoryRepository;

beforeAll(async () => {
  auth = await createTestAuth();
  categories = createFakeCategoryRepository();
  app = await createTestApp({
    jwks: auth.jwks,
    reader,
    membershipReader,
    categories,
  });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  memberships.clear();
  guardReads.length = 0;
  categories.state.categories.clear();
  categories.state.references.clear();
  categories.state.calls.length = 0;

  memberships.set(key(SOCIETY_A, ADMIN), membershipOf(ADMIN, "admin"));
  memberships.set(
    key(SOCIETY_A, TREASURER),
    membershipOf(TREASURER, "treasurer"),
  );
  memberships.set(key(SOCIETY_A, RESIDENT), membershipOf(RESIDENT, "resident"));
  memberships.set(
    key(SOCIETY_A, COMMITTEE),
    membershipOf(COMMITTEE, "committee_member"),
  );
  memberships.set(key(SOCIETY_A, GUEST), membershipOf(GUEST, "guest"));
  memberships.set(
    key(SOCIETY_A, PENDING),
    membershipOf(PENDING, "resident", "pending"),
  );
  // An Admin of the *other* society: sufficient to prove that a society header alone
  // never grants access to a category inside a different one.
  memberships.set(key(SOCIETY_B, ADMIN), {
    ...membershipOf(ADMIN, "admin"),
    societyId: SOCIETY_B,
  });
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
) {
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

/** Creates a category as the Admin, returning the created DTO. */
async function seedViaApi(
  spec: {
    readonly name?: string;
    readonly displayOrder?: number;
    readonly isOwnerOnly?: boolean;
    readonly isCapital?: boolean;
    readonly isActive?: boolean;
    readonly defaultSplitStrategy?: string;
    readonly defaultApartmentBasis?: string;
  } = {},
) {
  const response = await call("post", "/v1/expense-categories", {
    userId: ADMIN,
    societyId: SOCIETY_A,
    body: { name: spec.name ?? "Maintenance", ...spec },
  });

  expect(response.status).toBe(201);
  return response.body.data.category as { readonly id: string };
}

describe("authentication and the society header", () => {
  it("requires a session before anything else", async () => {
    const response = await call("get", "/v1/expense-categories", {
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
    expect(guardReads).toEqual([]);
  });

  it("requires X-Society-Id, with the field named", async () => {
    const response = await call("get", "/v1/expense-categories", {
      userId: ADMIN,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("x-society-id");
    expect(guardReads).toEqual([]);
  });

  it("answers 404 — not 403 — for a society the caller is not in", async () => {
    const response = await call("get", "/v1/expense-categories", {
      userId: OUTSIDER,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("resolves the membership once per request", async () => {
    await call("get", "/v1/expense-categories", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(guardReads).toHaveLength(1);
  });
});

describe("permissions", () => {
  it("refuses a Guest the list — expense.view is not theirs", async () => {
    const response = await call("get", "/v1/expense-categories", {
      userId: GUEST,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toContain("expense.view");
    // Refused before storage: a permission failure is not a query that returned nothing.
    expect(categories.state.calls).toEqual([]);
  });

  it("refuses a Resident a write — expense.publish is Admin or Treasurer", async () => {
    const response = await call("post", "/v1/expense-categories", {
      userId: RESIDENT,
      societyId: SOCIETY_A,
      body: { name: "Painting" },
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(categories.state.calls).toEqual([]);
  });

  it("refuses a Committee Member a write — this is not the structure module's rule", async () => {
    // `structure.edit` versus `expense.publish`: the Committee Member's 🟡 cell on
    // "create expense" is a *draft* qualification, not a category grant, so nothing here
    // narrows against a record and the answer is a plain refusal.
    const write = await call("post", "/v1/expense-categories", {
      userId: COMMITTEE,
      societyId: SOCIETY_A,
      body: { name: "Painting" },
    });
    expect(write.status).toBe(403);

    const read = await call("get", "/v1/expense-categories", {
      userId: COMMITTEE,
      societyId: SOCIETY_A,
    });
    expect(read.status).toBe(200);
    expect(read.body.data.capabilities).toEqual({
      canManage: false,
      canView: true,
    });
  });

  it("lets a Treasurer write — the difference from the building routes", async () => {
    const response = await call("post", "/v1/expense-categories", {
      userId: TREASURER,
      societyId: SOCIETY_A,
      body: { name: "Water" },
    });

    expect(response.status).toBe(201);
    expect(response.body.data.capabilities).toBeUndefined();
  });

  it("answers MEMBER_INACTIVE for a pending membership", async () => {
    const response = await call("get", "/v1/expense-categories", {
      userId: PENDING,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("MEMBER_INACTIVE");
  });

  it("uses the same chain for every verb", async () => {
    const category = await seedViaApi();

    const responses = await Promise.all([
      call("post", "/v1/expense-categories", {
        userId: RESIDENT,
        societyId: SOCIETY_A,
        body: { name: "X" },
      }),
      call("patch", `/v1/expense-categories/${category.id}`, {
        userId: RESIDENT,
        societyId: SOCIETY_A,
        body: { name: "X" },
      }),
      call("delete", `/v1/expense-categories/${category.id}`, {
        userId: RESIDENT,
        societyId: SOCIETY_A,
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      403, 403, 403,
    ]);
  });
});

describe("create", () => {
  it("creates for an Admin and returns exactly the contract's shape", async () => {
    const response = await call("post", "/v1/expense-categories", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: {
        name: "  Bank   Charges ",
        icon: "🏦",
        color: "#4F46E5",
        defaultSplitStrategy: "apartment",
        defaultApartmentBasis: "per_sqft_carpet",
        isOwnerOnly: true,
        isCapital: true,
        gstApplicable: true,
        displayOrder: 16,
      },
    });

    expect(response.status).toBe(201);
    const category = response.body.data.category;
    // Exactly the contract's keys, no more: the mapper parses against
    // `expenseCategorySchema`, so a field added on one side only fails here.
    expect(Object.keys(category).sort()).toEqual([
      "color",
      "createdAt",
      "defaultApartmentBasis",
      "defaultSplitStrategy",
      "deletedAt",
      "displayOrder",
      "gstApplicable",
      "icon",
      "id",
      "isActive",
      "isCapital",
      "isOwnerOnly",
      "name",
      "societyId",
      "updatedAt",
    ]);
    expect(category.name).toBe("Bank Charges");
    // The colour is normalised to lower case; the name's case is the user's.
    expect(category.color).toBe("#4f46e5");
    expect(category.societyId).toBe(SOCIETY_A);
    expect(category.deletedAt).toBeNull();
    expect(category.defaultApartmentBasis).toBe("per_sqft_carpet");
  });

  it("resolves the column defaults rather than leaving them to the database", async () => {
    const response = await call("post", "/v1/expense-categories", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "Miscellaneous" },
    });

    expect(response.body.data.category).toMatchObject({
      icon: null,
      color: null,
      defaultSplitStrategy: "equal",
      defaultApartmentBasis: null,
      isOwnerOnly: false,
      isCapital: false,
      gstApplicable: false,
      isActive: true,
      displayOrder: 0,
    });
  });

  it("drops a basis supplied beside a strategy that never reads one", async () => {
    const response = await call("post", "/v1/expense-categories", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: {
        name: "Security",
        defaultSplitStrategy: "equal",
        defaultApartmentBasis: "per_bhk",
      },
    });

    // Normalised, not refused — a form posting the whole object sends one on every save.
    expect(response.status).toBe(201);
    expect(response.body.data.category.defaultApartmentBasis).toBeNull();
  });

  it("rejects an unknown field, so a typo is reported rather than dropped", async () => {
    const response = await call("post", "/v1/expense-categories", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "Lift", isCapitalExpense: true },
    });

    expect(response.status).toBe(400);
    expect(categories.state.calls).toEqual([]);
  });

  it("rejects a blank name with the field named", async () => {
    const response = await call("post", "/v1/expense-categories", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "   " },
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("name");
    expect(categories.state.calls).toEqual([]);
  });

  it("answers 409 — not 422 — for a name another live category holds", async () => {
    await seedViaApi({ name: "Maintenance" });

    const response = await call("post", "/v1/expense-categories", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "Maintenance" },
    });

    // The payload is well-formed; the *state* is what refuses it (SAD §7.2). The field
    // is named so a form can highlight the input, and the detail code lets a client
    // branch without matching on message text.
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
    expect(response.body.error.field).toBe("name");
    expect(response.body.error.details?.[0]?.code).toBe("CATEGORY_NAME_TAKEN");
  });

  it("refuses a duplicate that differs only by whitespace", async () => {
    await seedViaApi({ name: "Water" });

    const response = await call("post", "/v1/expense-categories", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "  Water  " },
    });

    // The value object collapsed the name before the index compared it, so the two
    // forms of one name cannot both be stored.
    expect(response.status).toBe(409);
  });

  it("rejects a colour that is not a hex literal, naming the field", async () => {
    const response = await call("post", "/v1/expense-categories", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "Lift", color: "red" },
    });

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("color");
  });

  it("rejects a display order outside the range", async () => {
    const response = await call("post", "/v1/expense-categories", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "Lift", displayOrder: 1000 },
    });

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("displayOrder");
  });
});

describe("list", () => {
  it("returns live categories in display order, then by name", async () => {
    await seedViaApi({ name: "C", displayOrder: 3 });
    await seedViaApi({ name: "B", displayOrder: 1 });
    await seedViaApi({ name: "A", displayOrder: 1 });

    const response = await call("get", "/v1/expense-categories", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(
      (response.body.data.categories as readonly { name: string }[]).map(
        (category) => category.name,
      ),
    ).toEqual(["A", "B", "C"]);
    expect(response.body.data.capabilities).toEqual({
      canManage: true,
      canView: true,
    });
  });

  it("includes a deactivated category, which is what makes deactivation reversible", async () => {
    await seedViaApi({ name: "Maintenance", isActive: true });
    await seedViaApi({ name: "Festival & Events", isActive: false });

    const response = await call("get", "/v1/expense-categories", {
      userId: RESIDENT,
      societyId: SOCIETY_A,
    });

    const listed = response.body.data.categories as readonly {
      readonly name: string;
      readonly isActive: boolean;
    }[];
    expect(listed).toHaveLength(2);
    expect(
      listed.find((row) => row.name === "Festival & Events")?.isActive,
    ).toBe(false);
    // A Resident reads and does not manage — the split the screen renders from.
    expect(response.body.data.capabilities).toEqual({
      canManage: false,
      canView: true,
    });
  });

  it("returns an empty list for a society that has not been seeded yet", async () => {
    const response = await call("get", "/v1/expense-categories", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    // 200, not 404: the onboarding step is the screen that fixes an empty society.
    expect(response.status).toBe(200);
    expect(response.body.data.categories).toEqual([]);
  });
});

describe("patch", () => {
  it("changes only the field the caller sent", async () => {
    const category = await seedViaApi({ name: "Maintenance", displayOrder: 1 });

    const response = await call(
      "patch",
      `/v1/expense-categories/${category.id}`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { displayOrder: 5 },
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.data.category.displayOrder).toBe(5);
    // The name survived a patch that did not mention it — the property most worth
    // asserting, because merging the patch would have made it `undefined`.
    expect(response.body.data.category.name).toBe("Maintenance");
  });

  it("normalises a rename", async () => {
    const category = await seedViaApi({ name: "Maintenance" });

    const response = await call(
      "patch",
      `/v1/expense-categories/${category.id}`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { name: "  Maintenance  &  Repairs " },
      },
    );

    expect(response.body.data.category.name).toBe("Maintenance & Repairs");
  });

  it("clears the icon, the colour and the basis with an explicit null", async () => {
    const category = await seedViaApi({
      name: "Sinking Fund",
      defaultSplitStrategy: "apartment",
      defaultApartmentBasis: "per_sqft_carpet",
    });
    await call("patch", `/v1/expense-categories/${category.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { icon: "🏦", color: "#112233" },
    });

    const response = await call(
      "patch",
      `/v1/expense-categories/${category.id}`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { icon: null, color: null, defaultApartmentBasis: null },
      },
    );

    // The three nullable columns are the three a society needs to *empty*, and an
    // absent key means "leave unchanged" — so `null` has to be expressible.
    expect(response.status).toBe(200);
    expect(response.body.data.category).toMatchObject({
      icon: null,
      color: null,
      defaultApartmentBasis: null,
      // Untouched: the strategy was not mentioned.
      defaultSplitStrategy: "apartment",
    });
  });

  it("drops the basis when the strategy moves away from apartment", async () => {
    const category = await seedViaApi({
      name: "Sinking Fund",
      defaultSplitStrategy: "apartment",
      defaultApartmentBasis: "per_sqft_carpet",
    });

    const response = await call(
      "patch",
      `/v1/expense-categories/${category.id}`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { defaultSplitStrategy: "equal" },
      },
    );

    // The pair has to stay coherent, and only the patch could have broken it.
    expect(response.body.data.category.defaultApartmentBasis).toBeNull();
  });

  it("deactivates without deleting", async () => {
    const category = await seedViaApi({ name: "Painting", isActive: true });

    const response = await call(
      "patch",
      `/v1/expense-categories/${category.id}`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { isActive: false },
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.data.category.isActive).toBe(false);
    // Still readable — the row is a live one, merely switched off.
    const list = await call("get", "/v1/expense-categories", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(list.body.data.categories).toHaveLength(1);
  });

  it("answers 409 when a rename collides with another live category", async () => {
    await seedViaApi({ name: "Maintenance" });
    const other = await seedViaApi({ name: "Water" });

    const response = await call("patch", `/v1/expense-categories/${other.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "Maintenance" },
    });

    expect(response.status).toBe(409);
    expect(response.body.error.field).toBe("name");
  });

  it("lets a category keep its own name on an unrelated edit", async () => {
    const category = await seedViaApi({ name: "Maintenance" });

    const response = await call(
      "patch",
      `/v1/expense-categories/${category.id}`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { name: "Maintenance", displayOrder: 3 },
      },
    );

    // The unique index's predicate excludes the row being updated; a check that did not
    // would refuse this.
    expect(response.status).toBe(200);
  });

  it("refuses an empty patch", async () => {
    const category = await seedViaApi();

    const response = await call(
      "patch",
      `/v1/expense-categories/${category.id}`,
      { userId: ADMIN, societyId: SOCIETY_A, body: {} },
    );

    expect(response.status).toBe(422);
  });

  it("rejects a non-UUID id as a validation error, not a 500", async () => {
    const response = await call("patch", "/v1/expense-categories/not-a-uuid", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "X" },
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("answers 404 for a category that does not exist", async () => {
    const response = await call(
      "patch",
      `/v1/expense-categories/${randomUUID()}`,
      { userId: ADMIN, societyId: SOCIETY_A, body: { name: "X" } },
    );

    expect(response.status).toBe(404);
  });
});

describe("delete", () => {
  it("soft-deletes: the route answers 204 and every read path loses it", async () => {
    const category = await seedViaApi({ name: "Painting" });

    const deleted = await call(
      "delete",
      `/v1/expense-categories/${category.id}`,
      { userId: ADMIN, societyId: SOCIETY_A },
    );
    expect(deleted.status).toBe(204);
    expect(deleted.body).toEqual({});

    const list = await call("get", "/v1/expense-categories", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(list.body.data.categories).toEqual([]);

    const patched = await call(
      "patch",
      `/v1/expense-categories/${category.id}`,
      { userId: ADMIN, societyId: SOCIETY_A, body: { name: "X" } },
    );
    expect(patched.status).toBe(404);

    // Still in storage, marked — that is what makes it soft, and what keeps the
    // expenses filed under it attached to a subject.
    expect(
      categories.state.categories.get(category.id)?.deletedAt,
    ).not.toBeNull();
  });

  it("frees the name for reuse, because the unique index is partial on live rows", async () => {
    const category = await seedViaApi({ name: "Painting" });
    await call("delete", `/v1/expense-categories/${category.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    const recreated = await call("post", "/v1/expense-categories", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "Painting" },
    });

    expect(recreated.status).toBe(201);
  });

  it("refuses while an expense references the category, with its own code", async () => {
    const category = await seedViaApi({ name: "Lift" });
    categories.state.references.set(category.id, 3);

    const response = await call(
      "delete",
      `/v1/expense-categories/${category.id}`,
      { userId: ADMIN, societyId: SOCIETY_A },
    );

    // The Roadmap's own case: a deletion blocked by a reference, with a code a client
    // can branch on — not a generic 409, and not a message string to match.
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
    expect(response.body.error.details?.[0]?.code).toBe(
      "CATEGORY_HAS_EXPENSES",
    );
    expect(response.body.error.message).toContain("Deactivate it instead");
    // Nothing was deleted.
    expect(categories.state.categories.get(category.id)?.deletedAt).toBeNull();
  });

  it("deletes once nothing references it any more", async () => {
    const category = await seedViaApi({ name: "Lift" });
    categories.state.references.set(category.id, 2);

    const blocked = await call(
      "delete",
      `/v1/expense-categories/${category.id}`,
      { userId: ADMIN, societyId: SOCIETY_A },
    );
    expect(blocked.status).toBe(409);

    categories.state.references.set(category.id, 0);

    const allowed = await call(
      "delete",
      `/v1/expense-categories/${category.id}`,
      { userId: ADMIN, societyId: SOCIETY_A },
    );
    // The refusal's advice ("remove them first") actually works.
    expect(allowed.status).toBe(204);
  });

  it("answers 404 when the id belongs to another society", async () => {
    const category = await seedViaApi({ name: "Painting" });

    const response = await call(
      "delete",
      `/v1/expense-categories/${category.id}`,
      { userId: ADMIN, societyId: SOCIETY_B },
    );

    expect(response.status).toBe(404);
    expect(categories.state.categories.get(category.id)?.deletedAt).toBeNull();
  });

  it("answers 404 for a category that does not exist", async () => {
    const response = await call(
      "delete",
      `/v1/expense-categories/${randomUUID()}`,
      { userId: ADMIN, societyId: SOCIETY_A },
    );

    expect(response.status).toBe(404);
  });
});

describe("the SAD §7.10 envelope", () => {
  it("carries the request id inside `error` on every refusal", async () => {
    const responses = await Promise.all([
      call("get", "/v1/expense-categories", { societyId: SOCIETY_A }),
      call("get", "/v1/expense-categories", { userId: ADMIN }),
      call("get", "/v1/expense-categories", {
        userId: GUEST,
        societyId: SOCIETY_A,
      }),
      call("get", "/v1/expense-categories", {
        userId: OUTSIDER,
        societyId: SOCIETY_A,
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      401, 400, 403, 404,
    ]);
    for (const response of responses) {
      expect(response.body.error.code).toBeDefined();
      expect(response.body.error.requestId).toBe(
        response.headers["x-request-id"],
      );
    }
  });

  it("wraps a success in `data` and a failure in `error`, never both", async () => {
    const ok = await call("get", "/v1/expense-categories", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(ok.body.data).toBeDefined();
    expect(ok.body.error).toBeUndefined();

    const refused = await call("get", "/v1/expense-categories", {
      userId: OUTSIDER,
      societyId: SOCIETY_A,
    });
    expect(refused.body.error).toBeDefined();
    expect(refused.body.data).toBeUndefined();
  });
});
