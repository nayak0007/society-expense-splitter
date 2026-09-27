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
  createFakeApartmentRepository,
  type FakeApartmentRepository,
} from "./utils/fake-apartment-repository";
import {
  createFakeBuildingRepository,
  type FakeBuildingRepository,
} from "./utils/fake-building-repository";
import { createTestAuth, type TestAuth } from "./utils/supabase-auth";
import { createTestApp } from "./utils/test-app";

/**
 * The flat routes over real HTTP (Roadmap T043).
 *
 * ## What runs for real
 *
 * The whole guard chain — the global auth guard verifying a real signature against
 * a locally held key pair, `SocietyGuard` resolving `X-Society-Id` to a membership,
 * `PermissionGuard` asking the domain's matrix — plus the Zod pipe parsing the real
 * contract schema, the real use cases, the real mappers, the response envelope and
 * the exception filter. That last part is not ceremony: the mapper *parses* its own
 * output against `@ses/contracts`, so a field the contract and the domain disagree
 * about fails here rather than on a device.
 *
 * ## What does not
 *
 * Storage and RLS. Two seams are substituted — the flat repository and the building
 * repository, because the routes span both — plus the membership read the *use
 * cases* perform, which is pointed at the same fixture the guard reads and for the
 * same reason: a refusal must come from the layer it claims to come from. Nothing
 * here evaluates a policy, so a mistake in the committed SQL is invisible;
 * `scripts/db/rls-canary.sql` covers that.
 *
 * ## The one rule that only appears here
 *
 * \"A building that still has flats cannot be removed\" spans two modules: the
 * *building* route refuses, on the basis of a count taken through the **flat**
 * repository. Both fakes are wired into this app so the whole path — use case,
 * count, typed error, catalogue code, status — is exercised by a real request.
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

const membershipReader: StructureMembershipReader = {
  findMembership(societyId, actor) {
    return Promise.resolve(memberships.get(key(societyId, actor)) ?? null);
  },
};

let app: NestFastifyApplication;
let auth: TestAuth;
let buildings: FakeBuildingRepository;
let apartments: FakeApartmentRepository;

beforeAll(async () => {
  auth = await createTestAuth();
  buildings = createFakeBuildingRepository();
  apartments = createFakeApartmentRepository();
  app = await createTestApp({
    jwks: auth.jwks,
    reader,
    membershipReader,
    buildings,
    apartments,
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
  apartments.state.apartments.clear();
  apartments.state.calls.length = 0;

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
  // alone never grants access to structure inside a different one.
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

/** A building in SOCIETY_A, seeded straight into storage. */
let buildingA: string;

/** Creates a flat through the API as the Admin, returning the created DTO. */
async function seedViaApi(
  body: Record<string, unknown> = {},
  buildingId: string = buildingA,
) {
  const response = await call(
    "post",
    `/v1/buildings/${buildingId}/apartments`,
    {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { apartmentNumber: "A-101", ...body },
    },
  );

  expect(response.status).toBe(201);
  return response.body.data.apartment as { readonly id: string };
}

beforeEach(() => {
  // A fresh building per test, so a seeded flat can never be inherited from the
  // previous one — the flat fixtures are cleared, and the building id they hang off
  // has to be too.
  buildingA = buildings.seed(SOCIETY_A, { name: "Block A" }).id;
});

