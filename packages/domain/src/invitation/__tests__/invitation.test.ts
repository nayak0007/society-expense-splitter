import { invitationErrorCode } from "../errors";
import {
  checkInvitationAcceptable,
  checkInviteRole,
  checkOpenLinkInvite,
  DEFAULT_INVITATION_ROLE,
  INVITATION_CHANNELS,
  INVITATION_STATUSES,
  INVITATION_TTL_DAYS,
  invitationExpiry,
  invitationStatusAt,
  isInvitationChannel,
  isInvitationLive,
  isInvitationStatus,
  maskInvitee,
  rolesInvitableBy,
} from "../invitation";
import { MEMBER_ROLES } from "../../society/society";
import type { MemberRole } from "../../society/society";

/**
 * T047's invitation rules — PRD §3.3's fourteen days and PRD §7.2's vocabulary.
 *
 * The vocabulary assertions are written against the *literal* PRD values rather than against the
 * constants, for the reason `role-rules.test.ts` records: a change to a constant should be a
 * deliberate act with a failing test in front of it. They also mirror the migration's own
 * `CHECK` constraints, so a value that exists in TypeScript but not in `public.invitation_status`'s
 * equivalent is caught here rather than as a `22P02` at runtime.
 */

const NOW = new Date("2026-09-26T10:00:00.000Z");

function live(expiresAt: string) {
  return { status: "sent" as const, expiresAt };
}

describe("the invitation vocabulary", () => {
  it("is PRD §7.2's enum, verbatim", () => {
    expect([...INVITATION_STATUSES].sort()).toEqual(
      ["accepted", "expired", "opened", "revoked", "sent"].sort(),
    );
  });

  it("is PRD §7.2's channel list, verbatim", () => {
    expect([...INVITATION_CHANNELS].sort()).toEqual(
      ["whatsapp", "sms", "email", "link"].sort(),
    );
  });

  it("expires after the fourteen days PRD §3.3 states", () => {
    expect(INVITATION_TTL_DAYS).toBe(14);
    expect(invitationExpiry(NOW)).toBe("2026-10-10T10:00:00.000Z");
  });

  it("narrows unknown strings", () => {
    expect(isInvitationStatus("opened")).toBe(true);
    expect(isInvitationStatus("pending")).toBe(false);
    expect(isInvitationChannel("whatsapp")).toBe(true);
    expect(isInvitationChannel("push")).toBe(false);
  });

  it("calls exactly two statuses live", () => {
    expect(INVITATION_STATUSES.filter(isInvitationLive)).toEqual([
      "sent",
      "opened",
    ]);
  });
});

describe("invitationStatusAt", () => {
  it("folds expiry into a live invitation", () => {
    expect(invitationStatusAt(live("2026-09-25T10:00:00.000Z"), NOW)).toBe(
      "expired",
    );
    expect(invitationStatusAt(live("2026-09-27T10:00:00.000Z"), NOW)).toBe(
      "sent",
    );
  });

  it("leaves a decision alone, however old it is", () => {
    // The row is the record of what somebody did; expiry is about what is still possible.
    expect(
      invitationStatusAt(
        { status: "accepted", expiresAt: "2026-09-01T10:00:00.000Z" },
        NOW,
      ),
    ).toBe("accepted");
    expect(
      invitationStatusAt(
        { status: "revoked", expiresAt: "2026-09-01T10:00:00.000Z" },
        NOW,
      ),
    ).toBe("revoked");
  });
});

describe("maskInvitee", () => {
  it("mirrors the database's mask for an address", () => {
    // Byte-identical to `invitation_preview()`'s CASE, and asserted so: two masks that differ by a
    // character are two different promises about what a link holder may learn.
    expect(maskInvitee({ email: "invitee@canary.ses.test" })).toBe(
      "in***@canary.ses.test",
    );
    // Two characters, even when the second one is the `@` — the database's `left(email, 2)` does
    // the same, and a mask that tidied this up would stop being the mask the preview returns.
    expect(maskInvitee({ email: "a@b.test" })).toBe("a@***@b.test");
  });

  it("shows the last four digits of a number", () => {
    expect(maskInvitee({ phone: "+919800000908" })).toBe("••••0908");
  });

  it("prefers the address, which is the one the account matches on", () => {
    expect(
      maskInvitee({ email: "invitee@canary.ses.test", phone: "+919800000908" }),
    ).toBe("in***@canary.ses.test");
  });

  it("says what an unaddressed link is", () => {
    expect(maskInvitee({})).toBe("Anyone with this link");
    expect(maskInvitee({ email: null, phone: null })).toBe(
      "Anyone with this link",
    );
  });
});

