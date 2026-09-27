import {
  asApartmentId,
  asInvitationId,
  asMemberId,
  asSocietyId,
  asUserId,
  invitationError,
} from "@ses/domain";
import type { Clock, InvitationPreview } from "@ses/domain";

import { FakeMemberRepository } from "../../member/__tests__/support/fake-member-repository";
import { TEST_NOW } from "../../structure/__tests__/support/fake-building-repository";
import {
  acceptInvitation,
  createInvitation,
  getInvitation,
  listInvitations,
  previewInvitation,
  revokeInvitation,
} from "../use-cases";
import {
  FakeInvitationRepository,
  FakeInvitationTokens,
} from "./support/fake-invitation-repository";

/**
 * T047's use cases, with the database faked out.
 *
 * These assert the **decisions** — who may invite, at which role, what happens to a dead link — and
 * deliberately not the database's own refusals (the caps, the duplicate-live index, the single-use
 * lock, the shadow link). Those are the migration's and the canary's, and a fake that enforced them
 * would make this suite green for the wrong reason.
 */

// Branded at the edge, as the API brands them: the use cases take `SocietyId`, and a test that
// passed a raw string would be testing a call the controller cannot make.
const SOCIETY = asSocietyId("society-1");
const OTHER_SOCIETY = asSocietyId("society-2");
const ADMIN = asUserId("user-admin");
const TREASURER = asUserId("user-treasurer");
const RESIDENT = asUserId("user-resident");
const PENDING = asUserId("user-pending");
const STRANGER = asUserId("user-stranger");

/** `TEST_NOW` plus PRD §3.3's fourteen days — the expiry every created row carries. */
const EXPIRY = "2026-10-08T10:00:00.000Z";

interface Harness {
  readonly deps: {
    invitations: FakeInvitationRepository;
    members: FakeMemberRepository;
    tokens: FakeInvitationTokens;
    clock: Clock;
  };
  readonly members: FakeMemberRepository;
  readonly invitations: FakeInvitationRepository;
  readonly tokens: FakeInvitationTokens;
}

function harness(): Harness {
  const members = new FakeMemberRepository();
  members.seedMember(SOCIETY, {
    userId: ADMIN,
    role: "admin",
    status: "active",
  });
  members.seedMember(SOCIETY, {
    userId: TREASURER,
    role: "treasurer",
    status: "active",
  });
  members.seedMember(SOCIETY, {
    userId: RESIDENT,
    role: "resident",
    status: "active",
  });
  members.seedMember(SOCIETY, {
    userId: PENDING,
    role: "resident",
    status: "pending",
  });

  const invitations = new FakeInvitationRepository();
  const tokens = new FakeInvitationTokens();
  const clock: Clock = {
    now: () => new Date(TEST_NOW),
    nowIso: () => TEST_NOW,
  };

  return {
    deps: { invitations, members, tokens, clock },
    members,
    invitations,
    tokens,
  };
}

