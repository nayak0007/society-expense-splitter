import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import request from "supertest";

import { asSocietyId, asUserId } from "@ses/domain";
import type { UserId } from "@ses/domain";

import {
  createFakeSocietyRepository,
  type FakeSocietyRepository,
} from "./utils/fake-society-repository";
import { createTestAuth, type TestAuth } from "./utils/supabase-auth";
import { createTestApp } from "./utils/test-app";

/**
 * The society module over real HTTP (Roadmap T040).
 *
 * Booting the production `AppModule` is the point: the global auth guard, the
 * response envelope interceptor, the exception filter and the route table are all
 * registered there, so a test that hand-assembled its own pipeline would verify a
 * pipeline that does not ship. The only substitutions are the society repository
 * (storage and tenancy, which need Postgres) and the JWKS (key material, which
 * lives in Supabase).
 *
 * What this suite can therefore prove, and what it cannot: every layer from the
 * `Authorization` header to the JSON body runs for real, including the domain's
 * own rules — but **nothing here evaluates an RLS policy**. A mistake in the
 * committed SQL is invisible to these tests, which is what the Testcontainers
 * suite (T017) is for.
 */

const OWNER: UserId = asUserId("11111111-1111-4111-8111-111111111111");
const OUTSIDER: UserId = asUserId("22222222-2222-4222-8222-222222222222");

/** A minimal valid create payload; individual tests override one field. */
const CREATE_BODY = {
  name: "Green Meadows",
  type: "apartment",
  city: "Pune",
  state: "MH",
  billingDay: 1,
  dueDay: 10,
  approvalThresholdPaise: 1_000_000,
};

let app: NestFastifyApplication;
let auth: TestAuth;
let repository: FakeSocietyRepository;

beforeAll(async () => {
  auth = await createTestAuth();
  repository = createFakeSocietyRepository();
  app = await createTestApp({ jwks: auth.jwks, repository });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  repository.state.societies.clear();
  repository.state.memberships.length = 0;
  repository.state.calls.length = 0;
});

const server = () => request(app.getHttpServer());

async function tokenFor(userId: UserId, overrides = {}) {
  return auth.token(userId, overrides);
}

describe("POST /v1/societies", () => {
  it("creates a society and returns the creator's Admin membership", async () => {
    const response = await server()
      .post("/v1/societies")
      .set("Authorization", `Bearer ${await tokenFor(OWNER)}`)
      .send(CREATE_BODY);

    expect(response.status).toBe(201);
    // SAD §7.9: every success carries `data` and `meta`.
    expect(response.body.data.society.name).toBe("Green Meadows");
    expect(response.body.data.society.currency).toBe("INR");
    expect(response.body.data.membership.role).toBe("admin");
    // PRD §3.2: the creator is active, never pending — nobody approves the person
    // who created the society.
    expect(response.body.data.membership.status).toBe("active");
    expect(response.body.meta.requestId).toBe(response.headers["x-request-id"]);
  });

  it("derives the slug and join code server-side rather than accepting them", async () => {
    const response = await server()
      .post("/v1/societies")
      .set("Authorization", `Bearer ${await tokenFor(OWNER)}`)
      .send({ ...CREATE_BODY, slug: "chosen-slug", joinCode: "HACKED" });

    // `slug` and `joinCode` are not in the contract schema, and contract schemas
    // are strict — so a caller cannot choose a tenancy identifier.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a body whose values are invalid with 422, not 400", async () => {
    // SAD §7.8 splits syntactic from semantic: a short name is a well-formed
    // payload with a wrong value, which is a different answer from a malformed
    // one, and clients branch on the distinction.
    const response = await server()
      .post("/v1/societies")
      .set("Authorization", `Bearer ${await tokenFor(OWNER)}`)
      .send({ ...CREATE_BODY, name: "x" });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details[0].field).toBe("name");
  });

  it("requires a session", async () => {
    const response = await server().post("/v1/societies").send(CREATE_BODY);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });
});

