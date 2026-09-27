import { randomUUID } from "node:crypto";

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
import {
  createFakeMemberRepository,
  type FakeMemberRepository,
} from "./utils/fake-member-repository";
import {
  createFakeSocietyRepository,
  type FakeSocietyRepository,
} from "./utils/fake-society-repository";
import { createTestAuth, type TestAuth } from "./utils/supabase-auth";
import { createTestApp } from "./utils/test-app";

/**
 * The join-request routes over real HTTP (Roadmap T049).
 *
 * ## What runs for real
 *
 * The whole guard chain — a real signature verified against a locally held key pair,
 * `SocietyGuard` resolving `X-Society-Id`, `PermissionGuard` asking the domain's matrix — plus the
 * Zod pipes parsing the real contracts (`joinRequestListQuerySchema`, `approveJoinRequestSchema`,
 * `rejectJoinRequestSchema`), the real use cases, the real mappers with their output parse, the
 * response envelope and the exception filter.
 *
 * ## What does not
 *
 * Storage and RLS. The member repository is a fake, so no policy is evaluated, no trigger fires
 * and no row is locked; `scripts/db/rls-canary.sql` section 10 covers exactly those (the narrowed
 * self-insert, the per-society unique key, the reviewer resolution, the single-use decision, the
 * second primary claim). The fake reproduces the *facts* the SQL produces — the queue's shape,
 * the claims set, the `uq_primary_occupant` collision — so the suite can prove the transport and
 * the use cases without pretending to prove the database.
 *
 * ## The four things this suite is for
 *
 *  1. **The grant split.** The queue and both decisions are `member.approve` (Admin **and**
 *     Treasurer) where the directory is `member.view`; a Resident is refused before storage, a
 *     pending member is `MEMBER_INACTIVE` at the guard, and a non-member gets `404`, never `403`.
 *  2. **The refusals the guard cannot see**: a Treasurer admitting at a role above Resident, a
 *     reviewer deciding their own request, a request that was already decided, and primacy asked
 *     for with no flat. Each carries the `DETAIL_CODES` value its screen branches on.
 *  3. **"Both claims visible"** — the queue returns `claims` for the contested flat, and the
 *     second primary claim is refused as a `409` rather than auto-rejected at request time.
 *  4. **Cross-society denial** on a member id, answering `404` and never `403` (PRD T041).
 */

const SOCIETY_A = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const SOCIETY_B = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

const ADMIN: UserId = asUserId("11111111-1111-4111-8111-111111111111");
const TREASURER: UserId = asUserId("22222222-2222-4222-8222-222222222222");
const RESIDENT: UserId = asUserId("33333333-3333-4333-8333-333333333333");
const GUEST: UserId = asUserId("44444444-4444-4444-8444-444444444444");
const PENDING: UserId = asUserId("55555555-5555-4555-8555-555555555555");
const OUTSIDER: UserId = asUserId("66666666-6666-4666-8666-666666666666");

const M_ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";
const M_TREASURER = "aaaaaaaa-0000-4000-8000-000000000002";
const M_RESIDENT = "aaaaaaaa-0000-4000-8000-000000000003";
const M_PENDING_OWNER = "aaaaaaaa-0000-4000-8000-000000000005";
const M_PENDING_TENANT = "aaaaaaaa-0000-4000-8000-000000000006";
const M_FLATLESS = "aaaaaaaa-0000-4000-8000-000000000007";
const M_SELF = "aaaaaaaa-0000-4000-8000-000000000008";
const M_FOREIGN = "aaaaaaaa-0000-4000-8000-000000000009";

const FLAT_A = "cccccccc-0000-4000-8000-000000000101";
/** A non-UUID path parameter, for the validation case. */
const NOT_A_UUID = "not-a-uuid";

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

let app: NestFastifyApplication;
let auth: TestAuth;
let members: FakeMemberRepository;
let repository: FakeSocietyRepository;

