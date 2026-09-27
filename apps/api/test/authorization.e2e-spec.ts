import { Controller, Get } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asMemberId, asSocietyId, asUserId } from "@ses/domain";
import type {
  MemberRole,
  MembershipStatus,
  Society,
  SocietyId,
  SocietyMembership,
  UserId,
} from "@ses/domain";
import request from "supertest";

import type { SocietyAuthorizationContext } from "../src/common/authorization/society-authorization";
import { Ctx, type RequestCtx } from "../src/common/decorators/ctx.decorator";
import { RequirePermission } from "../src/common/decorators/require-permission.decorator";
import { createTestAuth, type TestAuth } from "./utils/supabase-auth";
import { createTestApp } from "./utils/test-app";

/**
 * The guard chain over real HTTP (Roadmap T038).
 *
 * ## Why a probe controller
 *
 * Every route this chain will protect belongs to a module that does not exist yet
 * (expenses, payments, cycles) — the committed society routes are addressed by a
 * `:societyId` path parameter and have no `X-Society-Id` header to resolve. So
 * rather than invent a production endpoint or relax a guard to make it reachable,
 * this suite mounts a throwaway controller and lets the **global** guards govern
 * it. That also tests the property that matters most: a route registered here opts
 * into nothing, and is still subject to the chain because the chain is global.
 *
 * What runs for real: the auth guard and the JWT verifier (against a locally held
 * key pair), the society guard, the permission guard, the response envelope, the
 * exception filter and both mappers.
 *
 * What does not: RLS. The membership read is stubbed, so nothing here evaluates a
 * policy — a mistake in the committed SQL is invisible to this suite, and is
 * covered by the RLS canary instead.
 */

const SOCIETY_ID = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const OTHER_SOCIETY_ID = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

const ADMIN: UserId = asUserId("11111111-1111-4111-8111-111111111111");
const TREASURER: UserId = asUserId("22222222-2222-4222-8222-222222222222");
const RESIDENT: UserId = asUserId("33333333-3333-4333-8333-333333333333");
const GUEST: UserId = asUserId("44444444-4444-4444-8444-444444444444");
const PENDING: UserId = asUserId("55555555-5555-4555-8555-555555555555");
const OUTSIDER: UserId = asUserId("66666666-6666-4666-8666-666666666666");

const SOCIETY = {
  id: SOCIETY_ID,
  name: "Green Meadows",
  city: "Pune",
} as unknown as Society;

/**
 * The route under test. Three shapes, because the chain's behaviour depends on
 * which metadata a route carries:
 *
 *  - `open`  — no permission, so both guards are inert and the request must work
 *              with no header at all (the property that makes a global chain
 *              safe);
 *  - `edit`  — a full grant, Admin-only in the PRD;
 *  - `gate`  — a grant held by Admin and Guest, which is how a role with almost
 *              nothing still has something.
 */
@Controller("probe")
class ProbeController {
  @Get("open")
  open(): { readonly ok: boolean } {
    return { ok: true };
  }

  @Get("edit")
  @RequirePermission("society.edit")
  edit(@Ctx() ctx: RequestCtx): {
    readonly societyId: string | undefined;
    readonly role: string | undefined;
  } {
    return { societyId: ctx.society?.id, role: ctx.membership?.role };
  }

  @Get("gate")
  @RequirePermission("visitor.log")
  gate(): { readonly ok: boolean } {
    return { ok: true };
  }
}

function membershipOf(
  actor: UserId,
  role: MemberRole,
  status: MembershipStatus = "active",
  societyId: SocietyId = SOCIETY_ID,
): SocietyMembership {
  return {
    id: asMemberId("00000000-0000-4000-8000-000000000001"),
    societyId,
    userId: actor,
    role,
    status,
    occupancyType: "owner",
    joinedAt: "2026-01-01T00:00:00.000Z",
  };
}

let app: NestFastifyApplication;
let auth: TestAuth;

/** (society, actor) → membership, so a wrong society resolves to nothing. */
const memberships = new Map<string, SocietyMembership>();
const reads: string[] = [];

const key = (societyId: string, actor: string) => `${societyId}:${actor}`;

const reader = {
  load(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyAuthorizationContext | null> {
    reads.push(key(societyId, actor));
    const membership = memberships.get(key(societyId, actor));
    return Promise.resolve(
      membership === undefined ? null : { society: SOCIETY, membership },
    );
  },
};

beforeAll(async () => {
  auth = await createTestAuth();
  app = await createTestApp({
    jwks: auth.jwks,
    reader,
    controllers: [ProbeController],
  });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  memberships.clear();
  reads.length = 0;
  memberships.set(key(SOCIETY_ID, ADMIN), membershipOf(ADMIN, "admin"));
  memberships.set(
    key(SOCIETY_ID, TREASURER),
    membershipOf(TREASURER, "treasurer"),
  );
  memberships.set(
    key(SOCIETY_ID, RESIDENT),
    membershipOf(RESIDENT, "resident"),
  );
  memberships.set(key(SOCIETY_ID, GUEST), membershipOf(GUEST, "guest"));
  memberships.set(
    key(SOCIETY_ID, PENDING),
    membershipOf(PENDING, "resident", "pending"),
  );
});

const server = () => request(app.getHttpServer());
const tokenFor = (userId: UserId) => auth.token(userId);

async function get(path: string, userId?: UserId, societyId?: string) {
  let call = server().get(`/v1/probe/${path}`);
  if (userId !== undefined) {
    call = call.set("Authorization", `Bearer ${await tokenFor(userId)}`);
  }
  if (societyId !== undefined) {
    call = call.set("X-Society-Id", societyId);
  }
  return call;
}

describe("the chain leaves unguarded routes alone", () => {
  it("serves a route with no permission without a society header", async () => {
    // Still authenticated — the auth guard is global and fail-closed, and this
    // route opts out of nothing. What it must *not* need is a society context.
    const response = await get("open", ADMIN);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ ok: true });
    // Neither guard read anything: the chain is inert without metadata.
    expect(reads).toEqual([]);
  });

  it("is still authenticated — the chain did not weaken the auth guard", async () => {
    const response = await get("open");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });
});