describe("rolesInvitableBy", () => {
  it("gives an Admin every role, in PRD order", () => {
    expect(rolesInvitableBy("admin")).toEqual([
      "admin",
      "treasurer",
      "committee_member",
      "resident",
      "tenant",
      "guest",
    ]);
  });

  it("gives everybody else the default role and nothing above it", () => {
    // `member.invite` without `member.role_change`: a Treasurer keeps the directory moving without
    // becoming a way to appoint officers.
    const others: MemberRole[] = MEMBER_ROLES.filter(
      (role) => role !== "admin",
    );
    for (const role of others) {
      expect(rolesInvitableBy(role)).toEqual([DEFAULT_INVITATION_ROLE]);
    }
  });
});

describe("checkInviteRole", () => {
  it("refuses a Treasurer inviting at the Treasurer role", () => {
    const refused = checkInviteRole("treasurer", "treasurer");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("invitation_role_not_assignable");
      expect(refused.error.details?.field).toBe("role");
    }
  });

  it("refuses a resident inviting at any role above Resident", () => {
    expect(checkInviteRole("resident", "committee_member").ok).toBe(false);
    expect(checkInviteRole("guest", "tenant").ok).toBe(false);
  });

  it("allows an Admin any role, and everybody the default one", () => {
    for (const role of MEMBER_ROLES) {
      expect(checkInviteRole("admin", role).ok).toBe(true);
      expect(checkInviteRole("treasurer", "resident").ok).toBe(true);
    }
  });
});

describe("checkOpenLinkInvite", () => {
  it("refuses an unaddressed link above Resident", () => {
    // A link is a bearer credential: whoever holds it would hold the role.
    const refused = checkOpenLinkInvite("link", false, "admin");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("invitation_open_link_role");
    }
    expect(checkOpenLinkInvite("link", false, "treasurer").ok).toBe(false);
  });

  it("allows a link at Resident, and any role when there is a recipient", () => {
    expect(checkOpenLinkInvite("link", false, "resident").ok).toBe(true);
    expect(checkOpenLinkInvite("whatsapp", true, "admin").ok).toBe(true);
    expect(checkOpenLinkInvite("email", true, "treasurer").ok).toBe(true);
  });

  it("treats a targeted channel with no recipient as not-a-link", () => {
    // The contract refuses that shape (a channel needs an address); this rule is about the role.
    expect(checkOpenLinkInvite("sms", false, "admin").ok).toBe(true);
  });
});

describe("checkInvitationAcceptable", () => {
  it("accepts a live, unexpired invitation", () => {
    expect(
      checkInvitationAcceptable(live("2026-09-27T10:00:00.000Z"), NOW).ok,
    ).toBe(true);
    expect(
      checkInvitationAcceptable(
        { status: "opened", expiresAt: "2026-09-27T10:00:00.000Z" },
        NOW,
      ).ok,
    ).toBe(true);
  });

  it("refuses an expired one, with the reason that matters to the recipient", () => {
    const refused = checkInvitationAcceptable(
      live("2026-09-25T10:00:00.000Z"),
      NOW,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("invitation_expired");
  });

  it("refuses one that was already accepted", () => {
    const refused = checkInvitationAcceptable(
      { status: "accepted", expiresAt: "2026-09-27T10:00:00.000Z" },
      NOW,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("invitation_not_acceptable");
      expect(refused.error.message).toContain("already been accepted");
    }
  });

  it("refuses a revoked one, and says so rather than blaming the clock", () => {
    // State before clock: this invitation is also past its expiry, and the honest answer is the
    // decision somebody made, not the date. The same order is asserted in the canary.
    const refused = checkInvitationAcceptable(
      { status: "revoked", expiresAt: "2026-09-01T10:00:00.000Z" },
      NOW,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("invitation_not_acceptable");
      expect(refused.error.message).toContain("revoked");
    }
  });
});

describe("invitationErrorCode", () => {
  it("is `unknown` for anything that is not an InvitationError", () => {
    expect(invitationErrorCode(new Error("boom"))).toBe("unknown");
    expect(invitationErrorCode(undefined)).toBe("unknown");
  });
});
