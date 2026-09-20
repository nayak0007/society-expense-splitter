import {
  DEFAULT_SOCIETY_SETTINGS,
  activeAdmins,
  canDeleteSociety,
  canLeaveSociety,
  canManageSociety,
  defaultSocietySettings,
  evaluateSocietyCapabilities,
  findMembership,
  isJoinCodeExpired,
  isMembershipActive,
  isSocietyType,
  slugify,
} from "../rules";
import type { MemberRole } from "../society";
import { membership } from "./support/membership";

/**
 * The rules are the shared definition of "who may do what". The API's guard, the
 * RLS policy and the UI affordance all read them, so a regression here is a
 * security regression anywhere — which is why each rule is pinned directly, not
 * only through a use case.
 */
describe("slugify", () => {
  it("produces a URL-safe key", () => {
    expect(slugify("Green Valley Residency")).toBe("green-valley-residency");
  });

  it("strips diacritics and punctuation", () => {
    expect(slugify("Café Résidence, Block-C")).toBe("cafe-residence-block-c");
  });

  it("collapses runs of separators and trims them", () => {
    expect(slugify("  --Green   Valley--  ")).toBe("green-valley");
  });

  it("is idempotent", () => {
    const once = slugify("Green Valley Residency");
    expect(slugify(once)).toBe(once);
  });

  it("clamps to the column limit", () => {
    expect(slugify("a".repeat(300))).toHaveLength(180);
  });

  it("keeps digits and returns nothing for a name with nothing Latin in it", () => {
    expect(slugify("123")).toBe("123");
    expect(slugify("ग्रीन वैली")).toBe("");
  });
});

describe("defaultSocietySettings", () => {
  it("returns the column defaults", () => {
    expect(defaultSocietySettings()).toEqual(DEFAULT_SOCIETY_SETTINGS);
  });

  it("applies overrides without dropping the rest", () => {
    const settings = defaultSocietySettings({ dueDay: 20 });

    expect(settings.dueDay).toBe(20);
    expect(settings.billingDay).toBe(DEFAULT_SOCIETY_SETTINGS.billingDay);
  });

  it("defaults to a ₹10,000 approval threshold and an April financial year", () => {
    expect(DEFAULT_SOCIETY_SETTINGS.approvalThresholdPaise).toBe(1_000_000);
    expect(DEFAULT_SOCIETY_SETTINGS.financialYearStartMonth).toBe(4);
  });
});

describe("isSocietyType", () => {
  it("accepts a known type and rejects anything else", () => {
    expect(isSocietyType("apartment")).toBe(true);
    expect(isSocietyType("shared_flat")).toBe(true);
    expect(isSocietyType("castle")).toBe(false);
    expect(isSocietyType(42)).toBe(false);
    expect(isSocietyType(null)).toBe(false);
  });
});

describe("membership helpers", () => {
  const resident = membership({
    id: "member-resident",
    userId: "user-resident",
    role: "resident",
    status: "pending",
  });
  const admin = membership({ id: "member-admin" });

  it("recognises an active membership", () => {
    expect(isMembershipActive(admin)).toBe(true);
    expect(isMembershipActive(resident)).toBe(false);
  });

  it("finds a membership by society, ignoring other societies", () => {
    const other = membership({ id: "member-other", societyId: "society-2" });

    expect(findMembership([admin], admin.societyId, admin.userId)?.id).toBe(
      admin.id,
    );
    expect(findMembership([other], admin.societyId, admin.userId)).toBeNull();
    expect(findMembership([], admin.societyId, admin.userId)).toBeNull();
  });

  it("never returns another member's membership", () => {
    // Regression: matching on `societyId` alone made every member read as the
    // first row listed — the creator's Admin row — which let a resident edit and
    // delete the society. "Which membership?" is only answerable together with
    // "for whom?".
    const peer = membership({
      id: "member-resident",
      userId: "user-resident",
      role: "resident",
    });

    expect(
      findMembership([admin, peer], admin.societyId, peer.userId)?.role,
    ).toBe("resident");
    expect(
      findMembership([admin, peer], admin.societyId, admin.userId)?.role,
    ).toBe("admin");
    expect(
      findMembership(
        [admin, peer],
        admin.societyId,
        "user-outsider" as typeof admin.userId,
      ),
    ).toBeNull();
  });

  it("counts only active admins of the requested society", () => {
    const removedAdmin = membership({
      id: "member-removed",
      status: "removed",
    });
    const pendingAdmin = membership({
      id: "member-pending",
      status: "pending",
    });
    const treasurer = membership({ id: "member-treasurer", role: "treasurer" });
    const otherSocietyAdmin = membership({
      id: "member-elsewhere",
      societyId: "society-2",
    });

    const admins = activeAdmins(
      [
        admin,
        removedAdmin,
        pendingAdmin,
        treasurer,
        otherSocietyAdmin,
        resident,
      ],
      admin.societyId,
    );

    expect(admins.map((entry) => entry.id)).toEqual([admin.id]);
  });
});

