import { randomUUID } from "node:crypto";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { MemberError, asMemberId, asSocietyId, asUserId } from "@ses/domain";
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
import { createTestAuth, type TestAuth } from "./utils/supabase-auth";
import { createTestApp } from "./utils/test-app";

/**
 * The member routes over real HTTP (Roadmap T045).
 *
 * ## What runs for real
 *
 * The whole guard chain — the global auth guard verifying a real signature against a locally
 * held key pair, `SocietyGuard` resolving `X-Society-Id` to a membership, `PermissionGuard`
 * asking the domain's matrix — plus the Zod pipe parsing the real contract
 * (`memberListQuerySchema`, `createMemberSchema`, `updateMemberSchema`), the real use cases, the
 * real mapper with its output parse, the response envelope and the exception filter.
 *
 * ## What does not
 *
 * Storage and RLS. Two seams are substituted: the member repository (no Postgres) and the
 * membership read the *guard* performs. The member module needs no third seam, unlike the
 * structure module: its use cases read the caller's own membership from `members` through the
 * same repository. Nothing here evaluates a policy, so a mistake in the committed SQL is
 * invisible; `scripts/db/rls-canary.sql` is what covers that, and it asserts the guard-bypassed
 * path is still refused.
 *
 * ## The four things this suite is for
 *
 *  1. **Contact consent, as a response property.** A Resident's directory read must show a
 *     consented neighbour's number and a `null` for an unconsented one, with `contactVisible`
 *     telling the two apart; a member-manager must see both. This is the module's one
 *     privacy-shaped rule and the only one RLS cannot express.
 *  2. **Cross-society denial on a flat id**, both by member id and by the flat/building filters,
 *     answering `404` and never `403` (PRD T041).
 *  3. **The refusals the guard cannot see**: a *self*-suspension, a suspension of somebody who
 *     is not active, and the database's `SOCIETY_ADMIN_REQUIRED` — which the guard chain passes
 *     and the use case (or the trigger) must refuse.
 *  4. **The patch's absent-versus-null distinction**, end to end: `{ phone: null }` clears a
 *     shadow member's only identifier, and a body with a `role` field is rejected rather than
 *     ignored.
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
const M_GUEST = "aaaaaaaa-0000-4000-8000-000000000004";
const M_PENDING = "aaaaaaaa-0000-4000-8000-000000000005";
const M_SHADOW = "aaaaaaaa-0000-4000-8000-000000000006";
const M_CONSENTED = "aaaaaaaa-0000-4000-8000-000000000007";
const M_GONE = "aaaaaaaa-0000-4000-8000-000000000008";
const M_FOREIGN = "aaaaaaaa-0000-4000-8000-000000000009";
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

/** (society, actor) → membership, read by the guard. */
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