describe("authentication and the society header", () => {
  it("requires a session before anything else", async () => {
    const response = await call(
      "get",
      `/v1/buildings/${buildingA}/apartments`,
      {
        societyId: SOCIETY_A,
      },
    );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
    // No session, no lookup: the guard must not read a membership it cannot scope.
    expect(guardReads).toEqual([]);
  });

  it("requires X-Society-Id, with the field named", async () => {
    const response = await call(
      "get",
      `/v1/buildings/${buildingA}/apartments`,
      {
        userId: ADMIN,
      },
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("x-society-id");
  });

  it("answers 404 — not 403 — for a society the caller is not in", async () => {
    const response = await call(
      "get",
      `/v1/buildings/${buildingA}/apartments`,
      {
        userId: OUTSIDER,
        societyId: SOCIETY_A,
      },
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("resolves the membership once per request", async () => {
    await call("get", `/v1/buildings/${buildingA}/apartments`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(guardReads).toHaveLength(1);
  });

  it("rejects a non-UUID apartment id before any query runs", async () => {
    const response = await call("get", "/v1/apartments/not-a-uuid", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    // The cheap assertion that matters: an id that is not a uuid never reaches
    // storage, so a client bug is a validation failure rather than a `22P02`
    // reported as a 500.
    expect(apartments.state.calls).toEqual([]);
  });
});

describe("permissions", () => {
  it("refuses a Guest the list — structure.view is not theirs", async () => {
    const response = await call(
      "get",
      `/v1/buildings/${buildingA}/apartments`,
      {
        userId: GUEST,
        societyId: SOCIETY_A,
      },
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toContain("structure.view");
    // Refused before storage: a permission failure is not a query that returned
    // nothing.
    expect(apartments.state.calls).toEqual([]);
  });

  it("refuses a Resident a write — structure.edit is Admin-only", async () => {
    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments`,
      {
        userId: RESIDENT,
        societyId: SOCIETY_A,
        body: { apartmentNumber: "A-101" },
      },
    );

    expect(response.status).toBe(403);
    expect(apartments.state.calls).toEqual([]);
  });

  it("refuses a Treasurer a write, but lets them read", async () => {
    const write = await call("post", `/v1/buildings/${buildingA}/apartments`, {
      userId: TREASURER,
      societyId: SOCIETY_A,
      body: { apartmentNumber: "A-101" },
    });
    expect(write.status).toBe(403);

    const read = await call("get", `/v1/buildings/${buildingA}/apartments`, {
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
    const response = await call(
      "get",
      `/v1/buildings/${buildingA}/apartments`,
      {
        userId: PENDING,
        societyId: SOCIETY_A,
      },
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("MEMBER_INACTIVE");
  });

  it("uses the same chain for every flat verb", async () => {
    const apartment = await seedViaApi();

    const responses = await Promise.all([
      call("get", `/v1/apartments/${apartment.id}`, {
        userId: GUEST,
        societyId: SOCIETY_A,
      }),
      call("patch", `/v1/apartments/${apartment.id}`, {
        userId: RESIDENT,
        societyId: SOCIETY_A,
        body: { apartmentNumber: "X-1" },
      }),
      call("delete", `/v1/apartments/${apartment.id}`, {
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
  it("creates for an Admin and returns exactly the contract shape", async () => {
    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: {
          apartmentNumber: "  A-101 ",
          floor: 1,
          bhk: 2,
          carpetAreaSqft: 900,
        },
      },
    );

    expect(response.status).toBe(201);
    const apartment = response.body.data.apartment;
    expect(Object.keys(apartment).sort()).toEqual([
      "apartmentNumber",
      "bhk",
      "buildingId",
      "builtupAreaSqft",
      "carpetAreaSqft",
      "createdAt",
      "deletedAt",
      "floor",
      "id",
      "isBillable",
      "isCommercial",
      "occupancyStatus",
      "parkingSlots",
      "shareUnits",
      "societyId",
      "updatedAt",
      "wingId",
    ]);
    // Whitespace is collapsed by the value object, so the label a resident reads is
    // the label that was stored.
    expect(apartment.apartmentNumber).toBe("A-101");
    expect(apartment.societyId).toBe(SOCIETY_A);
    expect(apartment.buildingId).toBe(buildingA);
    expect(apartment.deletedAt).toBeNull();
  });

  it("resolves the column defaults rather than leaving them to the database", async () => {
    const apartment = await seedViaApi();

    // Read back rather than asserted from the create response: what matters is that
    // a later read agrees, which is what makes the defaults a fact about the flat
    // rather than about one response.
    const response = await call("get", `/v1/apartments/${apartment.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.apartment).toMatchObject({
      floor: null,
      bhk: null,
      carpetAreaSqft: null,
      builtupAreaSqft: null,
      parkingSlots: 0,
      shareUnits: 1,
      occupancyStatus: "vacant",
      isCommercial: false,
      isBillable: true,
    });
  });

  it("rejects an unknown field, so a typo is reported rather than dropped", async () => {
    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { apartmentNumber: "A-102", unitNumber: "A-102" },
      },
    );

    expect(response.status).toBe(400);
    expect(apartments.state.calls).toEqual([]);
  });

  it("rejects a blank flat number with the field named", async () => {
    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { apartmentNumber: "   " },
      },
    );

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("apartmentNumber");
  });

  it("refuses a built-up area smaller than the carpet area, against that field", async () => {
    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: {
          apartmentNumber: "A-103",
          carpetAreaSqft: 1200,
          builtupAreaSqft: 900,
        },
      },
    );

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("builtupAreaSqft");
    expect(apartments.state.calls).toEqual([]);
  });

  it("refuses a zero area, which the split rules would divide by", async () => {
    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { apartmentNumber: "A-104", carpetAreaSqft: 0 },
      },
    );

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("carpetAreaSqft");
  });

  it("refuses a configuration that is not a half step", async () => {
    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { apartmentNumber: "A-105", bhk: 1.25 },
      },
    );

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("bhk");
  });

  it("refuses an occupancy status outside the enum", async () => {
    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { apartmentNumber: "A-106", occupancyStatus: "haunted" },
      },
    );

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("occupancyStatus");
    expect(apartments.state.calls).toEqual([]);
  });

  it("refuses a duplicate flat number in the same building, naming the field", async () => {
    await seedViaApi({ apartmentNumber: "A-101" });

    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { apartmentNumber: "A-101" },
      },
    );

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
    // Not a banner: the number input is what has to change, and the client branches
    // on the field rather than on the message.
    expect(response.body.error.field).toBe("apartmentNumber");
  });

  it("allows the same flat number in a different building", async () => {
    await seedViaApi({ apartmentNumber: "A-101" });
    const other = buildings.seed(SOCIETY_A, { name: "Block B" });

    const response = await call(
      "post",
      `/v1/buildings/${other.id}/apartments`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { apartmentNumber: "A-101" },
      },
    );

    expect(response.status).toBe(201);
  });

  it("treats a number freed by a delete as available again", async () => {
    const first = await seedViaApi({ apartmentNumber: "A-101" });
    await call("delete", `/v1/apartments/${first.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { apartmentNumber: "A-101" },
      },
    );

    // Uniqueness is among *live* flats — the partial index's `WHERE deleted_at IS
    // NULL` — so a society that removes a flat by mistake can recreate it.
    expect(response.status).toBe(201);
  });
});