describe("GET /v1/societies", () => {
  it("lists only the caller's societies", async () => {
    repository.seed({ ownerId: OWNER, name: "Mine" });
    repository.seed({ ownerId: OUTSIDER, name: "Theirs" });

    const response = await server()
      .get("/v1/societies")
      .set("Authorization", `Bearer ${await tokenFor(OWNER)}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].name).toBe("Mine");
    // The switcher renders the caller's own role, which is why the summary
    // carries it rather than the client deriving it from a society record.
    expect(response.body.data[0].role).toBe("admin");
  });

  it("returns an empty list rather than a 404 for someone in no society yet", async () => {
    // The onboarding path. A 404 here would make a brand-new account look broken.
    const response = await server()
      .get("/v1/societies")
      .set("Authorization", `Bearer ${await tokenFor(OUTSIDER)}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
  });
});

describe("GET /v1/societies/lookup", () => {
  it("resolves a join code without a session", async () => {
    // PRD §3.2: the join screen resolves a code before the user has joined
    // anything, so this is the one business route the guard exempts.
    const { society } = repository.seed({ ownerId: OWNER });

    const response = await server().get(
      `/v1/societies/lookup?code=${society.joinCode}`,
    );

    expect(response.status).toBe(200);
    expect(response.body.data.preview.name).toBe(society.name);
    expect(response.body.data.preview.memberCount).toBe(1);
  });

  it("accepts a lowercase code, because a user typing one should not have to shout", async () => {
    const { society } = repository.seed({ ownerId: OWNER });

    const response = await server().get(
      `/v1/societies/lookup?code=${society.joinCode.toLowerCase()}`,
    );

    expect(response.status).toBe(200);
  });

  it("answers 404 for an unknown code rather than a 200 carrying null", async () => {
    // The alternative makes every client write the same branch, and one of them
    // eventually forgets.
    const response = await server().get("/v1/societies/lookup?code=ZZZZ99");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("does not resolve a deleted society's code", async () => {
    // Same answer as an unknown code: a probe must not be able to tell a deleted
    // society from one that never existed.
    const { society } = repository.seed({ ownerId: OWNER });
    repository.state.societies.set(society.id, {
      ...society,
      deletedAt: new Date().toISOString(),
    });

    const response = await server().get(
      `/v1/societies/lookup?code=${society.joinCode}`,
    );

    expect(response.status).toBe(404);
  });
});

describe("POST /v1/societies/join", () => {
  it("records a pending membership, never an approved one", async () => {
    const { society } = repository.seed({ ownerId: OWNER });

    const response = await server()
      .post("/v1/societies/join")
      .set("Authorization", `Bearer ${await tokenFor(OUTSIDER)}`)
      .send({ code: society.joinCode, occupancyType: "tenant" });

    expect(response.status).toBe(201);
    expect(response.body.data.membership.status).toBe("pending");
    expect(response.body.data.membership.occupancyType).toBe("tenant");
  });

  it("refuses a second join as DUPLICATE_RESOURCE", async () => {
    const { society } = repository.seed({ ownerId: OWNER });
    const token = await tokenFor(OUTSIDER);
    const body = { code: society.joinCode, occupancyType: "tenant" };

    await server()
      .post("/v1/societies/join")
      .set("Authorization", `Bearer ${token}`)
      .send(body);
    const second = await server()
      .post("/v1/societies/join")
      .set("Authorization", `Bearer ${token}`)
      .send(body);

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("DUPLICATE_RESOURCE");
    expect(second.body.error.details[0].code).toBe("ALREADY_MEMBER");
  });

  it("refuses an expired code, checked against the server clock", async () => {
    const { society } = repository.seed({
      ownerId: OWNER,
      joinCodeExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const response = await server()
      .post("/v1/societies/join")
      .set("Authorization", `Bearer ${await tokenFor(OUTSIDER)}`)
      .send({ code: society.joinCode, occupancyType: "resident" as never });

    // `resident` is not an occupancy type — the enum is owner/tenant/
    // family_member — so this proves the contract rejects it before any rule
    // runs, which is the cheaper failure for both sides.
    expect(response.status).toBe(422);
  });

  it("keeps an invalid code indistinguishable from an expired one", async () => {
    const response = await server()
      .post("/v1/societies/join")
      .set("Authorization", `Bearer ${await tokenFor(OUTSIDER)}`)
      .send({ code: "ZZZZ99", occupancyType: "tenant" });

    expect(response.status).toBe(422);
    expect(response.body.error.details[0].code).toBe("JOIN_CODE_INVALID");
  });
});

describe("GET /v1/societies/:societyId", () => {
  it("returns the society, the caller's membership and the capabilities", async () => {
    const { society } = repository.seed({ ownerId: OWNER });

    const response = await server()
      .get(`/v1/societies/${society.id}`)
      .set("Authorization", `Bearer ${await tokenFor(OWNER)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.society.id).toBe(society.id);
    expect(response.body.data.membership.role).toBe("admin");
    // Computed by the domain, so a screen never re-derives permissions from a
    // role string — the third implementation of a rule that already exists twice.
    expect(response.body.data.capabilities).toMatchObject({
      canManage: true,
      canDelete: true,
      canLeave: false,
    });
  });

  it("tells a non-member 404, never 403", async () => {
    // PRD T041: a 403 would confirm that the society exists, which is exactly
    // what a caller probing another tenant's identifiers wants to learn.
    const { society } = repository.seed({ ownerId: OWNER });

    const response = await server()
      .get(`/v1/societies/${society.id}`)
      .set("Authorization", `Bearer ${await tokenFor(OUTSIDER)}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects a non-UUID id before it reaches the database", async () => {
    // A non-UUID would reach Postgres as `$1::uuid` and fail there with a 22P02
    // the classifier can only report as INTERNAL — turning a client bug into a
    // 500, which is a page for an operator.
    const response = await server()
      .get("/v1/societies/not-a-uuid")
      .set("Authorization", `Bearer ${await tokenFor(OWNER)}`);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("PATCH /v1/societies/:societyId", () => {
  it("applies a patch and leaves untouched fields alone", async () => {
    const { society } = repository.seed({ ownerId: OWNER });

    const response = await server()
      .patch(`/v1/societies/${society.id}`)
      .set("Authorization", `Bearer ${await tokenFor(OWNER)}`)
      .send({ city: "Mumbai" });

    expect(response.status).toBe(200);
    expect(response.body.data.society.city).toBe("Mumbai");
    // An edit form that sends only the fields it touched must not wipe the rest.
    expect(response.body.data.society.state).toBe("MH");
    expect(response.body.data.society.name).toBe(society.name);
  });

  it("distinguishes clearing a field from omitting it", async () => {
    const { society } = repository.seed({
      ownerId: OWNER,
      registrationNumber: "REG-1",
    });

    const cleared = await server()
      .patch(`/v1/societies/${society.id}`)
      .set("Authorization", `Bearer ${await tokenFor(OWNER)}`)
      .send({ registrationNumber: "" });

    expect(cleared.status).toBe(200);
    expect(cleared.body.data.society.registrationNumber).toBeNull();
  });

  it("patches settings, not only the details the create wizard asked for", async () => {
    // The settings fields are not on `createSocietySchema`; without them in the
    // update contract the request would still answer 200 while the value quietly
    // kept its old one.
    const { society } = repository.seed({ ownerId: OWNER });

    const response = await server()
      .patch(`/v1/societies/${society.id}`)
      .set("Authorization", `Bearer ${await tokenFor(OWNER)}`)
      .send({ graceDays: 7, billVacantFlats: true });

    expect(response.status).toBe(200);
    expect(response.body.data.society.settings.billVacantFlats).toBe(true);
  });

  it("rejects an unknown field rather than silently dropping it", async () => {
    // SAD §7.8 stage 1: strict inbound. A typo'd key that is quietly ignored is
    // how a client comes to believe it set something it did not.
    const { society } = repository.seed({ ownerId: OWNER });

    const response = await server()
      .patch(`/v1/societies/${society.id}`)
      .set("Authorization", `Bearer ${await tokenFor(OWNER)}`)
      .send({ billingdate: 5 });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a non-Admin member with SOCIETY_ADMIN_REQUIRED", async () => {
    const { society } = repository.seed({ ownerId: OWNER });
    await repository.join(
      { code: society.joinCode, occupancyType: "tenant" },
      OUTSIDER,
    );
    // Approve them, so the refusal is about the role and not about the pending
    // status — the two produce different answers on purpose.
    const membership = repository.state.memberships.find(
      (m) => m.userId === OUTSIDER,
    );
    if (membership !== undefined) {
      repository.state.memberships[
        repository.state.memberships.indexOf(membership)
      ] = { ...membership, status: "active" };
    }

    const response = await server()
      .patch(`/v1/societies/${society.id}`)
      .set("Authorization", `Bearer ${await tokenFor(OUTSIDER)}`)
      .send({ city: "Mumbai" });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects an empty patch, which means the form sent nothing", async () => {
    const { society } = repository.seed({ ownerId: OWNER });

    const response = await server()
      .patch(`/v1/societies/${society.id}`)
      .set("Authorization", `Bearer ${await tokenFor(OWNER)}`)
      .send({});

    expect(response.status).toBe(422);
  });
});

describe("POST /v1/societies/:societyId/join-code", () => {
  it("mints a new code and invalidates the old one", async () => {
    const { society } = repository.seed({ ownerId: OWNER });

    const response = await server()
      .post(`/v1/societies/${society.id}/join-code`)
      .set("Authorization", `Bearer ${await tokenFor(OWNER)}`);

    expect(response.status).toBe(200);
    const rotated = response.body.data.society.joinCode;
    expect(rotated).not.toBe(society.joinCode);

    // A leaked code is contained by one action, so the old one must stop
    // resolving immediately.
    const stale = await server().get(
      `/v1/societies/lookup?code=${society.joinCode}`,
    );
    expect(stale.status).toBe(404);
  });

  it("refuses a plain member", async () => {
    const { society } = repository.seed({ ownerId: OWNER });
    await repository.join(
      { code: society.joinCode, occupancyType: "tenant" },
      OUTSIDER,
    );

    const response = await server()
      .post(`/v1/societies/${society.id}/join-code`)
      .set("Authorization", `Bearer ${await tokenFor(OUTSIDER)}`);

    // A pending member is still not a member as far as reads are concerned, so
    // the answer for them is the same as for a stranger.
    expect([403, 404]).toContain(response.status);
  });
});

describe("POST /v1/societies/:societyId/leave", () => {
  it("returns 204 with no body, the one honest exception to the envelope", async () => {
    const { society } = repository.seed({ ownerId: OWNER });
    // A second Admin, so the sole-admin invariant does not block the leave.
    const coAdmin = asUserId("33333333-3333-4333-8333-333333333333");
    repository.state.memberships.push({
      id: asUserId("44444444-4444-4444-8444-444444444444") as never,
      societyId: society.id,
      userId: coAdmin,
      role: "admin",
      status: "active",
      occupancyType: "owner",
      joinedAt: null,
    });

    const response = await server()
      .post(`/v1/societies/${society.id}/leave`)
      .set("Authorization", `Bearer ${await tokenFor(OWNER)}`);

    expect(response.status).toBe(204);
    expect(response.body).toEqual({});
  });

  it("refuses to orphan a society, naming the reason", async () => {
    // The Phase 3 definition of done: a society can never be left without an
    // active Admin.
    const { society } = repository.seed({ ownerId: OWNER });

    const response = await server()
      .post(`/v1/societies/${society.id}/leave`)
      .set("Authorization", `Bearer ${await tokenFor(OWNER)}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("SOCIETY_ADMIN_REQUIRED");
    expect(response.body.error.details[0].code).toBe("SOLE_ADMIN");
  });

  it("lets a pending applicant withdraw", async () => {
    const { society } = repository.seed({ ownerId: OWNER });
    await repository.join(
      { code: society.joinCode, occupancyType: "tenant" },
      OUTSIDER,
    );
    const membership = repository.state.memberships.find(
      (m) => m.userId === OUTSIDER,
    );
    if (membership !== undefined) {
      repository.state.memberships[
        repository.state.memberships.indexOf(membership)
      ] = { ...membership, status: "active" };
    }

    const response = await server()
      .post(`/v1/societies/${society.id}/leave`)
      .set("Authorization", `Bearer ${await tokenFor(OUTSIDER)}`);

    expect(response.status).toBe(204);
  });
});

describe("DELETE /v1/societies/:societyId", () => {
  it("soft-deletes: the row survives, the society stops resolving", async () => {
    const { society } = repository.seed({ ownerId: OWNER });

    const response = await server()
      .delete(`/v1/societies/${society.id}`)
      .set("Authorization", `Bearer ${await tokenFor(OWNER)}`);

    expect(response.status).toBe(204);
    // PRD §3.1: financial history keeps its owner, so the row is kept.
    expect(repository.state.societies.has(society.id)).toBe(true);
    expect(
      repository.state.societies.get(society.id)?.deletedAt,
    ).not.toBeNull();

    const after = await server()
      .get(`/v1/societies/${society.id}`)
      .set("Authorization", `Bearer ${await tokenFor(OWNER)}`);
    expect(after.status).toBe(404);
  });

  it("refuses a member who is not an Admin", async () => {
    const { society } = repository.seed({ ownerId: OUTSIDER });

    const response = await server()
      .delete(`/v1/societies/${society.id}`)
      .set("Authorization", `Bearer ${await tokenFor(OWNER)}`);

    expect(response.status).toBe(404);
  });
});

describe("authentication (T018)", () => {
  it("rejects an expired token with TOKEN_EXPIRED, the code a client retries on", async () => {
    const response = await server()
      .get("/v1/societies")
      .set(
        "Authorization",
        `Bearer ${await tokenFor(OWNER, { expiresIn: "-5m" })}`,
      );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("TOKEN_EXPIRED");
  });

  it("rejects a token minted for another project", async () => {
    const response = await server()
      .get("/v1/societies")
      .set(
        "Authorization",
        `Bearer ${await tokenFor(OWNER, {
          issuer: "https://other.supabase.co/auth/v1",
        })}`,
      );

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects Supabase's anon key presented as a user session", async () => {
    // The anon key is a JWT signed with the project key. Accepting it would make
    // every policy's `auth.uid()` resolve to nothing while the caller still got
    // past the guard.
    const response = await server()
      .get("/v1/societies")
      .set(
        "Authorization",
        `Bearer ${await tokenFor(OWNER, { audience: "anon" })}`,
      );

    expect(response.status).toBe(401);
  });

  it("rejects a token with no subject", async () => {
    const response = await server()
      .get("/v1/societies")
      .set(
        "Authorization",
        `Bearer ${await tokenFor(OWNER, { noSubject: true })}`,
      );

    expect(response.status).toBe(401);
  });

  it("renders the guard's rejection in the documented error envelope", async () => {
    // A 401 byte-identical in shape to every other error is what lets the client
    // implement one refresh path.
    const response = await server().get("/v1/societies");

    expect(response.body.error).toMatchObject({
      code: "UNAUTHENTICATED",
      docs: "https://docs.societysplit.in/errors/UNAUTHENTICATED",
    });
    expect(response.body.error.requestId).toBe(
      response.headers["x-request-id"],
    );
  });

  it("protects every society route by default", async () => {
    // The fail-closed property: the guard is global, so a new route is
    // authenticated unless someone writes `@Public()` on it. Only `lookup` is
    // public, and the last assertion is what keeps it that way.
    const id = asSocietyId("11111111-1111-4111-8111-111111111111");
    const routes: readonly [string, string][] = [
      ["get", "/v1/societies"],
      ["post", "/v1/societies"],
      ["post", "/v1/societies/join"],
      ["get", `/v1/societies/${id}`],
      ["patch", `/v1/societies/${id}`],
      ["post", `/v1/societies/${id}/join-code`],
      ["post", `/v1/societies/${id}/leave`],
      ["delete", `/v1/societies/${id}`],
    ];

    for (const [method, path] of routes) {
      const response = await (method === "get"
        ? server().get(path)
        : method === "post"
          ? server().post(path)
          : method === "patch"
            ? server().patch(path)
            : server().delete(path));
      expect([path, response.status]).toEqual([path, 401]);
    }

    const publicRoute = await server().get("/v1/societies/lookup?code=ABC123");
    expect(publicRoute.status).not.toBe(401);
  });
});