beforeAll(async () => {
  auth = await createTestAuth();
  members = createFakeMemberRepository();
  repository = createFakeSocietyRepository();
  app = await createTestApp({
    jwks: auth.jwks,
    reader,
    members,
    repository,
  });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  memberships.clear();
  guardReads.length = 0;
  members.state.reset();
  repository.state.societies.clear();
  repository.state.memberships.length = 0;
  repository.state.calls.length = 0;

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
  // An Admin of the *other* society: enough to prove that a society header alone never grants
  // access to a member of a different one.
  memberships.set(key(SOCIETY_B, ADMIN), {
    ...membershipOf(ADMIN, "admin"),
    societyId: SOCIETY_B,
  });

  members.seed(SOCIETY_A, {
    id: M_ADMIN,
    userId: ADMIN,
    role: "admin",
    displayName: "Anita Rao",
    phone: "+919800000001",
  });
  members.seed(SOCIETY_A, {
    id: M_TREASURER,
    userId: TREASURER,
    role: "treasurer",
    displayName: "Bharat Shah",
    phone: "+919800000002",
  });
  members.seed(SOCIETY_A, {
    id: M_RESIDENT,
    userId: RESIDENT,
    role: "resident",
    displayName: "Meera Krishnan",
    phone: "+919800000003",
    shareContact: true,
  });
  // The queue: two claims on one flat and one request without a flat.
  members.seed(SOCIETY_A, {
    id: M_PENDING_OWNER,
    userId: PENDING,
    displayName: "Pending Owner",
    status: "pending",
    apartmentId: FLAT_A,
    requestNote: "Owner of A-101",
    createdAt: "2026-09-20T00:00:00.000Z",
  });
  members.seed(SOCIETY_A, {
    id: M_PENDING_TENANT,
    displayName: "Pending Tenant",
    status: "pending",
    apartmentId: FLAT_A,
    requestNote: "Tenant of A-101",
    createdAt: "2026-09-21T00:00:00.000Z",
  });
  members.seed(SOCIETY_A, {
    id: M_FLATLESS,
    displayName: "No Flat Yet",
    status: "pending",
    createdAt: "2026-09-19T00:00:00.000Z",
  });
  // The same account as the Admin, on a second row: the self-review case.
  members.seed(SOCIETY_A, {
    id: M_SELF,
    userId: ADMIN,
    displayName: "Anita Rao",
    status: "pending",
  });
  members.seed(SOCIETY_B, {
    id: M_FOREIGN,
    displayName: "Other Society Person",
  });

  // The join-options route's society, with the code the form carries.
  repository.seed({
    id: SOCIETY_A,
    name: "Green Meadows",
    city: "Pune",
    joinCode: "AB2CD3",
  });
});

const server = () => request(app.getHttpServer());