beforeAll(async () => {
  auth = await createTestAuth();
  members = createFakeMemberRepository();
  app = await createTestApp({ jwks: auth.jwks, reader, members });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  memberships.clear();
  guardReads.length = 0;
  // Clears the store *and* rewinds the fixture sequence, so the seeded flat and building labels
  // are the same in every test.
  members.state.reset();

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
  members.seed(SOCIETY_A, {
    id: M_GUEST,
    userId: GUEST,
    role: "guest",
    displayName: "Gate 1",
  });
  members.seed(SOCIETY_A, {
    id: M_PENDING,
    userId: PENDING,
    displayName: "Pending Person",
    status: "pending",
  });
  members.seed(SOCIETY_A, {
    id: M_SHADOW,
    displayName: "Suresh Menon",
    phone: "+919800000009",
    apartmentId: "cccccccc-0000-4000-8000-000000000001",
  });
  members.seed(SOCIETY_A, {
    id: M_CONSENTED,
    displayName: "Tara Nair",
    phone: "+919800000010",
    shareContact: true,
  });
  members.seed(SOCIETY_A, {
    id: M_GONE,
    displayName: "Gone Person",
    status: "removed",
  });
  members.seed(SOCIETY_B, {
    id: M_FOREIGN,
    displayName: "Other Society Person",
    phone: "+919800000011",
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

/** Adds a member as the Admin through the real route, returning the created DTO. */
async function addViaApi(spec: Record<string, unknown> = {}) {
  const response = await call("post", "/v1/members", {
    userId: ADMIN,
    societyId: SOCIETY_A,
    body: {
      displayName: "Suresh Menon",
      phone: "+91 98765 40000",
      ...spec,
    },
  });
  expect(response.status).toBe(201);
  return response.body.data.member as {
    readonly id: string;
    readonly phone: string | null;
    readonly apartmentId: string | null;
  };
}

interface MemberDto {
  readonly id: string;
  readonly displayName: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly contactVisible: boolean;
  readonly role: string;
  readonly status: string;
  readonly userId: string | null;
  readonly apartment: { readonly number: string } | null;
}

function membersOf(body: unknown): readonly MemberDto[] {
  return (body as { readonly data: { readonly members: readonly MemberDto[] } })
    .data.members;
}

describe("authentication and the society header", () => {
  it("requires a session before anything else", async () => {
    const response = await call("get", "/v1/members", { societyId: SOCIETY_A });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
    expect(guardReads).toEqual([]);
  });

  it("requires X-Society-Id, naming the field", async () => {
    const response = await call("get", "/v1/members", { userId: ADMIN });

    expect(response.status).toBe(400);
    expect(response.body.error.field).toBe("x-society-id");
  });

  it("answers 404 — not 403 — for a society the caller is not in", async () => {
    const response = await call("get", "/v1/members", {
      userId: OUTSIDER,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(members.state.calls).toEqual([]);
  });

  it("resolves the membership once per request", async () => {
    await call("get", "/v1/members", { userId: ADMIN, societyId: SOCIETY_A });

    expect(guardReads).toHaveLength(1);
  });
});

describe("permissions", () => {
  it("refuses a Guest the directory — member.view is not theirs", async () => {
    const response = await call("get", "/v1/members", {
      userId: GUEST,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toContain("member.view");
    // Refused before storage: a permission failure is not a query that returned nothing.
    expect(members.state.calls).toEqual([]);
  });

  it("answers MEMBER_INACTIVE for a pending membership, at the guard", async () => {
    const response = await call("get", "/v1/members", {
      userId: PENDING,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("MEMBER_INACTIVE");
  });

  it("lets a Resident read and refuses them every write", async () => {
    const read = await call("get", "/v1/members", {
      userId: RESIDENT,
      societyId: SOCIETY_A,
    });
    expect(read.status).toBe(200);
    expect(read.body.data.capabilities).toEqual({
      canView: true,
      canAdd: false,
      canEdit: false,
      canSuspend: false,
      canRemove: false,
      // T046: the role write is the one capability no role below Admin holds, and it travels with
      // every member response so a screen never infers it from a role string.
      canChangeRoles: false,
      // T049: the join queue is `member.approve` — Admin and Treasurer — where the directory is
      // `member.view`, so a Resident reads the roster and is never handed a decision screen.
      canApprove: false,
    });

    const add = await call("post", "/v1/members", {
      userId: RESIDENT,
      societyId: SOCIETY_A,
      body: { displayName: "Someone", phone: "+919800000099" },
    });
    expect(add.status).toBe(403);

    const edit = await call("patch", `/v1/members/${M_SHADOW}`, {
      userId: RESIDENT,
      societyId: SOCIETY_A,
      body: { displayName: "Renamed" },
    });
    expect(edit.status).toBe(403);

    const remove = await call("delete", `/v1/members/${M_SHADOW}`, {
      userId: RESIDENT,
      societyId: SOCIETY_A,
    });
    expect(remove.status).toBe(403);
  });

  it("lets a Treasurer add and edit, and refuses them suspension and removal", async () => {
    const add = await call("post", "/v1/members", {
      userId: TREASURER,
      societyId: SOCIETY_A,
      body: { displayName: "Suresh Menon", phone: "+919876540000" },
    });
    expect(add.status).toBe(201);
    expect(add.body.data.capabilities).toBeUndefined();

    const edit = await call("patch", `/v1/members/${M_SHADOW}`, {
      userId: TREASURER,
      societyId: SOCIETY_A,
      body: { shareContact: true },
    });
    expect(edit.status).toBe(200);

    const suspend = await call("post", `/v1/members/${M_SHADOW}/suspend`, {
      userId: TREASURER,
      societyId: SOCIETY_A,
    });
    expect(suspend.status).toBe(403);
    expect(suspend.body.error.message).toContain("member.remove");

    const remove = await call("delete", `/v1/members/${M_SHADOW}`, {
      userId: TREASURER,
      societyId: SOCIETY_A,
    });
    expect(remove.status).toBe(403);
  });
});

describe("the directory", () => {
  it("returns a page with its total and the caller's capabilities", async () => {
    const response = await call("get", "/v1/members", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    // Eight live members in society A: five with accounts, two shadow, one consented shadow —
    // and not the removed one.
    expect(response.body.data.total).toBe(7);
    expect(response.body.data.limit).toBe(50);
    expect(response.body.data.offset).toBe(0);
    expect(response.body.data.capabilities.canRemove).toBe(true);
    expect(membersOf(response.body)).toHaveLength(7);
  });

  it("envelopes the response", async () => {
    const response = await call("get", "/v1/members", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.body.data).toBeDefined();
    expect(typeof response.body.meta.requestId).toBe("string");
  });

  it("hides a removed member unless that status is asked for", async () => {
    const byDefault = await call("get", "/v1/members", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(
      membersOf(byDefault.body).some((member) => member.id === M_GONE),
    ).toBe(false);

    const removed = await call("get", "/v1/members?status=removed", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(removed.body.data.total).toBe(1);
    expect(membersOf(removed.body)[0]?.id).toBe(M_GONE);
  });

  it("filters by role and by occupancy", async () => {
    const treasurers = await call("get", "/v1/members?role=treasurer", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(membersOf(treasurers.body).map((member) => member.id)).toEqual([
      M_TREASURER,
    ]);

    const owners = await call("get", "/v1/members?occupancy=owner_occupied", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(owners.body.data.total).toBe(7);
  });

  it("searches by name, flat number and phone", async () => {
    const byName = await call("get", "/v1/members?q=suresh", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(membersOf(byName.body).map((member) => member.id)).toEqual([
      M_SHADOW,
    ]);
    expect(membersOf(byName.body)[0]?.apartment?.number).toBe("A-106");

    const byFlat = await call("get", "/v1/members?q=A-106", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(membersOf(byFlat.body).map((member) => member.id)).toEqual([
      M_SHADOW,
    ]);

    const byPhone = await call("get", "/v1/members?q=9800000009", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(membersOf(byPhone.body).map((member) => member.id)).toEqual([
      M_SHADOW,
    ]);
  });

  it("pages with limit and offset, still reporting the full total", async () => {
    const firstPage = await call("get", "/v1/members?limit=3", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(membersOf(firstPage.body)).toHaveLength(3);
    expect(firstPage.body.data.total).toBe(7);
    expect(firstPage.body.data.limit).toBe(3);

    const secondPage = await call("get", "/v1/members?limit=3&offset=3", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    const overlap = membersOf(secondPage.body).filter((member) =>
      membersOf(firstPage.body).some((first) => first.id === member.id),
    );
    expect(overlap).toEqual([]);
  });

  it("refuses an unknown status rather than ignoring the filter", async () => {
    const response = await call("get", "/v1/members?status=actve", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    // The value has the right *shape* and the wrong *membership* of the enum, which the pipe
    // reports as semantic (422) rather than syntactic (400) — SAD §7.8's two stages.
    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("status");
  });

  it("shows a resident a consented number and withholds an unconsented one", async () => {
    const response = await call("get", "/v1/members", {
      userId: RESIDENT,
      societyId: SOCIETY_A,
    });

    const byId = new Map(
      membersOf(response.body).map((member) => [member.id, member]),
    );
    // The consented neighbour and the caller's own row.
    expect(byId.get(M_CONSENTED)?.phone).toBe("+919800000010");
    expect(byId.get(M_RESIDENT)?.phone).toBe("+919800000003");
    // The shadow member and the Admin, neither of whom has consented.
    expect(byId.get(M_SHADOW)?.phone).toBeNull();
    expect(byId.get(M_SHADOW)?.contactVisible).toBe(false);
    expect(byId.get(M_ADMIN)?.phone).toBeNull();
    expect(byId.get(M_ADMIN)?.contactVisible).toBe(false);
  });

  it("shows a member-manager every number, consented or not", async () => {
    const response = await call("get", "/v1/members", {
      userId: TREASURER,
      societyId: SOCIETY_A,
    });

    const shadow = membersOf(response.body).find(
      (member) => member.id === M_SHADOW,
    );
    expect(shadow?.phone).toBe("+919800000009");
    expect(shadow?.contactVisible).toBe(true);
  });

  it("filters by building", async () => {
    // The fixture's flat is in the building whose UUID the fake derives from seed order; the
    // sixth seed is the shadow member.
    const response = await call(
      "get",
      "/v1/members?buildingId=dddddddd-0000-4000-8000-000000000006",
      { userId: ADMIN, societyId: SOCIETY_A },
    );

    expect(response.status).toBe(200);
    expect(membersOf(response.body).map((member) => member.id)).toEqual([
      M_SHADOW,
    ]);
  });
});

describe("your own membership", () => {
  it("reads `me` as a literal path, not as a member id", async () => {
    // The routing property this depends on: `/members/me` is registered before `/members/:memberId`,
    // whose parameter is validated as a UUID. Were the order reversed, "me" would be answered 422
    // with `field: "memberId"` — so the status alone is the assertion.
    const response = await call("get", "/v1/members/me", {
      userId: RESIDENT,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.member.id).toBe(M_RESIDENT);
  });

  it("returns the caller's own row and their capabilities, not someone else's", async () => {
    const response = await call("get", "/v1/members/me", {
      userId: RESIDENT,
      societyId: SOCIETY_A,
    });

    expect(response.body.data.member.displayName).toBe("Meera Krishnan");
    expect(response.body.data.member.userId).toBe(RESIDENT);
    // A resident may read the directory and may not write it: the capabilities come from the
    // domain's matrix evaluated against *this* row, so no role string is inferred here.
    expect(response.body.data.capabilities).toEqual({
      canView: true,
      canAdd: false,
      canEdit: false,
      canSuspend: false,
      canRemove: false,
      canChangeRoles: false,
      canApprove: false,
    });
  });

  it("shows a member their own number even with the consent flag off", async () => {
    // `share_contact` governs what *other* members see. Reading your own row through the same
    // mapper is what proves the flag is applied as "someone else", not as "everyone but an admin".
    const response = await call("get", "/v1/members/me", {
      userId: TREASURER,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.member.contactVisible).toBe(true);
    expect(response.body.data.member.phone).not.toBeNull();
  });

  it("refuses a pending membership at the guard, before the use case runs", async () => {
    const before = members.state.calls.length;
    const response = await call("get", "/v1/members/me", {
      userId: PENDING,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("MEMBER_INACTIVE");
    expect(members.state.calls.length).toBe(before);
  });

  it("answers 404 — never 403 — for a society the caller is not in", async () => {
    const response = await call("get", "/v1/members/me", {
      userId: OUTSIDER,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});

describe("one member", () => {
  it("returns the member and the caller's capabilities", async () => {
    const response = await call("get", `/v1/members/${M_RESIDENT}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.member.displayName).toBe("Meera Krishnan");
    expect(response.body.data.capabilities.canEdit).toBe(true);
  });

  it("answers 404 for a member of another society", async () => {
    const response = await call("get", `/v1/members/${M_FOREIGN}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("answers 404 for a removed member, indistinguishably from a missing one", async () => {
    const gone = await call("get", `/v1/members/${M_GONE}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    const missing = await call("get", `/v1/members/${randomUUID()}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(gone.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(gone.body.error.message).toBe(missing.body.error.message);
  });

  it("refuses a non-UUID id before any query runs", async () => {
    const response = await call("get", `/v1/members/${NOT_A_UUID}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("memberId");
    expect(members.state.calls).toEqual([]);
  });
});

describe("adding a member", () => {
  it("records a shadow member with a normalised number", async () => {
    const created = await addViaApi();

    expect(created.phone).toBe("+919876540000");
    expect(created.id).toBeDefined();
  });

  it("returns a user_id of null — the account will come later, if it ever does", async () => {
    const response = await call("post", "/v1/members", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { displayName: "Suresh Menon", phone: "+919876540000" },
    });

    expect(response.body.data.member.userId).toBeNull();
    expect(response.body.data.member.status).toBe("active");
    expect(response.body.data.member.role).toBe("resident");
  });

  it("accepts a flat, an occupancy, a lease and the consent flag", async () => {
    const response = await call("post", "/v1/members", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: {
        displayName: "Tara Nair",
        phone: "+919876540001",
        occupancy: "tenant",
        apartmentId: "cccccccc-0000-4000-8000-000000000002",
        isPrimary: true,
        leaseStart: "2026-01-01",
        leaseEnd: "2026-12-31",
        shareContact: true,
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.data.member.occupancy).toBe("tenant");
    expect(response.body.data.member.isPrimary).toBe(true);
    expect(response.body.data.member.shareContact).toBe(true);
  });

  it("refuses a duplicate shadow number with the field named", async () => {
    const response = await call("post", "/v1/members", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { displayName: "Suresh Again", phone: "+91 98000 00009" },
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
    expect(response.body.error.field).toBe("phone");
  });

  it("allows a number an account-holder already has", async () => {
    const response = await call("post", "/v1/members", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { displayName: "Meera's husband", phone: "+919800000003" },
    });

    expect(response.status).toBe(201);
  });

  it("refuses a number whose country it would have to guess", async () => {
    const response = await call("post", "/v1/members", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { displayName: "Suresh Menon", phone: "12345" },
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("phone");
  });

  it("refuses a primary occupant without a flat", async () => {
    const response = await call("post", "/v1/members", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: {
        displayName: "Suresh Menon",
        phone: "+919876540000",
        isPrimary: true,
      },
    });

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("apartmentId");
  });

  it("refuses a role field outright — role assignment is its own operation", async () => {
    const response = await call("post", "/v1/members", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: {
        displayName: "Suresh Menon",
        phone: "+919876540000",
        role: "admin",
      },
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("refuses a shadow member whose number another shadow already holds, at the index", async () => {
    // The application layer checks the same thing first; this asserts the storage rule is real
    // by having the repository raise it, which is the path a concurrent request takes.
    const clash = await call("post", "/v1/members", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { displayName: "Suresh Menon", phone: "9800000009" },
    });

    expect(clash.status).toBe(409);
    expect(clash.body.error.field).toBe("phone");
  });
});

describe("editing a member", () => {
  it("patches the fields it was given", async () => {
    const response = await call("patch", `/v1/members/${M_SHADOW}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { displayName: "Suresh M Menon" },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.member.displayName).toBe("Suresh M Menon");
    // The fields it was *not* given are untouched.
    expect(response.body.data.member.phone).toBe("+919800000009");
  });

  it("clears a phone number with an explicit null", async () => {
    const response = await call("patch", `/v1/members/${M_SHADOW}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { phone: null },
    });

    expect(response.status).toBe(200);
    expect(response.body.data.member.phone).toBeNull();
  });

  it("normalises a number it is given", async () => {
    const response = await call("patch", `/v1/members/${M_SHADOW}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { phone: "98765 40002" },
    });

    expect(response.body.data.member.phone).toBe("+919876540002");
  });

  it("refuses a duplicate number on the phone field", async () => {
    const response = await call("patch", `/v1/members/${M_SHADOW}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { phone: "+919800000010" },
    });

    expect(response.status).toBe(409);
    expect(response.body.error.field).toBe("phone");
  });

  it("refuses a lease window that ends before it starts", async () => {
    const response = await call("patch", `/v1/members/${M_SHADOW}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { leaseStart: "2026-06-01", leaseEnd: "2026-01-01" },
    });

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("leaseEnd");
  });

  it("refuses an empty patch", async () => {
    const response = await call("patch", `/v1/members/${M_SHADOW}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: {},
    });

    expect(response.status).toBe(422);
  });

  it("refuses a status field — the transitions are their own routes", async () => {
    const response = await call("patch", `/v1/members/${M_SHADOW}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { status: "active" },
    });

    expect(response.status).toBe(400);
  });

  it("lets a manager flip the consent flag, and a resident sees the number afterwards", async () => {
    const consented = await call("patch", `/v1/members/${M_SHADOW}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { shareContact: true },
    });
    expect(consented.status).toBe(200);
    expect(consented.body.data.member.shareContact).toBe(true);

    const asResident = await call("get", `/v1/members/${M_SHADOW}`, {
      userId: RESIDENT,
      societyId: SOCIETY_A,
    });
    expect(asResident.body.data.member.phone).toBe("+919800000009");
    expect(asResident.body.data.member.contactVisible).toBe(true);
  });
});

describe("suspension and reactivation", () => {
  it("suspends an active member", async () => {
    const response = await call("post", `/v1/members/${M_SHADOW}/suspend`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.member.status).toBe("inactive");
  });

  it("reactivates a suspended member", async () => {
    await call("post", `/v1/members/${M_SHADOW}/suspend`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    const response = await call("post", `/v1/members/${M_SHADOW}/reactivate`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.member.status).toBe("active");
  });

  it("refuses suspending somebody who is not active", async () => {
    const response = await call("post", `/v1/members/${M_PENDING}/suspend`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
  });

  it("refuses suspending your own membership", async () => {
    const response = await call("post", `/v1/members/${M_ADMIN}/suspend`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.message).toContain("Leave the society");
  });

  it("refuses reactivating somebody who is already active", async () => {
    const response = await call("post", `/v1/members/${M_SHADOW}/reactivate`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(409);
  });
});

describe("removal", () => {
  it("removes a member and takes them out of every read path", async () => {
    const removed = await call("delete", `/v1/members/${M_SHADOW}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(removed.status).toBe(204);
    expect(removed.body).toEqual({});

    const detail = await call("get", `/v1/members/${M_SHADOW}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(detail.status).toBe(404);
  });

  it("keeps the row, with its stamps, for the financial history that will point at it", async () => {
    await call("delete", `/v1/members/${M_SHADOW}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    // The repository is the storage here: the row is still present and only its status moved,
    // which is what makes `status=removed` a readable history rather than a hole.
    const stored = members.state.members.get(M_SHADOW);
    expect(stored?.status).toBe("removed");
    expect(stored?.removedAt).not.toBeNull();

    const history = await call("get", "/v1/members?status=removed", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(
      membersOf(history.body).some((member) => member.id === M_SHADOW),
    ).toBe(true);
  });

  it("refuses removing your own membership", async () => {
    const response = await call("delete", `/v1/members/${M_ADMIN}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.message).toContain("Leave the society");
  });

  it("surfaces the database's refusal to orphan a society of its last Admin", async () => {
    // Simulates what the **adapter** produces when `chk_admin_present()` raises
    // `P0001/SOCIETY_ADMIN_REQUIRED`: the classifier in `member.rows.ts` turns it into
    // `sole_admin` (covered directly in `member.rows.test.ts`), and this asserts the code then
    // travels unchanged through the use case, the error mapper and the filter — the guard chain
    // cannot see the trigger, so nothing else in the request would notice.
    const repository = members as unknown as {
      remove: (id: string, societyId: string) => Promise<void>;
    };
    const original = repository.remove.bind(members);
    repository.remove = () =>
      Promise.reject(
        new MemberError(
          "sole_admin",
          "A society needs at least one active Admin.",
        ),
      );

    const response = await call("delete", `/v1/members/${M_TREASURER}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    repository.remove = original;

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("SOCIETY_ADMIN_REQUIRED");
    expect(response.body.error.details?.[0]?.code).toBe("SOLE_ADMIN");
  });

  it("answers 404 for somebody who does not exist", async () => {
    const response = await call("delete", `/v1/members/${randomUUID()}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(404);
  });
});
