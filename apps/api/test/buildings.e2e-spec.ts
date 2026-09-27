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
import { createFakeApartmentRepository } from "./utils/fake-apartment-repository";
import {
  createFakeBuildingRepository,
  type FakeBuildingRepository,
} from "./utils/fake-building-repository";
import { createTestAuth, type TestAuth } from "./utils/supabase-auth";
import { createTestApp } from "./utils/test-app";

/**
 * The building routes over real HTTP (Roadmap T042).
 *
 * ## What runs for real
 *
 * The whole guard chain — the global auth guard verifying a real signature against
 * a locally held key pair, `SocietyGuard` resolving `X-Society-Id` to a membership,
 * `PermissionGuard` asking the domain's matrix — plus the Zod pipe parsing the real
 * contract schema, the real use cases, the real mappers, the response envelope and
 * the exception filter.
 *
 * ## What does not
 *
 * Storage and RLS. Two seams are substituted: the building repository (no
 * Postgres), and the membership read the *use cases* perform. The second one is
 * deliberate rather than convenient — the guard has its own membership read, and
 * pointing them at the same fixture is what lets this suite assert that a refusal
 * comes from the layer it claims to come from. Nothing here evaluates a policy, so
 * a mistake in the committed SQL is invisible; `scripts/db/rls-canary.sql` is what
 * covers that, and it asserts the guard-bypassed path is still refused.
 *
 * ## Why these routes and not the society ones
 *
 * Buildings are the first module addressed by a header rather than a path
 * parameter, so they are the first production routes that actually run the chain.
 * The society routes' four guard tests live in `authorization.e2e-spec.ts` against
 * a throwaway probe controller; this suite is the same chain over an endpoint that
 * ships.
 */

const SOCIETY_A = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const SOCIETY_B = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

const ADMIN: UserId = asUserId("11111111-1111-4111-8111-111111111111");
const TREASURER: UserId = asUserId("22222222-2222-4222-8222-222222222222");
const RESIDENT: UserId = asUserId("33333333-3333-4333-8333-333333333333");
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
let buildings: FakeBuildingRepository;