describe("cross-society isolation", () => {
  it("answers 404 for a building in another society", async () => {
    const response = await call(
      "get",
      `/v1/buildings/${buildings.seed(SOCIETY_B, { name: "Theirs" }).id}/apartments`,
      { userId: ADMIN, societyId: SOCIETY_A },
    );

    // 404, not `200 []`: the flats query is scoped by `(building_id, society_id)`, so
    // without loading the building first this would look like an empty building — a
    // distinguishable answer for structure the caller cannot see (PRD T041).
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(apartments.state.calls).toEqual([]);
  });

  it("answers 404 for a building that was deleted", async () => {
    const response = await call(
      "post",
      `/v1/buildings/${buildings.seed(SOCIETY_A, { name: "Gone", deleted: true }).id}/apartments`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { apartmentNumber: "A-101" },
      },
    );

    expect(response.status).toBe(404);
    expect(apartments.state.calls).toEqual([]);
  });

  it("answers 404 for a flat in another society, addressed by id", async () => {
    const foreign = apartments.seed(SOCIETY_B, randomUUID());

    const response = await call("get", `/v1/apartments/${foreign.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(404);
  });

  it("refuses to let another society's Admin write to a flat here", async () => {
    const apartment = await seedViaApi();

    const response = await call("patch", `/v1/apartments/${apartment.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_B,
      body: { apartmentNumber: "X-1" },
    });

    // Not 403: the caller is an Admin — of somewhere else. Their header names a
    // society the flat is not in, and distinguishing that from "no such flat" would
    // let them enumerate this one (PRD T041).
    expect(response.status).toBe(404);
  });
});