describe("role rules", () => {
  const roles: readonly MemberRole[] = [
    "admin",
    "treasurer",
    "committee_member",
    "resident",
    "tenant",
    "guest",
  ];

  it("lets only an Admin manage the society", () => {
    for (const role of roles) {
      expect(canManageSociety(role).allowed).toBe(role === "admin");
    }
  });

  it("explains the refusal so the UI can show why", () => {
    const refusal = canManageSociety("treasurer");

    expect(refusal.allowed).toBe(false);
    expect(refusal.allowed === false && refusal.reason).toContain("Admin");
  });

  it("lets only an Admin delete the society", () => {
    for (const role of roles) {
      expect(canDeleteSociety(role).allowed).toBe(role === "admin");
    }
  });

  it("lets nobody without a membership manage or delete", () => {
    expect(canManageSociety(null).allowed).toBe(false);
    expect(canDeleteSociety(null).allowed).toBe(false);
  });
});

describe("canLeaveSociety", () => {
  const admin = membership({ id: "member-admin" });
  const peerAdmin = membership({ id: "member-admin-2" });
  const resident = membership({
    id: "member-resident",
    userId: "user-resident",
    role: "resident",
  });

  it("refuses to orphan a society: the sole Admin cannot leave", () => {
    const decision = canLeaveSociety(admin, [admin, resident]);

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toMatch(
      /Promote another member/,
    );
  });

  it("allows an Admin to leave once another active Admin exists", () => {
    expect(canLeaveSociety(admin, [admin, peerAdmin]).allowed).toBe(true);
  });

  it("does not count a pending or removed Admin as a replacement", () => {
    const pendingPeer = membership({ id: "member-admin-2", status: "pending" });
    const removedPeer = membership({ id: "member-admin-2", status: "removed" });

    expect(canLeaveSociety(admin, [admin, pendingPeer]).allowed).toBe(false);
    expect(canLeaveSociety(admin, [admin, removedPeer]).allowed).toBe(false);
  });

  it("never restricts a non-Admin", () => {
    expect(canLeaveSociety(resident, [resident]).allowed).toBe(true);
    expect(canLeaveSociety(resident, [admin, resident]).allowed).toBe(true);
  });
});

describe("evaluateSocietyCapabilities", () => {
  it("grants nothing without a membership", () => {
    expect(evaluateSocietyCapabilities(null, [])).toEqual({
      canManage: false,
      canDelete: false,
      canRegenerateJoinCode: false,
      canViewJoinCode: false,
      canLeave: false,
    });
  });

  it("grants nothing to a removed member", () => {
    const removed = membership({ id: "member-removed", status: "removed" });

    expect(evaluateSocietyCapabilities(removed, [removed])).toEqual({
      canManage: false,
      canDelete: false,
      canRegenerateJoinCode: false,
      canViewJoinCode: false,
      canLeave: false,
    });
  });

  it("lets a pending member withdraw the request but nothing else", () => {
    const pending = membership({
      id: "member-pending",
      userId: "user-pending",
      role: "resident",
      status: "pending",
    });

    expect(evaluateSocietyCapabilities(pending, [pending])).toEqual({
      canManage: false,
      canDelete: false,
      canRegenerateJoinCode: false,
      // The join code is for admitted members; a pending request is not one.
      canViewJoinCode: false,
      canLeave: true,
    });
  });

  it("gives an active resident the join code but no management rights", () => {
    const resident = membership({
      id: "member-resident",
      userId: "user-resident",
      role: "resident",
    });
    const capabilities = evaluateSocietyCapabilities(resident, [
      membership({ id: "member-admin" }),
      resident,
    ]);

    expect(capabilities.canViewJoinCode).toBe(true);
    expect(capabilities.canLeave).toBe(true);
    expect(capabilities.canManage).toBe(false);
    expect(capabilities.canDelete).toBe(false);
    expect(capabilities.canRegenerateJoinCode).toBe(false);
  });

  it("withholds leaving from a sole Admin while granting management", () => {
    const admin = membership({ id: "member-admin" });

    expect(evaluateSocietyCapabilities(admin, [admin])).toEqual({
      canManage: true,
      canDelete: true,
      canRegenerateJoinCode: true,
      canViewJoinCode: true,
      canLeave: false,
    });
  });

  it("lets a paired Admin leave as well", () => {
    const admin = membership({ id: "member-admin" });
    const peer = membership({ id: "member-admin-2" });

    expect(evaluateSocietyCapabilities(admin, [admin, peer]).canLeave).toBe(
      true,
    );
  });
});

describe("isJoinCodeExpired", () => {
  const now = Date.parse("2026-09-20T10:00:00.000Z");

  it("treats a missing expiry as never expiring", () => {
    expect(isJoinCodeExpired(null, now)).toBe(false);
  });

  it("compares against the injected instant", () => {
    expect(isJoinCodeExpired("2026-09-20T09:59:59.000Z", now)).toBe(true);
    expect(isJoinCodeExpired("2026-09-20T10:00:01.000Z", now)).toBe(false);
  });

  it("expires exactly at the boundary", () => {
    expect(isJoinCodeExpired("2026-09-20T10:00:00.000Z", now)).toBe(true);
  });

  it("ignores an unparseable value rather than expiring everything", () => {
    expect(isJoinCodeExpired("not-a-date", now)).toBe(false);
  });

  it("defaults to the system clock when no instant is injected", () => {
    // The default exists for convenience at the edge; every use case passes the
    // injected clock explicitly.
    expect(isJoinCodeExpired("2000-01-01T00:00:00.000Z")).toBe(true);
    expect(isJoinCodeExpired("2999-01-01T00:00:00.000Z")).toBe(false);
  });
});