describe("createInvitation", () => {
  it("creates a targeted invitation at the default role", async () => {
    const { deps } = harness();

    const created = await createInvitation(deps, ADMIN, SOCIETY, {
      channel: "email",
      email: "invitee@canary.ses.test",
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.invitation.status).toBe("sent");
    expect(created.value.invitation.role).toBe("resident");
    expect(created.value.invitation.expiresAt).toBe(EXPIRY);
    // `invited_by` is the *membership*, resolved by the database from the caller — never a field
    // this layer could set.
    expect(created.value.invitation.invitedBy).toBe(
      asMemberId("member-inviter"),
    );
  });

  it("stores the digest and never the token", async () => {
    const { deps, invitations } = harness();

    const created = await createInvitation(deps, ADMIN, SOCIETY, {
      channel: "email",
      email: "invitee@canary.ses.test",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // The row's own `chk_invitations_token_hash` insists on this shape, and the credential itself
    // must not be anywhere near it.
    expect(invitations.lastTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(invitations.lastTokenHash).not.toBe(created.value.token);
    expect(created.value.token.length).toBeGreaterThan(16);
  });

  it("lets a Treasurer invite a Resident, and nobody else's role above it", async () => {
    const { deps, invitations } = harness();

    const allowed = await createInvitation(deps, TREASURER, SOCIETY, {
      channel: "whatsapp",
      phone: "+919800000901",
    });
    expect(allowed.ok).toBe(true);

    const refused = await createInvitation(deps, TREASURER, SOCIETY, {
      channel: "whatsapp",
      phone: "+919800000902",
      role: "treasurer",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("invitation_role_not_assignable");
    }
    // Validation happens before I/O: only the allowed invitation was written.
    expect(invitations.calls().filter((call) => call === "create").length).toBe(
      1,
    );
  });

  it("refuses a shareable link above Resident", async () => {
    const { deps, invitations } = harness();

    const refused = await createInvitation(deps, ADMIN, SOCIETY, {
      channel: "link",
      role: "admin",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok)
      expect(refused.error.code).toBe("invitation_open_link_role");
    expect(invitations.calls()).toEqual([]);

    const allowed = await createInvitation(deps, ADMIN, SOCIETY, {
      channel: "link",
    });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.value.invitation.email).toBeNull();
    expect(allowed.value.invitation.phone).toBeNull();
    expect(allowed.value.invitation.channel).toBe("link");
  });

  it("lets an Admin invite at any role, and carries the flat through", async () => {
    const { deps } = harness();

    const created = await createInvitation(deps, ADMIN, SOCIETY, {
      channel: "email",
      email: "officer@canary.ses.test",
      role: "committee_member",
      apartmentId: asApartmentId("apartment-1"),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.invitation.role).toBe("committee_member");
    expect(created.value.invitation.apartmentId).toBe("apartment-1");
  });

  it("refuses an ordinary member with a capability reason, before any role question", async () => {
    const { deps, invitations } = harness();

    const refused = await createInvitation(deps, RESIDENT, SOCIETY, {
      channel: "email",
      email: "somebody@canary.ses.test",
      role: "admin",
    });
    expect(refused.ok).toBe(false);
    // `forbidden` — not "you cannot invite at Admin": the capability is checked first, and it is
    // the answer that is true no matter which role was asked for.
    if (!refused.ok) expect(refused.error.code).toBe("forbidden");
    expect(invitations.calls()).toEqual([]);
  });

  it("refuses a pending member and a stranger", async () => {
    const { deps } = harness();

    const pending = await createInvitation(deps, PENDING, SOCIETY, {
      channel: "email",
      email: "somebody@canary.ses.test",
    });
    expect(pending.ok).toBe(false);
    if (!pending.ok) expect(pending.error.code).toBe("forbidden");

    const stranger = await createInvitation(deps, STRANGER, SOCIETY, {
      channel: "email",
      email: "somebody@canary.ses.test",
    });
    expect(stranger.ok).toBe(false);
    // Not `forbidden`: a non-member cannot tell a society they are outside of from one that does
    // not exist (PRD T041).
    if (!stranger.ok) expect(stranger.error.code).toBe("not_found");
  });

  it("reports an adapter failure as `unknown`", async () => {
    const { deps, invitations } = harness();
    invitations.failNext("create", new Error("connection reset"));

    const failed = await createInvitation(deps, ADMIN, SOCIETY, {
      channel: "email",
      email: "invitee@canary.ses.test",
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe("unknown");
  });
});

describe("listInvitations", () => {
  it("returns the page and forwards the status filter", async () => {
    const { deps, invitations } = harness();
    invitations.seedInvitation({ societyId: SOCIETY, status: "sent" });
    invitations.seedInvitation({ societyId: SOCIETY, status: "accepted" });
    invitations.seedInvitation({ societyId: OTHER_SOCIETY, status: "sent" });

    const page = await listInvitations(deps, TREASURER, SOCIETY, {});
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.total).toBe(2);

    const filtered = await listInvitations(deps, ADMIN, SOCIETY, {
      status: "accepted",
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.value.invitations.map((row) => row.status)).toEqual([
      "accepted",
    ]);
    expect(filtered.value.total).toBe(1);
  });

  it("refuses an ordinary member", async () => {
    const { deps } = harness();
    const refused = await listInvitations(deps, RESIDENT, SOCIETY, {});
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("forbidden");
  });
});

describe("getInvitation", () => {
  it("finds one of this society's", async () => {
    const { deps, invitations } = harness();
    const row = invitations.seedInvitation({ societyId: SOCIETY });

    const found = await getInvitation(deps, ADMIN, SOCIETY, row.id);
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.value.id).toBe(row.id);
  });

  it("answers `not_found` for another society's — the same answer as a missing one", async () => {
    const { deps, invitations } = harness();
    const foreign = invitations.seedInvitation({ societyId: OTHER_SOCIETY });

    const crossTenant = await getInvitation(deps, ADMIN, SOCIETY, foreign.id);
    expect(crossTenant.ok).toBe(false);
    if (!crossTenant.ok) expect(crossTenant.error.code).toBe("not_found");

    const missing = await getInvitation(
      deps,
      ADMIN,
      SOCIETY,
      asInvitationId("invitation-does-not-exist"),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("not_found");
  });
});

describe("revokeInvitation", () => {
  it("revokes a live invitation", async () => {
    const { deps, invitations } = harness();
    const row = invitations.seedInvitation({ societyId: SOCIETY });

    const revoked = await revokeInvitation(deps, ADMIN, SOCIETY, row.id);
    expect(revoked.ok).toBe(true);
    if (revoked.ok) {
      expect(revoked.value.status).toBe("revoked");
      expect(revoked.value.revokedAt).not.toBeNull();
    }
    expect(invitations.calls()).toContain("revoke");
  });

  it("refuses to revoke one that was already accepted — and does not call the write", async () => {
    const { deps, invitations } = harness();
    const row = invitations.seedInvitation({
      societyId: SOCIETY,
      status: "accepted",
    });

    const refused = await revokeInvitation(deps, ADMIN, SOCIETY, row.id);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("invitation_not_acceptable");
      expect(refused.error.message).toContain("accepted");
    }
    expect(invitations.calls()).not.toContain("revoke");
  });

  it("still allows revoking one that has expired — expiry is not a decision", async () => {
    const { deps, invitations } = harness();
    const row = invitations.seedInvitation({
      societyId: SOCIETY,
      expiresAt: "2026-09-01T10:00:00.000Z",
    });

    const revoked = await revokeInvitation(deps, TREASURER, SOCIETY, row.id);
    expect(revoked.ok).toBe(true);
  });

  it("refuses an ordinary member", async () => {
    const { deps, invitations } = harness();
    const row = invitations.seedInvitation({ societyId: SOCIETY });

    const refused = await revokeInvitation(deps, RESIDENT, SOCIETY, row.id);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("forbidden");
    expect(invitations.calls()).toEqual([]);
  });
});

describe("previewInvitation", () => {
  const preview: InvitationPreview = {
    id: asInvitationId("invitation-1"),
    societyId: asSocietyId(SOCIETY),
    societyName: "Canary Court",
    role: "resident",
    apartmentId: null,
    apartmentNumber: "R-101",
    channel: "email",
    inviteeHint: "in***@canary.ses.test",
    requiresAccountMatch: true,
    status: "opened",
    expired: false,
    expiresAt: EXPIRY,
  };

  it("hashes the token before asking the port", async () => {
    const { deps, invitations, tokens } = harness();
    invitations.seedPreview(tokens.hash("a-link-token-value"), preview);
    expect(tokens.hash("a-link-token-value")).toMatch(/^[0-9a-f]{64}$/);

    const found = await previewInvitation(deps, "a-link-token-value");
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.value.societyName).toBe("Canary Court");
    // The digest travelled; the credential did not.
    expect(invitations.calls()).toEqual(["previewByTokenHash"]);
  });

  it("answers `invitation_not_found` for an unknown token", async () => {
    const { deps } = harness();
    const missing = await previewInvitation(deps, "not-a-real-token-value");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("invitation_not_found");
  });
});

describe("acceptInvitation", () => {
  it("hashes the token and returns the membership it produced", async () => {
    const { deps, invitations } = harness();
    invitations.seedAcceptance({
      societyId: asSocietyId(SOCIETY),
      memberId: asMemberId("member-linked"),
      role: "tenant",
      apartmentId: null,
      linkedShadow: true,
    });

    const accepted = await acceptInvitation(deps, ADMIN, "a-link-token-value");
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.linkedShadow).toBe(true);
    expect(accepted.value.role).toBe("tenant");
    expect(invitations.calls()).toContain("accept");
  });

  it("passes the database's refusal through with its own code", async () => {
    const { deps, invitations } = harness();
    invitations.failNext(
      "accept",
      invitationError("invitation_expired", "That invitation has expired."),
    );

    const refused = await acceptInvitation(deps, ADMIN, "a-link-token-value");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("invitation_expired");
  });

  it("accepts without any membership of its own — the token is the authority", async () => {
    const { deps, invitations } = harness();
    invitations.seedAcceptance({
      societyId: asSocietyId(SOCIETY),
      memberId: asMemberId("member-new"),
      role: "resident",
      apartmentId: null,
      linkedShadow: false,
    });

    // STRANGER has no membership in SOCIETY at all, and acceptance is still the right call: this is
    // the flow's whole point.
    const accepted = await acceptInvitation(
      deps,
      STRANGER,
      "a-link-token-value",
    );
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.value.linkedShadow).toBe(false);
  });
});