beforeAll(async () => {
  auth = await createTestAuth();
  buildings = createFakeBuildingRepository();
  app = await createTestApp({
    jwks: auth.jwks,
    reader,
    membershipReader,
    buildings,
    // The flat repository is substituted even though no flat route is called here:
    // `deleteBuilding` counts the building's flats before it removes it (T043), so
    // without this seam the *building* delete would reach for Postgres. It is an
    // empty in-memory store, which is exactly the fixture these tests want — a
    // building with no flats is removable.
    apartments: createFakeApartmentRepository(),
  });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  memberships.clear();
  guardReads.length = 0;
  buildings.state.buildings.clear();
  buildings.state.calls.length = 0;

  memberships.set(key(SOCIETY_A, ADMIN), membershipOf(ADMIN, "admin"));
  memberships.set(
    key(SOCIETY_A, TREASURER),
    membershipOf(TREASURER, "treasurer"),
  );
  memberships.set(key(SOCIETY_A, RESIDENT), membershipOf(RESIDENT, "resident"));
  memberships.set(key(SOCIETY_A, GUEST), membershipOf(GUEST, "guest"));
  memberships.set(
    key(SOCIETY_A, PENDING),
    membershipOf(PENDING, "resident", "pending"),
  );
  // An Admin of the *other* society: sufficient to prove that a society header
  // alone never grants access to a building inside a different one.
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

/** Creates a building as the Admin, returning the created DTO. */
async function seedViaApi(
  spec: {
    readonly name?: string;
    readonly totalFloors?: number;
    readonly displayOrder?: number;
  } = {},
) {
  const response = await call("post", "/v1/buildings", {
    userId: ADMIN,
    societyId: SOCIETY_A,
    body: {
      name: spec.name ?? "Block A",
      ...(spec.totalFloors === undefined
        ? {}
        : { totalFloors: spec.totalFloors }),
      ...(spec.displayOrder === undefined
        ? {}
        : { displayOrder: spec.displayOrder }),
    },
  });

  expect(response.status).toBe(201);
  return response.body.data.building as { readonly id: string };
}

describe("authentication and the society header", () => {
  it("requires a session before anything else", async () => {
    const response = await call("get", "/v1/buildings", {
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
    // No session, no lookup: the guard must not read a membership it cannot scope.
    expect(guardReads).toEqual([]);
  });

  it("requires X-Society-Id, with the field named", async () => {
    const response = await call("get", "/v1/buildings", { userId: ADMIN });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("x-society-id");
    expect(guardReads).toEqual([]);
  });

  it("rejects a malformed society id without querying", async () => {
    const response = await call("get", "/v1/buildings", {
      userId: ADMIN,
      societyId: "not-a-uuid",
    });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe("Invalid Society Id.");
    expect(guardReads).toEqual([]);
  });

  it("answers 404 — not 403 — for a society the caller is not in", async () => {
    const response = await call("get", "/v1/buildings", {
      userId: OUTSIDER,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("resolves the membership once per request", async () => {
    await call("get", "/v1/buildings", { userId: ADMIN, societyId: SOCIETY_A });

    expect(guardReads).toHaveLength(1);
  });
});

describe("permissions", () => {
  it("refuses a Guest the list — structure.view is not theirs", async () => {
    const response = await call("get", "/v1/buildings", {
      userId: GUEST,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toContain("structure.view");
    // Refused before storage: a permission failure is not a query that returned
    // nothing.
    expect(buildings.state.calls).toEqual([]);
  });

  it("refuses a Resident a write — structure.edit is Admin-only", async () => {
    const response = await call("post", "/v1/buildings", {
      userId: RESIDENT,
      societyId: SOCIETY_A,
      body: { name: "Block A" },
    });

    expect(response.status).toBe(403);
    expect(buildings.state.calls).toEqual([]);
  });

  it("refuses a Treasurer a write, but lets them read", async () => {
    const write = await call("post", "/v1/buildings", {
      userId: TREASURER,
      societyId: SOCIETY_A,
      body: { name: "Block A" },
    });
    expect(write.status).toBe(403);

    const read = await call("get", "/v1/buildings", {
      userId: TREASURER,
      societyId: SOCIETY_A,
    });
    expect(read.status).toBe(200);
    expect(read.body.data.capabilities).toEqual({
      canManage: false,
      canView: true,
    });
  });

  it("answers MEMBER_INACTIVE for a pending membership", async () => {
    const response = await call("get", "/v1/buildings", {
      userId: PENDING,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("MEMBER_INACTIVE");
  });

  it("uses the same chain for every verb", async () => {
    const building = await seedViaApi();

    const responses = await Promise.all([
      call("post", "/v1/buildings", {
        userId: RESIDENT,
        societyId: SOCIETY_A,
        body: { name: "X" },
      }),
      call("patch", `/v1/buildings/${building.id}`, {
        userId: RESIDENT,
        societyId: SOCIETY_A,
        body: { name: "X" },
      }),
      call("delete", `/v1/buildings/${building.id}`, {
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
  it("creates for an Admin and returns the contract's shape", async () => {
    const response = await call("post", "/v1/buildings", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "  Block  B ", totalFloors: 12, displayOrder: 2 },
    });

    expect(response.status).toBe(201);
    const building = response.body.data.building;
    // Exactly the contract's keys, no more: the mapper parses against
    // `buildingSchema`, so a field added on one side only fails here.
    expect(Object.keys(building).sort()).toEqual([
      "createdAt",
      "deletedAt",
      "displayOrder",
      "id",
      "name",
      "societyId",
      "totalFloors",
      "updatedAt",
    ]);
    expect(building.name).toBe("Block B");
    expect(building.totalFloors).toBe(12);
    expect(building.displayOrder).toBe(2);
    expect(building.societyId).toBe(SOCIETY_A);
    expect(building.deletedAt).toBeNull();
  });

  it("resolves the display-order default rather than leaving it to the database", async () => {
    const response = await call("post", "/v1/buildings", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "Block C" },
    });

    expect(response.body.data.building.displayOrder).toBe(0);
    expect(response.body.data.building.totalFloors).toBeNull();
  });

  it("rejects an unknown field, so a typo is reported rather than dropped", async () => {
    const response = await call("post", "/v1/buildings", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "Block D", floorCount: 4 },
    });

    expect(response.status).toBe(400);
    expect(buildings.state.calls).toEqual([]);
  });

  it("rejects a blank name with the field named", async () => {
    const response = await call("post", "/v1/buildings", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "   " },
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("name");
    expect(buildings.state.calls).toEqual([]);
  });

  it("answers 409 — not 422 — for a name another live building holds", async () => {
    await seedViaApi({ name: "Block A" });

    const response = await call("post", "/v1/buildings", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "Block A" },
    });

    // The payload is well-formed; the *state* is what refuses it, which is what
    // makes it a conflict (SAD §7.2). The field is named so a form can highlight
    // the input rather than showing a banner.
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
    expect(response.body.error.field).toBe("name");
  });

  it("rejects a floor count outside the range", async () => {
    const response = await call("post", "/v1/buildings", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "Block E", totalFloors: 1200 },
    });

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("totalFloors");
  });
});

describe("list", () => {
  it("returns buildings in display order, then by name", async () => {
    await seedViaApi({ name: "C", displayOrder: 2 });
    await seedViaApi({ name: "B", displayOrder: 1 });
    await seedViaApi({ name: "A", displayOrder: 1 });

    const response = await call("get", "/v1/buildings", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(
      (response.body.data.buildings as readonly { name: string }[]).map(
        (building) => building.name,
      ),
    ).toEqual(["A", "B", "C"]);
    expect(response.body.data.capabilities).toEqual({
      canManage: true,
      canView: true,
    });
  });

  it("returns an empty list for a society with no buildings yet", async () => {
    const response = await call("get", "/v1/buildings", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    // 200, not 404: the structure step is the screen that fixes an empty society.
    expect(response.status).toBe(200);
    expect(response.body.data.buildings).toEqual([]);
  });
});

describe("detail", () => {
  it("returns one building with capabilities", async () => {
    const building = await seedViaApi({ name: "Tower 1" });

    const response = await call("get", `/v1/buildings/${building.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.building.name).toBe("Tower 1");
    expect(response.body.data.capabilities.canManage).toBe(true);
  });

  it("rejects a non-UUID building id as a validation error, not a 500", async () => {
    const response = await call("get", "/v1/buildings/not-a-uuid", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("answers 404 for a building inside another society, even for its Admin", async () => {
    // The same user is an Admin in B. Asking for B's building id while scoped to A
    // must not reach it: a building is addressable only by the pair.
    const building = await seedViaApi({ name: "Theirs" });

    const response = await call("get", `/v1/buildings/${building.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_B,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});

describe("patch", () => {
  it("changes only the field the caller sent", async () => {
    const building = await seedViaApi({ name: "Block A", displayOrder: 0 });

    const response = await call("patch", `/v1/buildings/${building.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { displayOrder: 5 },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.building.displayOrder).toBe(5);
    // The name survived a patch that did not mention it — the property most worth
    // asserting, because merging the patch would have made it `undefined`.
    expect(response.body.data.building.name).toBe("Block A");
  });

  it("normalises a rename", async () => {
    const building = await seedViaApi({ name: "Block A" });

    const response = await call("patch", `/v1/buildings/${building.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "  Block  A  (West) " },
    });

    expect(response.body.data.building.name).toBe("Block A (West)");
  });

  it("answers 409 when a rename collides with another live building", async () => {
    await seedViaApi({ name: "Block A" });
    const other = await seedViaApi({ name: "Block B" });

    const response = await call("patch", `/v1/buildings/${other.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "Block A" },
    });

    expect(response.status).toBe(409);
    expect(response.body.error.field).toBe("name");
  });

  it("lets a building keep its own name on an unrelated edit", async () => {
    const building = await seedViaApi({ name: "Block A" });

    const response = await call("patch", `/v1/buildings/${building.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "Block A", displayOrder: 3 },
    });

    expect(response.status).toBe(200);
  });

  it("refuses an empty patch", async () => {
    const building = await seedViaApi();

    const response = await call("patch", `/v1/buildings/${building.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: {},
    });

    expect(response.status).toBe(422);
  });

  it("answers 404 for a building that does not exist", async () => {
    const response = await call("patch", `/v1/buildings/${randomUUID()}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "X" },
    });

    expect(response.status).toBe(404);
  });
});

describe("delete", () => {
  it("soft-deletes: the route answers 204 and every read path loses it", async () => {
    const building = await seedViaApi({ name: "Block A" });

    const deleted = await call("delete", `/v1/buildings/${building.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(deleted.status).toBe(204);
    expect(deleted.body).toEqual({});

    const detail = await call("get", `/v1/buildings/${building.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(detail.status).toBe(404);

    const list = await call("get", "/v1/buildings", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(list.body.data.buildings).toEqual([]);

    // Still in storage, marked — that is what makes it soft, and what keeps
    // apartments and history attached to a parent when T043 lands.
    expect(
      buildings.state.buildings.get(building.id)?.deletedAt,
    ).not.toBeNull();
  });

  it("frees the name for reuse", async () => {
    const building = await seedViaApi({ name: "Block A" });
    await call("delete", `/v1/buildings/${building.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    const recreated = await call("post", "/v1/buildings", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { name: "Block A" },
    });

    expect(recreated.status).toBe(201);
  });

  it("answers 404 when the id belongs to another society", async () => {
    const building = await seedViaApi({ name: "Block A" });

    const response = await call("delete", `/v1/buildings/${building.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_B,
    });

    expect(response.status).toBe(404);
    expect(buildings.state.buildings.get(building.id)?.deletedAt).toBeNull();
  });
});

describe("the SAD §7.10 envelope", () => {
  it("carries the request id inside `error` on every refusal", async () => {
    const responses = await Promise.all([
      call("get", "/v1/buildings", { societyId: SOCIETY_A }),
      call("get", "/v1/buildings", { userId: ADMIN }),
      call("get", "/v1/buildings", {
        userId: GUEST,
        societyId: SOCIETY_A,
      }),
      call("get", "/v1/buildings", {
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
    const ok = await call("get", "/v1/buildings", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(ok.body.data).toBeDefined();
    expect(ok.body.error).toBeUndefined();

    const refused = await call("get", "/v1/buildings", {
      userId: OUTSIDER,
      societyId: SOCIETY_A,
    });
    expect(refused.body.error).toBeDefined();
    expect(refused.body.data).toBeUndefined();
  });
});