describe("SocietyGuard — stage 3", () => {
  it("requires a session before anything else", async () => {
    const response = await get("edit", undefined, SOCIETY_ID);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
    expect(reads).toEqual([]);
  });

  it("rejects a missing X-Society-Id with 400", async () => {
    const response = await get("edit", ADMIN);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("x-society-id");
    // No header, no lookup — the guard must not guess a society.
    expect(reads).toEqual([]);
  });

  it("rejects a malformed X-Society-Id with 400 and never queries", async () => {
    const response = await get("edit", ADMIN, "not-a-uuid");

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe("Invalid Society Id.");
    expect(reads).toEqual([]);
  });

  it("answers 404 — not 403 — for a society the caller is not in", async () => {
    // SAD §7.2 and PRD T041: the same answer as a society that does not exist, so
    // a caller cannot enumerate ids they have no access to.
    const response = await get("edit", OUTSIDER, SOCIETY_ID);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("answers 404 identically when the header names a different society", async () => {
    const other = await get("edit", ADMIN, OTHER_SOCIETY_ID);
    const missing = await get("edit", OUTSIDER, SOCIETY_ID);

    expect(other.status).toBe(404);
    // Byte-identical to the "not a member" answer, which is the point.
    expect(other.body.error.code).toBe(missing.body.error.code);
    expect(other.body.error.message).toBe(missing.body.error.message);
  });

  it("resolves once per request", async () => {
    await get("edit", ADMIN, SOCIETY_ID);

    expect(reads).toHaveLength(1);
  });
});

describe("PermissionGuard — stage 4", () => {
  it("allows an Admin and tells the handler who they are", async () => {
    const response = await get("edit", ADMIN, SOCIETY_ID);

    expect(response.status).toBe(200);
    // The handler reads the resolved context, which also proves the order: the
    // permission guard could not have allowed this without stage 3 having run.
    expect(response.body.data).toEqual({
      societyId: SOCIETY_ID,
      role: "admin",
    });
  });

  it("refuses a Resident with 403", async () => {
    const response = await get("edit", RESIDENT, SOCIETY_ID);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toContain("society.edit");
  });

  it("refuses a Treasurer an Admin-only action", async () => {
    const response = await get("edit", TREASURER, SOCIETY_ID);

    expect(response.status).toBe(403);
  });

  it("lets a Guest reach the one action their role holds", async () => {
    const allowed = await get("gate", GUEST, SOCIETY_ID);
    expect(allowed.status).toBe(200);

    const denied = await get("edit", GUEST, SOCIETY_ID);
    expect(denied.status).toBe(403);
  });

  it("lets an Admin through the same route a Guest may use", async () => {
    const response = await get("gate", ADMIN, SOCIETY_ID);
    expect(response.status).toBe(200);
  });

  it("answers MEMBER_INACTIVE for a pending membership", async () => {
    const response = await get("edit", PENDING, SOCIETY_ID);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("MEMBER_INACTIVE");
  });

  it("does not leak the caller's role in a refusal", async () => {
    const response = await get("edit", RESIDENT, SOCIETY_ID);

    expect(JSON.stringify(response.body)).not.toContain("resident");
  });
});

describe("every refusal carries the SAD §7.10 envelope", () => {
  it("shapes 400, 401, 403 and 404 the same way", async () => {
    const responses = [
      await get("edit", ADMIN),
      await get("edit", undefined, SOCIETY_ID),
      await get("edit", RESIDENT, SOCIETY_ID),
      await get("edit", OUTSIDER, SOCIETY_ID),
    ];

    expect(responses.map((r) => r.status)).toEqual([400, 401, 403, 404]);
    for (const response of responses) {
      expect(response.body.error.code).toBeDefined();
      expect(response.body.error.message).toBeTruthy();
      // A failure carries its request id *inside* `error` — the `meta` object
      // belongs to the success envelope (`errorBodySchema`).
      expect(response.body.error.requestId).toBe(
        response.headers["x-request-id"],
      );
    }
  });

  it("correlates a guard refusal with the access log's request id", async () => {
    const response = await get("edit", RESIDENT, SOCIETY_ID);

    expect(response.body.error.requestId).toMatch(/[0-9a-f-]{36}/);
    expect(response.body.error.requestId).toBe(
      response.headers["x-request-id"],
    );
  });
});
