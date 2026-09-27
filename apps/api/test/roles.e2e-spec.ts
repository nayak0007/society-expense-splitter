import { randomUUID } from "node:crypto";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { actionsFor, asMemberId, asSocietyId, asUserId } from "@ses/domain";
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
 * Roles and permissions over real HTTP (Roadmap T046).
 *
 * ## What this suite is for, and what it cannot be for
 *
 * The **HTTP** half of the matrix: that the role write is reachable only by an Admin
 * (`member.role_change`), that the caps, the self-change refusal and the target's status are
 * reported with codes a screen can branch on, and that the introspection routes answer from the
 * evaluator's own list rather than from a stored grant — with the permission catalogue, a
 * member's own view and an Admin's view of a member all agreeing.
 *
 * It is deliberately **not** where the enforcement story ends. Three of T046's guarantees are
 * the database's, and nothing here evaluates a policy or a trigger: that the column is granted to
 * nobody's self-write (`chk_member_self_change()`), that a society keeps an active Admin
 * (`chk_admin_present()`), and that the caps hold under concurrency (`chk_role_caps()`) are
 * asserted in `scripts/db/rls-canary.sql`, against a real database, as the identity a client
 * would have. A fake that reproduced them here would prove the fake.
 *
 * ## The seam
 *
 * The member repository and the guard's membership read are substituted (no Postgres), exactly as
 * the members suite does — see `fake-member-repository.ts`. Everything between the request and
 * that object runs for real: the auth guard, `SocietyGuard`, `PermissionGuard`, the Zod pipe over
 * the shared contracts, the use cases, the mapper's output parse and the envelope.
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
/** Two more active admins, so PRD §2.2's 3-admin cap is already reached in the base fixture. */
const M_ADMIN_2 = "aaaaaaaa-0000-4000-8000-00000000000a";
const M_ADMIN_3 = "aaaaaaaa-0000-4000-8000-00000000000b";
/** One active treasurer plus one suspended one, so the treasurer cap is testable both ways. */
const M_TREASURER = "aaaaaaaa-0000-4000-8000-000000000002";
const M_TREASURER_2 = "aaaaaaaa-0000-4000-8000-00000000000c";
const M_TREASURER_3 = "aaaaaaaa-0000-4000-8000-00000000000d";
const M_RESIDENT = "aaaaaaaa-0000-4000-8000-000000000003";
const M_SPARE = "aaaaaaaa-0000-4000-8000-000000000006";
const M_GUEST = "aaaaaaaa-0000-4000-8000-000000000004";
const M_PENDING = "aaaaaaaa-0000-4000-8000-000000000005";
const M_GONE = "aaaaaaaa-0000-4000-8000-000000000008";
const M_FOREIGN = "aaaaaaaa-0000-4000-8000-000000000009";

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
    id: M_ADMIN_2,
    role: "admin",
    displayName: "Admin Two",
  });
  members.seed(SOCIETY_A, {
    id: M_ADMIN_3,
    role: "admin",
    displayName: "Admin Three",
  });

  members.seed(SOCIETY_A, {
    id: M_TREASURER,
    userId: TREASURER,
    role: "treasurer",
    displayName: "Bharat Shah",
    phone: "+919800000002",
  });
  // A committee member rather than a second treasurer: the base fixture holds **one** active
  // treasurer so the ordinary promotion below succeeds, and the cap tests fill the second slot
  // explicitly. A fixture that starts at the cap would make every happy-path promotion a 409.
  members.seed(SOCIETY_A, {
    id: M_TREASURER_2,
    role: "committee_member",
    displayName: "Committee Two",
  });
  // Suspended: holds the role, occupies no slot — the rule that keeps a society able to replace
  // an officer it has suspended.
  members.seed(SOCIETY_A, {
    id: M_TREASURER_3,
    role: "treasurer",
    status: "inactive",
    displayName: "Treasurer Three",
  });

  members.seed(SOCIETY_A, {
    id: M_RESIDENT,
    userId: RESIDENT,
    role: "resident",
    displayName: "Meera Krishnan",
    phone: "+919800000003",
  });
  members.seed(SOCIETY_A, {
    id: M_SPARE,
    role: "committee_member",
    displayName: "Committee Person",
  });
  members.seed(SOCIETY_A, {
    id: M_GUEST,
    userId: GUEST,
    role: "guest",
    displayName: "Gate 1",
  });
  members.seed(SOCIETY_A, {
    id: M_PENDING,
    role: "resident",
    status: "pending",
    displayName: "Pending Person",
  });
  members.seed(SOCIETY_A, {
    id: M_GONE,
    role: "resident",
    status: "removed",
    displayName: "Gone Person",
  });
  members.seed(SOCIETY_B, {
    id: M_FOREIGN,
    role: "resident",
    displayName: "Other Society Person",
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

interface PermissionsDto {
  readonly memberId: string;
  readonly role: string;
  readonly permissions: readonly string[];
  readonly capabilities: { readonly canChangeRoles: boolean };
}

const permissionsOf = (body: unknown): PermissionsDto =>
  (body as { readonly data: PermissionsDto }).data;

const roleOf = (memberId: string): string | undefined =>
  members.state.members.get(memberId)?.role;

describe("the permission catalogue", () => {
  it("lists every role with its actions, in PRD order, for an Admin", async () => {
    const response = await call("get", "/v1/permissions", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    const data = response.body.data as {
      readonly roles: readonly {
        readonly role: string;
        readonly permissions: readonly string[];
      }[];
      readonly capabilities: { readonly canChangeRoles: boolean };
    };

    expect(data.roles.map((definition) => definition.role)).toEqual([
      "admin",
      "treasurer",
      "committee_member",
      "resident",
      "tenant",
      "guest",
    ]);
    // The catalogue is the evaluator's own list, not a second copy: the Admin's set is
    // `actionsFor("admin")`, and it is the only one that carries the role write.
    const admin = data.roles.find((definition) => definition.role === "admin");
    expect(admin?.permissions).toEqual(actionsFor("admin"));
    expect(admin?.permissions).toContain("member.role_change");
    for (const definition of data.roles.filter(
      (candidate) => candidate.role !== "admin",
    )) {
      expect(definition.permissions).not.toContain("member.role_change");
    }
    expect(data.capabilities.canChangeRoles).toBe(true);
  });

  it("is readable by a Resident, with their capabilities telling them what they cannot do", async () => {
    const response = await call("get", "/v1/permissions", {
      userId: RESIDENT,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(
      (
        response.body.data as {
          readonly capabilities: PermissionsDto["capabilities"];
        }
      ).capabilities.canChangeRoles,
    ).toBe(false);
    expect(
      (response.body.data as { readonly roles: readonly unknown[] }).roles,
    ).toHaveLength(6);
  });

  it("refuses a Guest — member.view is not theirs", async () => {
    const response = await call("get", "/v1/permissions", {
      userId: GUEST,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(members.state.calls).toEqual([]);
  });

  it("refuses a pending member with the inactive-membership code", async () => {
    const response = await call("get", "/v1/permissions", {
      userId: PENDING,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("MEMBER_INACTIVE");
  });

  it("answers 404 — not 403 — without a membership, and reads nothing", async () => {
    const response = await call("get", "/v1/permissions", {
      userId: OUTSIDER,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(members.state.calls).toEqual([]);
  });

  it("does not let a society header alone grant access", async () => {
    // B is a real society in the guard's reader, and this caller administers A. Naming B must be
    // the same 404 as naming a society that does not exist — the header selects, it never grants.
    const foreign = await call("get", "/v1/permissions", {
      userId: ADMIN,
      societyId: SOCIETY_B,
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("NOT_FOUND");

    // The first call did reach the repository (the guard admitted an Admin of another society's
    // row… in B, which has no member for them, hence the 404 above) — what this asserts is that
    // the *outsider* never reaches it at all.
    members.state.calls.length = 0;
    const outsider = await call("get", "/v1/permissions", {
      userId: OUTSIDER,
      societyId: SOCIETY_B,
    });
    expect(outsider.status).toBe(404);
    expect(members.state.calls).toEqual([]);
  });
});

describe("my permissions", () => {
  it("answers with the caller's own role, permissions and capabilities", async () => {
    const response = await call("get", "/v1/permissions/me", {
      userId: RESIDENT,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    const data = permissionsOf(response.body);
    expect(data.memberId).toBe(M_RESIDENT);
    expect(data.role).toBe("resident");
    expect(data.permissions).toEqual(actionsFor("resident"));
    expect(data.capabilities.canChangeRoles).toBe(false);
  });

  it("includes the role write for an Admin", async () => {
    const response = await call("get", "/v1/permissions/me", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    const data = permissionsOf(response.body);
    expect(data.memberId).toBe(M_ADMIN);
    expect(data.permissions).toContain("member.role_change");
    expect(data.capabilities.canChangeRoles).toBe(true);
  });

  it("refuses a pending member at the guard chain, with the same code as everywhere else", async () => {
    const response = await call("get", "/v1/permissions/me", {
      userId: PENDING,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("MEMBER_INACTIVE");
  });
});

describe("one member's permissions", () => {
  it("shows an Admin what another member holds", async () => {
    const response = await call("get", `/v1/permissions/members/${M_SPARE}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    const data = permissionsOf(response.body);
    expect(data.memberId).toBe(M_SPARE);
    expect(data.role).toBe("committee_member");
    expect(data.permissions).toEqual(actionsFor("committee_member"));
  });

  it("lets a member read their own, which needs no role write", async () => {
    const response = await call(
      "get",
      `/v1/permissions/members/${M_RESIDENT}`,
      {
        userId: RESIDENT,
        societyId: SOCIETY_A,
      },
    );

    expect(response.status).toBe(200);
    expect(permissionsOf(response.body).role).toBe("resident");
  });

  it("refuses a Treasurer another member's permissions — enumerating Admins is the Admin's job", async () => {
    const response = await call("get", `/v1/permissions/members/${M_ADMIN}`, {
      userId: TREASURER,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.field).toBe("memberId");
  });

  it("refuses a Resident another member's permissions", async () => {
    const response = await call("get", `/v1/permissions/members/${M_SPARE}`, {
      userId: RESIDENT,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("answers 404 for another society's member", async () => {
    const response = await call("get", `/v1/permissions/members/${M_FOREIGN}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("answers 404 for a removed member, exactly as for one that never existed", async () => {
    const response = await call("get", `/v1/permissions/members/${M_GONE}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("validates the path parameter before it reaches the database", async () => {
    const response = await call("get", "/v1/permissions/members/not-a-uuid", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("assigning and changing a role", () => {
  it("promotes a Resident, answering with the permissions the new role holds", async () => {
    const response = await call("patch", `/v1/members/${M_RESIDENT}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { role: "treasurer" },
    });

    expect(response.status).toBe(200);
    const data = permissionsOf(response.body);
    expect(data.memberId).toBe(M_RESIDENT);
    expect(data.role).toBe("treasurer");
    expect(data.permissions).toEqual(actionsFor("treasurer"));
    // From the stored row, not from the request: the fake wrote what it was given, so this also
    // proves the response is built from what came back.
    expect(roleOf(M_RESIDENT)).toBe("treasurer");
    expect(members.state.calls).toContain("setRole");
  });

  it("accepts the domain's committee spelling, which is not the database's", async () => {
    const response = await call("patch", `/v1/members/${M_RESIDENT}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { role: "committee_member" },
    });

    expect(response.status).toBe(200);
    expect(permissionsOf(response.body).role).toBe("committee_member");
    expect(roleOf(M_RESIDENT)).toBe("committee_member");
  });

  it("refuses a Treasurer — the role write is the one action only an Admin holds", async () => {
    const response = await call("patch", `/v1/members/${M_RESIDENT}/role`, {
      userId: TREASURER,
      societyId: SOCIETY_A,
      body: { role: "treasurer" },
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(roleOf(M_RESIDENT)).toBe("resident");
    expect(members.state.calls).not.toContain("setRole");
  });

  it("refuses an Admin their own role change — the escalation the task names", async () => {
    const response = await call("patch", `/v1/members/${M_ADMIN}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { role: "committee_member" },
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toContain("your own role");
    expect(roleOf(M_ADMIN)).toBe("admin");
  });

  it("refuses a role on a membership that has not been admitted", async () => {
    const response = await call("patch", `/v1/members/${M_PENDING}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { role: "treasurer" },
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
    expect(roleOf(M_PENDING)).toBe("resident");
  });

  it("refuses a no-op rather than reporting a save that never happened", async () => {
    const response = await call("patch", `/v1/members/${M_TREASURER}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { role: "treasurer" },
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
    expect(response.body.error.message).toContain("already has this role");
  });

  it("enforces the 2-treasurer cap, with a detail code a picker can branch on", async () => {
    // The fixture holds one active treasurer; the first promotion fills the second slot…
    const fills = await call("patch", `/v1/members/${M_SPARE}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { role: "treasurer" },
    });
    expect(fills.status).toBe(200);

    // …and the next one is refused, by the count rather than by anything about the member.
    const response = await call("patch", `/v1/members/${M_RESIDENT}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { role: "treasurer" },
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
    expect(response.body.error.field).toBe("role");
    expect(response.body.error.details?.[0]?.code).toBe("ROLE_CAP_EXCEEDED");
    expect(roleOf(M_RESIDENT)).toBe("resident");
  });

  it("frees a slot when the holder is suspended, so the appointment goes through", async () => {
    // The only active treasurer is suspended — which keeps their role and frees the slot.
    const suspended = await call("post", `/v1/members/${M_TREASURER}/suspend`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(suspended.status).toBe(200);

    const response = await call("patch", `/v1/members/${M_RESIDENT}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { role: "treasurer" },
    });

    expect(response.status).toBe(200);
    expect(permissionsOf(response.body).role).toBe("treasurer");
  });

  it("enforces the 3-admin cap", async () => {
    const response = await call("patch", `/v1/members/${M_RESIDENT}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { role: "admin" },
    });

    expect(response.status).toBe(409);
    expect(response.body.error.details?.[0]?.code).toBe("ROLE_CAP_EXCEEDED");
    expect(response.body.error.message).toContain("admins");
    expect(roleOf(M_RESIDENT)).toBe("resident");
  });

  it("answers 404 for another society's member, before any write", async () => {
    const response = await call("patch", `/v1/members/${M_FOREIGN}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { role: "treasurer" },
    });

    expect(response.status).toBe(404);
    expect(roleOf(M_FOREIGN)).toBe("resident");
  });

  it("answers 404 for a removed member", async () => {
    const response = await call("patch", `/v1/members/${M_GONE}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { role: "treasurer" },
    });

    expect(response.status).toBe(404);
  });

  it("rejects a role the model does not have — including `owner`, which is an occupancy here", async () => {
    const owner = await call("patch", `/v1/members/${M_RESIDENT}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { role: "owner" },
    });
    const sql = await call("patch", `/v1/members/${M_RESIDENT}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { role: "committee" },
    });

    expect(owner.status).toBe(422);
    expect(owner.body.error.code).toBe("VALIDATION_ERROR");
    expect(owner.body.error.field).toBe("role");
    // The database's spelling is not the wire's: the contract carries `committee_member`, and a
    // client that sent the enum label is told so rather than meeting a 500 from a failed cast.
    expect(sql.status).toBe(422);
  });

  it("rejects an unknown key in the body — a client cannot ask for a permission", async () => {
    const response = await call("patch", `/v1/members/${M_RESIDENT}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { role: "treasurer", permissions: ["expense.approve"] },
    });

    // 400, not 422: an unknown field is a *shape* failure (SAD §7.8 stage 1), and the strict
    // contract is what makes a smuggled `permissions` field a rejected request rather than an
    // ignored one — the whole point of there being no grant a client can send.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(roleOf(M_RESIDENT)).toBe("resident");
  });

  it("requires a session and a society header like every other route", async () => {
    const anonymous = await call("patch", `/v1/members/${M_RESIDENT}/role`, {
      societyId: SOCIETY_A,
      body: { role: "treasurer" },
    });
    const headerless = await call("patch", `/v1/members/${M_RESIDENT}/role`, {
      userId: ADMIN,
      body: { role: "treasurer" },
    });

    expect(anonymous.status).toBe(401);
    expect(headerless.status).toBe(400);
    expect(roleOf(M_RESIDENT)).toBe("resident");
  });
});

describe("revoking a role", () => {
  it("returns a Treasurer to the default role and answers with what they now hold", async () => {
    const response = await call("delete", `/v1/members/${M_TREASURER}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    const data = permissionsOf(response.body);
    expect(data.role).toBe("resident");
    expect(data.permissions).toEqual(actionsFor("resident"));
    expect(roleOf(M_TREASURER)).toBe("resident");
  });

  it("refuses a no-op — the member does not hold a role to revoke", async () => {
    const response = await call("delete", `/v1/members/${M_RESIDENT}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
  });

  it("refuses a Treasurer", async () => {
    const response = await call("delete", `/v1/members/${M_SPARE}/role`, {
      userId: TREASURER,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(roleOf(M_SPARE)).toBe("committee_member");
  });

  it("refuses an Admin their own revocation", async () => {
    const response = await call("delete", `/v1/members/${M_ADMIN}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(roleOf(M_ADMIN)).toBe("admin");
  });

  it("refuses a membership that is not admitted", async () => {
    const response = await call("delete", `/v1/members/${M_PENDING}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(409);
  });

  it("answers 404 for a removed member", async () => {
    const response = await call("delete", `/v1/members/${M_GONE}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(404);
  });

  it("demotes one of several Admins — the last-admin case is the trigger's, proven by the canary", async () => {
    // Through this path an Admin can never demote the *final* admin: the caller is an active Admin
    // themselves, so at least one other remains, and the use case's own presence count says so
    // (see `role-change.ts`). This asserts the ordinary rotation; `chk_admin_present()` and the
    // path around the guard — suspension, removal, a repair script — are asserted against a real
    // database in `scripts/db/rls-canary.sql`.
    const response = await call("delete", `/v1/members/${M_ADMIN_3}/role`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(permissionsOf(response.body).role).toBe("resident");
    expect(roleOf(M_ADMIN_3)).toBe("resident");
  });
});
