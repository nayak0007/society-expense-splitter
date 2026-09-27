import { createHash, randomUUID } from "node:crypto";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  InvitationError,
  asInvitationId,
  asMemberId,
  asSocietyId,
  asUserId,
} from "@ses/domain";
import type {
  InvitationPreview,
  MemberRole,
  MembershipStatus,
  Society,
  SocietyId,
  SocietyMembership,
  UserId,
} from "@ses/domain";
import request from "supertest";

import type { SocietyAuthorizationContext } from "../src/common/authorization/society-authorization";
import { FakeInvitationRepository } from "./utils/fake-invitation-repository";
import {
  createFakeMemberRepository,
  type FakeMemberRepository,
} from "./utils/fake-member-repository";
import { createTestAuth, type TestAuth } from "./utils/supabase-auth";
import { createTestApp } from "./utils/test-app";

/**
 * The invitation routes over real HTTP (Roadmap T047).
 *
 * ## What runs for real
 *
 * The whole guard chain — a real signature verified against a locally held key pair, `SocietyGuard`
 * resolving `X-Society-Id`, `PermissionGuard` asking the domain's matrix — plus the Zod pipes parsing
 * the real contract, the real use cases, the real mappers with their output parse, the real **token
 * service** (sha256, not a stub), the response envelope and the exception filter.
 *
 * ## What does not
 *
 * Storage and RLS: the invitation repository is a fake, so no policy is evaluated and no trigger
 * fires. `scripts/db/rls-canary.sql` is what covers those — the duplicate-live index, the recipient
 * trigger, the single-use lock, the shadow link — and it asserts the guard-bypassed path is still
 * refused.
 *
 * ## The four things this suite is for
 *
 *  1. **The token is a credential.** It appears in exactly one response, never in the list or the
 *     detail, and what storage receives is its digest — asserted against the real hasher rather than
 *     against a stub that agrees with itself.
 *  2. **The three route shapes.** A society-scoped management route (`member.invite`), a `@Public()`
 *     preview that a signed-out caller can reach, and an acceptance that needs a verified account and
 *     no membership at all.
 *  3. **The refusals the guard cannot see**: a Treasurer inviting at a role they cannot hand out, a
 *     shareable link above Resident, and a revoke of something already accepted — each with the
 *     `DETAIL_CODES` value its screen branches on.
 *  4. **Cross-society denial** on an invitation id, answering `404` and never `403` (PRD T041).
 */

const SOCIETY_A = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const SOCIETY_B = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

const ADMIN: UserId = asUserId("11111111-1111-4111-8111-111111111111");
const TREASURER: UserId = asUserId("22222222-2222-4222-8222-222222222222");
const RESIDENT: UserId = asUserId("33333333-3333-4333-8333-333333333333");
const PENDING: UserId = asUserId("55555555-5555-4555-8555-555555555555");
const INVITEE: UserId = asUserId("77777777-7777-4777-8777-777777777777");

const M_ADMIN = "aaaaaaaa-0000-4000-8000-000000000001";
const M_TREASURER = "aaaaaaaa-0000-4000-8000-000000000002";
const M_FOREIGN = "aaaaaaaa-0000-4000-8000-000000000009";
const NOT_A_UUID = "not-a-uuid";

/** The digest a token is stored under — computed with the same primitive the service uses. */
const digest = (token: string) =>
  createHash("sha256").update(token).digest("hex");

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

let app: NestFastifyApplication;
let auth: TestAuth;
let members: FakeMemberRepository;
let invitations: FakeInvitationRepository;