async function call(
  method: "get" | "post",
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

const queue = (options: Parameters<typeof call>[2] = {}) =>
  call("get", "/v1/members/join-requests", {
    userId: ADMIN,
    societyId: SOCIETY_A,
    ...options,
  });

const approve = (
  memberId: string,
  body: unknown = {},
  userId: UserId = ADMIN,
) =>
  call("post", `/v1/members/join-requests/${memberId}/approve`, {
    userId,
    societyId: SOCIETY_A,
    body,
  });

const reject = (memberId: string, body: unknown, userId: UserId = ADMIN) =>
  call("post", `/v1/members/join-requests/${memberId}/reject`, {
    userId,
    societyId: SOCIETY_A,
    body,
  });

interface MemberDto {
  readonly id: string;
  readonly displayName: string;
  readonly status: string;
  readonly role: string;
  readonly occupancy: string;
  readonly apartment: { readonly number: string } | null;
  readonly requestNote: string | null;
  readonly rejectionReason: string | null;
  readonly contactVisible: boolean;
  readonly phone: string | null;
}

interface QueueDto {
  readonly requests: readonly {
    readonly member: MemberDto;
    readonly claims: readonly MemberDto[];
  }[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly capabilities: Record<string, boolean>;
}

const queueOf = (body: unknown): QueueDto =>
  (body as { readonly data: QueueDto }).data;

describe("authentication and the society header", () => {
  it("requires a session before the queue", async () => {
    // Built without the wrapper's defaults on purpose: the point is a request that
    // carries the society header and no session at all.
    const response = await call("get", "/v1/members/join-requests", {
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
    expect(guardReads).toEqual([]);
  });

  it("requires X-Society-Id, naming the field", async () => {
    const response = await queue({ societyId: null });

    expect(response.status).toBe(400);
    expect(response.body.error.field).toBe("x-society-id");
  });
});

describe("permissions", () => {
  it("refuses a Resident the queue — member.approve is not theirs", async () => {
    const response = await queue({ userId: RESIDENT });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toContain("member.approve");
    // Refused before storage: a permission failure is not a query that returned nothing.
    expect(members.state.calls).toEqual([]);
  });

  it("refuses a Guest the queue", async () => {
    const response = await queue({ userId: GUEST });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("answers MEMBER_INACTIVE for a pending membership, at the guard", async () => {
    const response = await queue({ userId: PENDING });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("MEMBER_INACTIVE");
  });

  it("answers 404 — not 403 — for a society the caller is not in", async () => {
    const response = await queue({ userId: OUTSIDER });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(members.state.calls).toEqual([]);
  });

  it("lets a Treasurer read the queue", async () => {
    const response = await queue({ userId: TREASURER });

    expect(response.status).toBe(200);
    expect(queueOf(response.body).capabilities.canApprove).toBe(true);
  });
});

describe("GET /v1/members/join-requests", () => {
  it("returns the pending rows with both claims on the contested flat", async () => {
    const response = await queue();

    expect(response.status).toBe(200);
    const data = queueOf(response.body);

    // Newest request first; the flatless row is a request like any other, and the Admin's own
    // pending row is in the queue alongside everybody else's (it is refused at the *decision*).
    expect(data.requests.map((request) => request.member.id)).toEqual([
      M_SELF,
      M_PENDING_TENANT,
      M_PENDING_OWNER,
      M_FLATLESS,
    ]);
    expect(data.total).toBe(4);
    expect(data.limit).toBe(50);
    expect(data.offset).toBe(0);
    expect(data.capabilities.canApprove).toBe(true);

    const contested = data.requests.find(
      (request) => request.member.id === M_PENDING_TENANT,
    );
    expect(contested?.claims.map((claim) => claim.id).sort()).toEqual(
      [M_PENDING_OWNER, M_PENDING_TENANT].sort(),
    );
    expect(contested?.member.requestNote).toBe("Tenant of A-101");

    const flatless = data.requests.find(
      (request) => request.member.id === M_FLATLESS,
    );
    // "Both have no flat" is not a claim on anything.
    expect(flatless?.claims).toEqual([]);
  });

  it("redacts contact on the queue exactly as the directory does", async () => {
    const response = await queue();

    const owner = queueOf(response.body).requests.find(
      (request) => request.member.id === M_PENDING_OWNER,
    );
    // The Admin sees contact, and `contactVisible` is what tells a client whether the value
    // is real rather than a redaction.
    expect(owner?.member.contactVisible).toBe(true);
    expect(owner?.member.phone).toBeNull();
  });

  it("pages with the contract's bounds", async () => {
    const response = await queue({ userId: TREASURER });
    expect(response.status).toBe(200);

    const paged = await call(
      "get",
      "/v1/members/join-requests?limit=1&offset=1",
      { userId: TREASURER, societyId: SOCIETY_A },
    );

    expect(paged.status).toBe(200);
    expect(queueOf(paged.body).requests).toHaveLength(1);
    expect(queueOf(paged.body).limit).toBe(1);
    expect(queueOf(paged.body).offset).toBe(1);
    // The total is what the filter produced, not the page size.
    expect(queueOf(paged.body).total).toBe(4);
  });

  it("rejects a malformed page with the contract's own validation", async () => {
    const response = await call("get", "/v1/members/join-requests?limit=0", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("POST /v1/members/join-requests/:memberId/approve", () => {
  it("admits a request as Treasurer, keeping what the requester declared", async () => {
    const response = await approve(M_PENDING_OWNER, {}, TREASURER);

    expect(response.status).toBe(200);
    const data = response.body.data as {
      readonly member: MemberDto;
      readonly capabilities: Record<string, boolean>;
    };
    expect(data.member.status).toBe("active");
    expect(data.member.role).toBe("resident");
    expect(data.member.occupancy).toBe("owner_occupied");
    expect(data.capabilities.canApprove).toBe(true);
    // The decision consumed the request: the queue no longer lists it.
    const after = queueOf((await queue()).body);
    expect(after.requests.map((request) => request.member.id)).not.toContain(
      M_PENDING_OWNER,
    );
  });

  it("lets an Admin confirm a corrected role and flat", async () => {
    const response = await approve(M_FLATLESS, {
      role: "committee_member",
      apartmentId: FLAT_A,
      occupancy: "tenant",
    });

    expect(response.status).toBe(200);
    const member = (response.body.data as { readonly member: MemberDto })
      .member;
    expect(member.role).toBe("committee_member");
    expect(member.occupancy).toBe("tenant");
    // The corrected flat reaches storage; the response's denormalised `apartment` is the
    // adapter's join, which the fake leaves as seeded (the real read re-joins the row).
    expect(members.state.members.get(M_FLATLESS)?.apartmentId).toBe(FLAT_A);
  });

  it("refuses a Treasurer handing out a role above Resident", async () => {
    const response = await approve(
      M_PENDING_OWNER,
      { role: "admin" },
      TREASURER,
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.details?.[0]?.code).toBe("ROLE_NOT_ASSIGNABLE");
    expect(members.state.members.get(M_PENDING_OWNER)?.status).toBe("pending");
  });

  it("refuses a reviewer deciding their own request", async () => {
    const response = await approve(M_SELF);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.details?.[0]?.code).toBe("SELF_REVIEW");
    expect(members.state.members.get(M_SELF)?.status).toBe("pending");
  });

  it("refuses a replay with JOIN_REQUEST_NOT_PENDING", async () => {
    expect((await approve(M_PENDING_TENANT)).status).toBe(200);

    const replay = await approve(M_PENDING_TENANT, {}, TREASURER);

    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe("CONFLICT");
    expect(replay.body.error.details?.[0]?.code).toBe(
      "JOIN_REQUEST_NOT_PENDING",
    );
  });

  it("refuses a request that was rejected rather than approved", async () => {
    expect(
      (await reject(M_PENDING_TENANT, { reason: "Wrong flat." })).status,
    ).toBe(200);

    const response = await approve(M_PENDING_TENANT);

    expect(response.status).toBe(409);
    expect(response.body.error.details?.[0]?.code).toBe(
      "JOIN_REQUEST_NOT_PENDING",
    );
  });

  it("answers 404 for a member of another society", async () => {
    const response = await approve(M_FOREIGN);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("answers 404 for an Admin of another society presenting this society's header", async () => {
    // The guard resolves the *society in the header*: ADMIN is an Admin of SOCIETY_B and has no
    // membership here, so the answer is the stranger's.
    const response = await call(
      "post",
      `/v1/members/join-requests/${M_PENDING_TENANT}/approve`,
      { userId: ADMIN, societyId: SOCIETY_B, body: {} },
    );

    expect(response.status).toBe(404);
  });

  it("refuses a malformed member id with the contract's validation", async () => {
    const response = await approve(NOT_A_UUID);

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("memberId");
  });

  it("refuses an unknown body field rather than ignoring it", async () => {
    const response = await approve(M_PENDING_OWNER, { status: "active" });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("names the flat when primacy is asked for with none", async () => {
    const response = await approve(M_FLATLESS, { isPrimary: true });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("apartmentId");
  });

  it("refuses the second primary claim on one flat — the collision, decided not auto-rejected", async () => {
    // Both claims were visible in the queue above; the first decision stands, and the second
    // primary claim is refused as a conflict with the flat named.
    const first = await approve(M_PENDING_OWNER, { isPrimary: true });
    expect(first.status).toBe(200);

    const second = await approve(M_PENDING_TENANT, { isPrimary: true });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("CONFLICT");
    expect(second.body.error.field).toBe("apartmentId");
    expect(members.state.members.get(M_PENDING_TENANT)?.status).toBe("pending");
  });

  it("admits the second claim without primacy — the collision is about the flag", async () => {
    expect((await approve(M_PENDING_OWNER, { isPrimary: true })).status).toBe(
      200,
    );

    const second = await approve(M_PENDING_TENANT, { isPrimary: false });

    expect(second.status).toBe(200);
    expect(
      (second.body.data as { readonly member: MemberDto }).member.status,
    ).toBe("active");
  });
});

describe("POST /v1/members/join-requests/:memberId/reject", () => {
  it("records the reason the requester is owed", async () => {
    const response = await reject(M_PENDING_TENANT, {
      reason: "R-101 belongs to another owner.",
    });

    expect(response.status).toBe(200);
    const member = (response.body.data as { readonly member: MemberDto })
      .member;
    expect(member.status).toBe("rejected");
    expect(member.rejectionReason).toBe("R-101 belongs to another owner.");
  });

  it('requires a reason — the contract refuses "no" before the use case sees it', async () => {
    const response = await reject(M_PENDING_TENANT, { reason: "no" });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("reason");
    expect(members.state.calls).toEqual([]);
  });

  it("refuses a replay", async () => {
    expect(
      (await reject(M_PENDING_TENANT, { reason: "Wrong flat." })).status,
    ).toBe(200);

    const replay = await reject(M_PENDING_TENANT, { reason: "Again." });

    expect(replay.status).toBe(409);
    expect(replay.body.error.details?.[0]?.code).toBe(
      "JOIN_REQUEST_NOT_PENDING",
    );
  });

  it("refuses an ordinary resident, before storage", async () => {
    const response = await reject(
      M_PENDING_TENANT,
      { reason: "Not yours to decide." },
      RESIDENT,
    );

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(members.state.calls).toEqual([]);
  });
});

describe("GET /v1/societies/join-options", () => {
  it("resolves a code for an authenticated caller with no membership in it", async () => {
    // Deliberately no `X-Society-Id`: the route is code-addressed, because the caller is not a
    // member of the society they are asking about — that is the whole point of the screen.
    const response = await call(
      "get",
      "/v1/societies/join-options?code=AB2CD3",
      {
        userId: OUTSIDER,
      },
    );

    expect(response.status).toBe(200);
    const data = response.body.data as {
      readonly societyId: string;
      readonly total: number;
    };
    expect(data.societyId).toBe(SOCIETY_A);
    expect(data.total).toBe(0);
    expect(repository.state.calls).toContain("joinOptions");
  });

  it("accepts the whitespace and case the contract normalises, and refuses punctuation", async () => {
    // `joinCodeSchema` trims and upper-cases but does not strip an internal dash — the schema
    // both join paths share. The domain's `normalizeJoinCode` is more lenient, so this asserts
    // the *wire* contract rather than the use case's.
    const lenient = await call(
      "get",
      "/v1/societies/join-options?code=%20ab2cd3%20",
      { userId: OUTSIDER },
    );
    expect(lenient.status).toBe(200);

    const dashed = await call(
      "get",
      "/v1/societies/join-options?code=ab2cd-3",
      { userId: OUTSIDER },
    );
    expect(dashed.status).toBe(422);
    expect(dashed.body.error.field).toBe("code");
  });

  it("reports a dead code as invalid, with the detail code the screen branches on", async () => {
    const response = await call(
      "get",
      "/v1/societies/join-options?code=ZZZZZZ",
      {
        userId: OUTSIDER,
      },
    );

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.details?.[0]?.code).toBe("JOIN_CODE_INVALID");
  });

  it("rejects a malformed code at the pipe", async () => {
    const response = await call("get", "/v1/societies/join-options?code=ABC", {
      userId: OUTSIDER,
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("code");
  });

  it("requires a session — the venue is not public", async () => {
    const response = await call(
      "get",
      "/v1/societies/join-options?code=AB2CD3",
    );

    expect(response.status).toBe(401);
  });
});