describe("list", () => {
  it("returns the flats in floor then flat-number order", async () => {
    await seedViaApi({ apartmentNumber: "A-201", floor: 2 });
    await seedViaApi({ apartmentNumber: "A-102", floor: 1 });
    await seedViaApi({ apartmentNumber: "A-101", floor: 1 });

    const response = await call(
      "get",
      `/v1/buildings/${buildingA}/apartments`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
      },
    );

    expect(response.status).toBe(200);
    expect(
      response.body.data.apartments.map(
        (apartment: { apartmentNumber: string }) => apartment.apartmentNumber,
      ),
    ).toEqual(["A-101", "A-102", "A-201"]);
    expect(response.body.data.capabilities).toEqual({
      canManage: true,
      canView: true,
    });
  });

  it("sorts an unrecorded floor last rather than first", async () => {
    await seedViaApi({ apartmentNumber: "A-101", floor: 1 });
    await seedViaApi({ apartmentNumber: "A-999" });

    const response = await call(
      "get",
      `/v1/buildings/${buildingA}/apartments`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
      },
    );

    expect(
      response.body.data.apartments.map(
        (apartment: { apartmentNumber: string }) => apartment.apartmentNumber,
      ),
    ).toEqual(["A-101", "A-999"]);
  });

  it("returns an empty list for a building with no flats", async () => {
    const empty = buildings.seed(SOCIETY_A, { name: "Block Empty" });

    const response = await call("get", `/v1/buildings/${empty.id}/apartments`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    // Not a 404: a building that was just created genuinely has none, and this is
    // the screen that fixes that.
    expect(response.status).toBe(200);
    expect(response.body.data.apartments).toEqual([]);
    expect(response.body.data.capabilities.canManage).toBe(true);
  });
});