beforeAll(async () => {
  auth = await createTestAuth();
  members = createFakeMemberRepository();
  invitations = new FakeInvitationRepository();
  app = await createTestApp({
    jwks: auth.jwks,
    reader,
    members,
    invitations,
  });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  memberships.clear();
  members.state.reset();
  invitations.reset();

  memberships.set(key(SOCIETY_A, ADMIN), membershipOf(ADMIN, "admin"));
  memberships.set(
    key(SOCIETY_A, TREASURER),
    membershipOf(TREASURER, "treasurer"),
  );
  memberships.set(key(SOCIETY_A, RESIDENT), membershipOf(RESIDENT, "resident"));
  memberships.set(
    key(SOCIETY_A, PENDING),
    membershipOf(PENDING, "resident", "pending"),
  );
  memberships.set(key(SOCIETY_B, ADMIN), {
    ...membershipOf(ADMIN, "admin"),
    societyId: SOCIETY_B,
  });

  // The caller's own membership, which the *use cases* read through the member port — the guard
  // reads `memberships` above. Both must agree for a route to succeed, which is what makes the
  // capability assertions below meaningful.
  members.seed(SOCIETY_A, {
    id: M_ADMIN,
    userId: ADMIN,
    role: "admin",
    displayName: "Anita Rao",
  });
  members.seed(SOCIETY_A, {
    id: M_TREASURER,
    userId: TREASURER,
    role: "treasurer",
    displayName: "Bharat Shah",
  });
  members.seed(SOCIETY_A, {
    id: randomUUID(),
    userId: RESIDENT,
    role: "resident",
    displayName: "Meera Krishnan",
  });
  members.seed(SOCIETY_A, {
    id: randomUUID(),
    userId: PENDING,
    role: "resident",
    displayName: "Pending Applicant",
    status: "pending",
  });
  members.seed(SOCIETY_A, {
    id: M_FOREIGN,
    userId: randomUUID(),
    role: "resident",
    displayName: "Foreign Member",
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

interface InvitationDto {
  readonly id: string;
  readonly role: string;
  readonly status: string;
  readonly expired: boolean;
  readonly inviteeHint: string;
  readonly email: string | null;
  readonly channel: string;
  readonly expiresAt: string;
}

describe("POST /v1/invitations", () => {
  it("creates an invitation and returns the token exactly once", async () => {
    const response = await call("post", "/v1/invitations", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { channel: "email", email: "invitee@canary.ses.test" },
    });

    expect(response.status).toBe(201);
    const invitation = response.body.data.invitation as InvitationDto;
    const token = response.body.data.token as string;

    expect(invitation.status).toBe("sent");
    expect(invitation.role).toBe("resident");
    expect(invitation.expired).toBe(false);
    // The mask the recipient's preview will show, computed from the same function.
    expect(invitation.inviteeHint).toBe("in***@canary.ses.test");
    expect(response.body.data.path).toBe(`/invite/${token}`);
    expect(response.body.data.expiresInDays).toBe(14);

    // The property that matters: storage saw a digest, and it was the digest *of the token*.
    expect(invitations.digestsSeen()).toEqual([digest(token)]);
    expect(invitations.digestsSeen()).not.toContain(token);
  });

  it("refuses a shareable link above Resident with the code its screen branches on", async () => {
    const response = await call("post", "/v1/invitations", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { channel: "link", role: "admin" },
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.details[0].code).toBe(
      "INVITATION_OPEN_LINK_ROLE",
    );
    expect(invitations.digestsSeen()).toEqual([]);
  });

  it("lets a Treasurer invite at Resident, and refuses anything above it", async () => {
    const allowed = await call("post", "/v1/invitations", {
      userId: TREASURER,
      societyId: SOCIETY_A,
      body: { channel: "whatsapp", phone: "+919800000901" },
    });
    expect(allowed.status).toBe(201);

    const refused = await call("post", "/v1/invitations", {
      userId: TREASURER,
      societyId: SOCIETY_A,
      body: { channel: "whatsapp", phone: "+919800000902", role: "treasurer" },
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.details[0].code).toBe(
      "INVITATION_ROLE_NOT_ASSIGNABLE",
    );
  });

  it("refuses an ordinary member and a pending one", async () => {
    for (const userId of [RESIDENT, PENDING]) {
      const response = await call("post", "/v1/invitations", {
        userId,
        societyId: SOCIETY_A,
        body: { channel: "email", email: "somebody@canary.ses.test" },
      });
      expect(response.status).toBe(403);
    }
    expect(invitations.digestsSeen()).toEqual([]);
  });

  it("requires a token and a society header", async () => {
    const anonymous = await call("post", "/v1/invitations", {
      societyId: SOCIETY_A,
      body: { channel: "email", email: "somebody@canary.ses.test" },
    });
    expect(anonymous.status).toBe(401);

    const headerless = await call("post", "/v1/invitations", {
      userId: ADMIN,
      body: { channel: "email", email: "somebody@canary.ses.test" },
    });
    expect(headerless.status).toBe(400);
  });

  it("validates the body against the shared contract", async () => {
    // An unknown key is a caller mistake worth naming (SAD §7.8 stage 1) — and `400`, not `422`:
    // the pipe separates *syntactic* issues (a key that should not be there) from *semantic* ones
    // (a shape that is right but whose values are not). There is no field to ask for a permission
    // with, which is the security property the contract rests on.
    const unknownKey = await call("post", "/v1/invitations", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: {
        channel: "email",
        email: "invitee@canary.ses.test",
        permission: "member.role_change",
      },
    });
    expect(unknownKey.status).toBe(400);

    // A link with an address is not a link — the two are mutually exclusive.
    const addressedLink = await call("post", "/v1/invitations", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { channel: "link", email: "invitee@canary.ses.test" },
    });
    expect(addressedLink.status).toBe(422);

    // And a targeted channel without one cannot reach anybody.
    const unaddressed = await call("post", "/v1/invitations", {
      userId: ADMIN,
      societyId: SOCIETY_A,
      body: { channel: "sms" },
    });
    expect(unaddressed.status).toBe(422);
  });
});

describe("GET /v1/invitations", () => {
  it("lists the society's invitations with expiry folded in", async () => {
    invitations.seedInvitation({
      societyId: SOCIETY_A,
      expiresAt: "2026-09-01T10:00:00.000Z",
    });
    invitations.seedInvitation({ societyId: SOCIETY_A });
    invitations.seedInvitation({ societyId: SOCIETY_B });

    const response = await call("get", "/v1/invitations", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.total).toBe(2);
    const rows = response.body.data.invitations as InvitationDto[];
    expect(rows.map((row) => row.expired).sort()).toEqual([false, true]);
    // The stored status is untouched by the derivation — the two facts travel separately.
    expect(rows.map((row) => row.status)).toEqual(["sent", "sent"]);
    // And no credential anywhere in the payload.
    expect(JSON.stringify(response.body)).not.toContain("token");
  });

  it("filters by status", async () => {
    invitations.seedInvitation({ societyId: SOCIETY_A, status: "accepted" });
    invitations.seedInvitation({ societyId: SOCIETY_A });

    const response = await call("get", "/v1/invitations?status=accepted", {
      userId: TREASURER,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.total).toBe(1);
  });

  it("refuses an ordinary member", async () => {
    const response = await call("get", "/v1/invitations", {
      userId: RESIDENT,
      societyId: SOCIETY_A,
    });
    expect(response.status).toBe(403);
  });
});

describe("GET /v1/invitations/:invitationId", () => {
  it("answers 404 for another society's invitation, and for an unknown id", async () => {
    const foreign = invitations.seedInvitation({ societyId: SOCIETY_B });

    const crossTenant = await call("get", `/v1/invitations/${foreign.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(crossTenant.status).toBe(404);

    const missing = await call("get", `/v1/invitations/${randomUUID()}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(missing.status).toBe(404);
  });

  it("validates the path parameter before querying", async () => {
    const response = await call("get", `/v1/invitations/${NOT_A_UUID}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(response.status).toBe(422);
  });

  it("returns one of this society's", async () => {
    const row = invitations.seedInvitation({
      societyId: SOCIETY_A,
      email: "somebody@canary.ses.test",
    });

    const response = await call("get", `/v1/invitations/${row.id}`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.id).toBe(row.id);
    expect(response.body.data.inviteeHint).toBe("so***@canary.ses.test");
  });
});

describe("POST /v1/invitations/:invitationId/revoke", () => {
  it("revokes a live invitation", async () => {
    const row = invitations.seedInvitation({ societyId: SOCIETY_A });

    const response = await call("post", `/v1/invitations/${row.id}/revoke`, {
      userId: TREASURER,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe("revoked");
    expect(response.body.data.revokedAt).not.toBeNull();
  });

  it("refuses one that was already accepted, with the code the screen reads", async () => {
    const row = invitations.seedInvitation({
      societyId: SOCIETY_A,
      status: "accepted",
    });

    const response = await call("post", `/v1/invitations/${row.id}/revoke`, {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("CONFLICT");
    expect(response.body.error.details[0].code).toBe(
      "INVITATION_NOT_ACCEPTABLE",
    );
  });
});

describe("GET /v1/invitations/preview/:token", () => {
  const preview: InvitationPreview = {
    id: asInvitationId("invitation-1"),
    societyId: SOCIETY_A,
    societyName: "Green Meadows",
    role: "resident",
    apartmentId: null,
    apartmentNumber: "R-101",
    channel: "email",
    inviteeHint: "in***@canary.ses.test",
    requiresAccountMatch: true,
    status: "opened",
    expired: false,
    expiresAt: "2026-10-10T10:00:00.000Z",
  };

  it("is reachable signed out — no token header, no society header", async () => {
    const token = "canary-token-1-xxxxxxxxxxxxxxxxxxxxxxxx";
    invitations.seedPreview(digest(token), preview);

    const response = await call("get", `/v1/invitations/preview/${token}`, {
      societyId: null,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.societyName).toBe("Green Meadows");
    expect(response.body.data.inviteeHint).toBe("in***@canary.ses.test");
    expect(response.body.data.requiresAccountMatch).toBe(true);
    expect(response.body.data.apartmentNumber).toBe("R-101");
  });

  it("answers 404 for an unknown token and 422 for a malformed one", async () => {
    const unknown = await call(
      "get",
      "/v1/invitations/preview/a-token-nobody-holds",
      {
        societyId: null,
      },
    );
    expect(unknown.status).toBe(404);

    const malformed = await call("get", "/v1/invitations/preview/short", {
      societyId: null,
    });
    expect(malformed.status).toBe(422);
  });
});

describe("POST /v1/invitations/accept/:token", () => {
  const token = "canary-token-2-xxxxxxxxxxxxxxxxxxxxxxxx";

  it("requires a verified account — and no membership", async () => {
    invitations.seedAcceptance(digest(token), {
      societyId: SOCIETY_A,
      memberId: asMemberId(randomUUID()),
      role: "tenant",
      apartmentId: null,
      linkedShadow: true,
    });

    const anonymous = await call("post", `/v1/invitations/accept/${token}`, {
      societyId: null,
    });
    expect(anonymous.status).toBe(401);

    // INVITEE has no membership in SOCIETY_A at all: the token is the authority, and the route
    // needs no society header.
    const accepted = await call("post", `/v1/invitations/accept/${token}`, {
      userId: INVITEE,
      societyId: null,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.role).toBe("tenant");
    expect(accepted.body.data.linkedShadow).toBe(true);
    expect(accepted.body.data.societyId).toBe(SOCIETY_A);
  });

  it("passes the database's refusal through with its own code", async () => {
    const expired = "canary-token-3-xxxxxxxxxxxxxxxxxxxxxxxx";
    invitations.seedAcceptance(
      digest(expired),
      new InvitationError("invitation_expired", "That invitation has expired."),
    );

    const response = await call("post", `/v1/invitations/accept/${expired}`, {
      userId: INVITEE,
      societyId: null,
    });

    expect(response.status).toBe(409);
    expect(response.body.error.details[0].code).toBe("INVITATION_EXPIRED");
  });

  it("passes the recipient mismatch through as a refusal, not a 404", async () => {
    const mismatch = "canary-token-4-xxxxxxxxxxxxxxxxxxxxxxxx";
    invitations.seedAcceptance(
      digest(mismatch),
      new InvitationError(
        "invitation_recipient_mismatch",
        "That invitation is for a different person.",
      ),
    );

    const response = await call("post", `/v1/invitations/accept/${mismatch}`, {
      userId: INVITEE,
      societyId: null,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.details[0].code).toBe(
      "INVITATION_RECIPIENT_MISMATCH",
    );
  });
});