describe("view one flat", () => {
  it("returns the flat with the caller's capabilities", async () => {
    const apartment = await seedViaApi({ apartmentNumber: "A-101", floor: 3 });

    const response = await call("get", `/v1/apartments/${apartment.id}`, {
      userId: TREASURER,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.apartment.floor).toBe(3);
    expect(response.body.data.capabilities).toEqual({
      canManage: false,
      canView: true,
    });
  });

  it("answers 404 for a flat that does not exist", async () => {
    const response = await call("get", `/v1/apartments/${randomUUID()}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("answers 404 for a flat that was deleted", async () => {
    const apartment = await seedViaApi();
    await call("delete", `/v1/apartments/${apartment.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    const response = await call("get", `/v1/apartments/${apartment.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(404);
  });
});

describe("edit", () => {
  it("leaves an absent field alone", async () => {
    const apartment = await seedViaApi({ floor: 3, parkingSlots: 2 });

    const response = await call("patch", `/v1/apartments/${apartment.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { apartmentNumber: "A-202" },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.apartment.apartmentNumber).toBe("A-202");
    expect(response.body.data.apartment.floor).toBe(3);
    expect(response.body.data.apartment.parkingSlots).toBe(2);
  });

  it("clears a measurement with an explicit null", async () => {
    const apartment = await seedViaApi({ floor: 3, carpetAreaSqft: 900 });

    const response = await call("patch", `/v1/apartments/${apartment.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { floor: null, carpetAreaSqft: null },
    });

    expect(response.status).toBe(200);
    // The whole-chain assertion: `null` survives the contract, the use case, the
    // repository and the mapper, and comes back as `null` rather than as an absent
    // key or a zero.
    expect(response.body.data.apartment.floor).toBeNull();
    expect(response.body.data.apartment.carpetAreaSqft).toBeNull();
  });

  it("validates only what was sent, against what is stored", async () => {
    const apartment = await seedViaApi({
      carpetAreaSqft: 900,
      builtupAreaSqft: 1100,
    });

    const refused = await call("patch", `/v1/apartments/${apartment.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { carpetAreaSqft: 1200 },
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.field).toBe("builtupAreaSqft");

    const accepted = await call("patch", `/v1/apartments/${apartment.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { carpetAreaSqft: 1000 },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.apartment.builtupAreaSqft).toBe(1100);
  });

  it("rejects an empty patch at the edge", async () => {
    const apartment = await seedViaApi();

    const response = await call("patch", `/v1/apartments/${apartment.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: {},
    });

    // 422 rather than 400: the body is well-formed JSON whose *values* are the
    // problem — there are none — which is the same status an out-of-range floor
    // gets, and it is the contract's own `refine` saying so.
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    // The create the fixture performed is the only storage call: no `update` was
    // attempted, which is what "rejected at the edge" has to mean.
    expect(apartments.state.calls).not.toContain("update");
  });

  it("refuses a renumbering that collides with another flat", async () => {
    await seedViaApi({ apartmentNumber: "A-101" });
    const second = await seedViaApi({ apartmentNumber: "A-102" });

    const response = await call("patch", `/v1/apartments/${second.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { apartmentNumber: "A-101" },
    });

    expect(response.status).toBe(409);
    expect(response.body.error.field).toBe("apartmentNumber");
  });

  it("accepts a patch that only changes a non-nullable field", async () => {
    const apartment = await seedViaApi({ occupancyStatus: "vacant" });

    const response = await call("patch", `/v1/apartments/${apartment.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { occupancyStatus: "rented", isCommercial: true, shareUnits: 0 },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.apartment).toMatchObject({
      occupancyStatus: "rented",
      isCommercial: true,
      shareUnits: 0,
    });
  });
});

describe("delete", () => {
  it("soft-deletes and returns no body", async () => {
    const apartment = await seedViaApi();

    const response = await call("delete", `/v1/apartments/${apartment.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(204);
    expect(response.body).toEqual({});
    // Still in storage, marked — members, dues and meter readings will point at it.
    expect(
      apartments.state.apartments.get(apartment.id)?.deletedAt,
    ).not.toBeNull();
  });

  it("removes it from the building list", async () => {
    const apartment = await seedViaApi();

    await call("delete", `/v1/apartments/${apartment.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    const response = await call(
      "get",
      `/v1/buildings/${buildingA}/apartments`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
      },
    );

    expect(response.body.data.apartments).toEqual([]);
  });

  it("answers 404 for a flat in another society", async () => {
    const foreign = apartments.seed(SOCIETY_B, randomUUID());

    const response = await call("delete", `/v1/apartments/${foreign.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(404);
  });
});

describe("generate from a pattern (T044)", () => {
  const generateBody = {
    pattern: "{wing}-{floor}{unit:02d}",
    floors: [1, 2, 3, 4, 5, 6, 7, 8],
    unitsPerFloor: 4,
    wings: [
      { id: null, label: "A" },
      { id: null, label: "B" },
    ],
  };

  it("creates exactly 64 flats for 2 wings x 8 floors x 4 units", async () => {
    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments/generate`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { ...generateBody, dryRun: false },
      },
    );

    expect(response.status).toBe(201);
    expect(response.body.data.total).toBe(64);
    expect(response.body.data.createdCount).toBe(64);
    expect(response.body.data.skippedCount).toBe(0);
    expect(response.body.data.dryRun).toBe(false);
    expect(response.body.data.rows[0]).toEqual({
      apartmentNumber: "A-101",
      floor: 1,
      wingId: null,
      status: "created",
    });
    expect(response.body.data.rows[63].apartmentNumber).toBe("B-804");

    // And the building really has them, in reading order.
    const list = await call("get", `/v1/buildings/${buildingA}/apartments`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(list.body.data.apartments).toHaveLength(64);
    expect(list.body.data.apartments[0].apartmentNumber).toBe("A-101");
  });

  it("dry run writes nothing — storage stays empty — and reports what would land", async () => {
    await seedViaApi({ apartmentNumber: "A-101" });

    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments/generate`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: {
          pattern: "{wing}-{floor}{unit:02d}",
          floors: [1],
          unitsPerFloor: 2,
          wings: [{ id: null, label: "A" }],
          dryRun: true,
        },
      },
    );

    expect(response.status).toBe(201);
    expect(response.body.data.dryRun).toBe(true);
    expect(response.body.data.createdCount).toBe(1);
    expect(response.body.data.skippedCount).toBe(1);
    expect(response.body.data.rows[0].status).toBe("skipped");
    // The preview wrote nothing: the only storage calls are the seed's create
    // and the one list read the dry run performed. (The building lookup lives on
    // the buildings fake, not here.)
    expect(apartments.state.calls).toEqual(["create", "listApartments"]);
    expect(apartments.state.apartments.size).toBe(1);
  });

  it("re-running skips the existing numbers and completes the building", async () => {
    await call("post", `/v1/buildings/${buildingA}/apartments/generate`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { ...generateBody, dryRun: false },
    });

    const again = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments/generate`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { ...generateBody, dryRun: false },
      },
    );

    expect(again.status).toBe(201);
    expect(again.body.data.createdCount).toBe(0);
    expect(again.body.data.skippedCount).toBe(64);
    expect(
      again.body.data.rows.every(
        (row: { status: string }) => row.status === "skipped",
      ),
    ).toBe(true);
  });

  it("refuses a batch over the 2,000 cap with a validation error", async () => {
    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments/generate`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: {
          pattern: "{floor}{unit:02d}",
          floors: Array.from({ length: 100 }, (_, index) => index + 1),
          unitsPerFloor: 200, // 20,000 > 2,000
          dryRun: false,
        },
      },
    );

    // The domain's arithmetic refusal, surfaced as 422 — the API never had to
    // carry the cap itself, because the domain owns the bound.
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.message).toContain("cap");
    expect(apartments.state.calls).toEqual([]);
  });

  it("refuses an unknown pattern token before anything is read", async () => {
    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments/generate`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: {
          pattern: "{wing}-{storey}{unit}",
          floors: [1],
          unitsPerFloor: 1,
          wings: [{ id: null, label: "A" }],
          dryRun: true,
        },
      },
    );

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("pattern");
    expect(apartments.state.calls).toEqual([]);
  });

  it("refuses a Treasurer with 403 and writes nothing", async () => {
    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments/generate`,
      {
        userId: TREASURER,
        societyId: SOCIETY_A,
        body: { ...generateBody, dryRun: false },
      },
    );

    expect(response.status).toBe(403);
    expect(apartments.state.calls).toEqual([]);
  });
});

describe("bulk create (T043)", () => {
  it("creates 64 flats in one call", async () => {
    const rows = Array.from({ length: 64 }, (_, index) => ({
      apartmentNumber: `F-${index + 101}`,
    }));

    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments/bulk`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { rows },
      },
    );

    expect(response.status).toBe(201);
    expect(response.body.data.total).toBe(64);
    expect(response.body.data.createdCount).toBe(64);
    expect(response.body.data.created[0]).toMatchObject({
      apartmentNumber: "F-101",
      parkingSlots: 0,
      shareUnits: 1,
      occupancyStatus: "vacant",
      isBillable: true,
    });
    expect(apartments.state.calls).toContain("createMany");
  });

  it("reports duplicates per row and creates the rest, not silently", async () => {
    const rows = Array.from({ length: 67 }, (_, index) => ({
      apartmentNumber: `D-${index + 1}`,
    }));
    rows.push({ apartmentNumber: "D-1" });
    rows.push({ apartmentNumber: "D-2" });
    rows.push({ apartmentNumber: "D-3" });

    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments/bulk`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { rows },
      },
    );

    expect(response.status).toBe(201);
    expect(response.body.data.total).toBe(70);
    expect(response.body.data.duplicateCount).toBe(3);
    expect(response.body.data.createdCount).toBe(67);
    expect(
      response.body.data.outcomes.filter(
        (outcome: { status: string }) => outcome.status === "duplicate",
      ),
    ).toEqual([
      { apartmentNumber: "D-1", status: "duplicate" },
      { apartmentNumber: "D-2", status: "duplicate" },
      { apartmentNumber: "D-3", status: "duplicate" },
    ]);
  });

  it("reports rows a live flat already carries as existing", async () => {
    await seedViaApi({ apartmentNumber: "E-1" });

    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments/bulk`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: {
          rows: [{ apartmentNumber: "E-1" }, { apartmentNumber: "E-2" }],
        },
      },
    );

    expect(response.status).toBe(201);
    expect(response.body.data.existingCount).toBe(1);
    expect(response.body.data.createdCount).toBe(1);
    expect(response.body.data.outcomes).toEqual([
      { apartmentNumber: "E-1", status: "existing" },
      { apartmentNumber: "E-2", status: "created" },
    ]);
  });

  it("sets per-row areas, BHK, parking, share units and occupancy", async () => {
    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments/bulk`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: {
          rows: [
            {
              apartmentNumber: "S-1",
              floor: 2,
              bhk: 3,
              carpetAreaSqft: 900,
              builtupAreaSqft: 1100,
              parkingSlots: 1,
              shareUnits: 2,
              occupancyStatus: "rented",
            },
          ],
        },
      },
    );

    expect(response.status).toBe(201);
    expect(response.body.data.created[0]).toMatchObject({
      apartmentNumber: "S-1",
      floor: 2,
      bhk: 3,
      carpetAreaSqft: 900,
      builtupAreaSqft: 1100,
      parkingSlots: 1,
      shareUnits: 2,
      occupancyStatus: "rented",
    });
  });

  it("reports an invalid row with its field while the batch continues", async () => {
    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments/bulk`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: {
          rows: [
            { apartmentNumber: "V-1" },
            // A value the contract accepts (it bounds the range) but the domain's
            // value object refuses (not a half step) — the one place a row can be
            // invalid *after* the edge, which is exactly what the per-row report
            // exists to carry.
            { apartmentNumber: "V-2", bhk: 1.25 },
          ],
        },
      },
    );

    expect(response.status).toBe(201);
    expect(response.body.data.invalidCount).toBe(1);
    expect(response.body.data.createdCount).toBe(1);
    expect(response.body.data.outcomes).toEqual([
      { apartmentNumber: "V-1", status: "created" },
      {
        apartmentNumber: "V-2",
        status: "invalid",
        field: "bhk",
        message: expect.stringContaining("Configuration"),
      },
    ]);
  });

  it("refuses an empty batch at the edge", async () => {
    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments/bulk`,
      {
        userId: ADMIN,
        societyId: SOCIETY_A,
        body: { rows: [] },
      },
    );

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(apartments.state.calls).toEqual([]);
  });

  it("refuses a Resident with 403 and writes nothing", async () => {
    const response = await call(
      "post",
      `/v1/buildings/${buildingA}/apartments/bulk`,
      {
        userId: RESIDENT,
        societyId: SOCIETY_A,
        body: { rows: [{ apartmentNumber: "R-1" }] },
      },
    );

    expect(response.status).toBe(403);
    expect(apartments.state.calls).toEqual([]);
  });
});

describe("deleting a building that still has flats", () => {
  it("refuses with a typed code rather than a raw failure", async () => {
    await seedViaApi();
    await seedViaApi({ apartmentNumber: "A-102" });

    const response = await call("delete", `/v1/buildings/${buildingA}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
    // The code that lets a client tell "empty it first" from "rename it" without
    // matching on message text.
    expect(response.body.error.details?.[0]?.code).toBe(
      "BUILDING_HAS_APARTMENTS",
    );
    expect(response.body.error.message).toContain("2 flats");
    // The refusal is a rule, not an explanation of a failed write: nothing was
    // deleted, so the building is still readable.
    expect(buildings.state.buildings.get(buildingA)?.deletedAt).toBeNull();
  });

  it("allows it once the flats are gone", async () => {
    const apartment = await seedViaApi();
    await call("delete", `/v1/apartments/${apartment.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    const response = await call("delete", `/v1/buildings/${buildingA}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(204);
  });

  it("allows it for a building that never had any", async () => {
    const response = await call("delete", `/v1/buildings/${buildingA}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(204);
  });
});
