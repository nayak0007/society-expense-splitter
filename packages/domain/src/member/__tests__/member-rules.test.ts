import {
  asApartmentId,
  asMemberId,
  asSocietyId,
  asUserId,
} from "../../shared/ids";
import type { MemberId } from "../../shared/ids";
import type { Member, MemberRole, MemberStatus } from "../member";
import {
  canViewMemberContact,
  evaluateMemberCapabilities,
  toMemberView,
} from "../member-rules";

/**
 * The rules that decide what a member sees and does.
 *
 * Built from a fixture with every field present, so a test can change exactly one thing
 * — the shape `__tests__/apartment-use-cases.test.ts` uses, and for the same reason: a
 * failure then names the field that broke it rather than "the rules changed".
 */

function member(overrides: Partial<Member> = {}): Member {
  return {
    id: asMemberId("aaaaaaaa-0000-4000-8000-000000000001"),
    societyId: asSocietyId("aaaaaaaa-0000-4000-8000-0000000000ff"),
    userId: asUserId("bbbbbbbb-0000-4000-8000-000000000001"),
    apartmentId: asApartmentId("cccccccc-0000-4000-8000-000000000001"),
    apartment: null,
    displayName: "Meera Krishnan",
    phone: "+919876543210",
    email: "meera@example.com",
    role: "resident",
    status: "active",
    occupancy: "owner_occupied",
    isPrimary: true,
    leaseStart: null,
    leaseEnd: null,
    shareContact: false,
    joinedAt: "2026-01-01T00:00:00.000Z",
    approvedBy: null,
    removedAt: null,
    removedBy: null,
    requestNote: null,
    rejectionReason: null,
    rejectedAt: null,
    rejectedBy: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const OTHER = asMemberId("aaaaaaaa-0000-4000-8000-000000000002");

describe("evaluateMemberCapabilities", () => {
  it("gives a non-member nothing at all", () => {
    expect(evaluateMemberCapabilities(null)).toEqual({
      canView: false,
      canAdd: false,
      canEdit: false,
      canSuspend: false,
      canRemove: false,
      canChangeRoles: false,
      canApprove: false,
    });
  });

  it("mirrors the SQL: a pending member does not see the roster", () => {
    // `members_select_self_or_roster` shows a pending member exactly one row — theirs —
    // so the API must refuse the list rather than return a one-row society that looks
    // empty. The capability is what makes the two answers distinguishable.
    const caps = evaluateMemberCapabilities(member({ status: "pending" }));
    expect(caps.canView).toBe(false);
  });

  it("mirrors the SQL: a suspended member can do nothing", () => {
    expect(
      evaluateMemberCapabilities(member({ role: "admin", status: "inactive" }))
        .canView,
    ).toBe(false);
  });

  it("lets a resident read the directory and change nothing", () => {
    const caps = evaluateMemberCapabilities(member({ role: "resident" }));
    expect(caps).toEqual({
      canView: true,
      canAdd: false,
      canEdit: false,
      canSuspend: false,
      canRemove: false,
      canChangeRoles: false,
      // T049: a Resident browses the roster and never sees the join queue.
      canApprove: false,
    });
  });

  it("lets a Treasurer keep the directory accurate without cutting anyone off", () => {
    const caps = evaluateMemberCapabilities(member({ role: "treasurer" }));
    expect(caps.canAdd).toBe(true);
    expect(caps.canEdit).toBe(true);
    // Suspension is access revocation — the Admin-only matrix row, not the
    // invite/approve row the Treasurer holds.
    expect(caps.canSuspend).toBe(false);
    expect(caps.canRemove).toBe(false);
    // T046: roles are the Admin's, not the Treasurer's. "Assign / change roles" is a
    // separate row of PRD §2.1 from "Invite members", and this is the assertion that keeps
    // the two from being folded together.
    expect(caps.canChangeRoles).toBe(false);
    // T049: the Treasurer holds `member.approve` — PRD §2.1's "Approve join requests" —
    // even though suspending and removing are the Admin's.
    expect(caps.canApprove).toBe(true);
  });

  it("gives an Admin everything the matrix grants, and nothing more", () => {
    const caps = evaluateMemberCapabilities(member({ role: "admin" }));
    expect(caps).toEqual({
      canView: true,
      canAdd: true,
      canEdit: true,
      canSuspend: true,
      canRemove: true,
      // T046: the Admin is also the only role that may hand a role out.
      canChangeRoles: true,
      canApprove: true,
    });
  });

  it("withholds the roster from a Guest, matching the matrix not the SQL", () => {
    // The RLS policy would let an active Guest read the rows; the matrix does not grant
    // that role `member.view`. The same deliberate asymmetry `structure.view`
    // documents: RLS decides which rows exist, the matrix decides what this API offers.
    expect(evaluateMemberCapabilities(member({ role: "guest" })).canView).toBe(
      false,
    );
  });

  it("agrees with the matrix for every role × capability, so none can drift", () => {
    const expected: Readonly<Record<MemberRole, readonly [boolean, boolean]>> =
      {
        admin: [true, true],
        treasurer: [true, false],
        committee_member: [false, false],
        resident: [false, false],
        tenant: [false, false],
        guest: [false, false],
      };
    for (const [role, [canAdd, canSuspend]] of Object.entries(expected)) {
      const caps = evaluateMemberCapabilities(
        member({ role: role as MemberRole }),
      );
      expect([caps.canAdd, caps.canSuspend]).toEqual([canAdd, canSuspend]);
    }
  });
});

describe("canViewMemberContact", () => {
  const viewer = member({ id: OTHER, role: "resident" });

  it("never hides a member from themselves", () => {
    const self = member({ id: OTHER, shareContact: false });
    expect(canViewMemberContact(self, self)).toBe(true);
  });

  it("hides a neighbour's number until they consent", () => {
    // PRD §3.3: the flag is off by default, and what it protects is peer visibility —
    // a resident must not be able to harvest their neighbours' numbers.
    expect(canViewMemberContact(viewer, member({ shareContact: false }))).toBe(
      false,
    );
    expect(canViewMemberContact(viewer, member({ shareContact: true }))).toBe(
      true,
    );
  });

  it("shows it to the people who must be able to reach a resident", () => {
    const admin = member({ id: OTHER, role: "admin" });
    const treasurer = member({ id: OTHER, role: "treasurer" });
    expect(canViewMemberContact(admin, member({ shareContact: false }))).toBe(
      true,
    );
    expect(
      canViewMemberContact(treasurer, member({ shareContact: false })),
    ).toBe(true);
  });

  it("withholds it from a suspended Admin", () => {
    const suspended = member({ id: OTHER, role: "admin", status: "inactive" });
    expect(
      canViewMemberContact(suspended, member({ shareContact: false })),
    ).toBe(false);
  });
});

describe("toMemberView", () => {
  it("nulls the contacts and says so, rather than pretending nobody recorded one", () => {
    const view = toMemberView(
      member({ role: "resident" }),
      member({ id: OTHER }),
    );
    expect(view.phone).toBe(null);
    expect(view.email).toBe(null);
    // The distinction the type exists for: `phone: null` alone would tell the UI
    // "no number on file", which is a different statement about the society's data.
    expect(view.contactVisible).toBe(false);
  });

  it("keeps the contacts and flags them when they are visible", () => {
    const view = toMemberView(member({ role: "admin" }), member({ id: OTHER }));
    expect(view.phone).toBe("+919876543210");
    expect(view.contactVisible).toBe(true);
  });

  it("does not mutate the member it was given", () => {
    const target = member({ id: OTHER });
    toMemberView(member({ role: "resident" }), target);
    expect(target.phone).toBe("+919876543210");
  });
});

describe("status vocabulary", () => {
  it("uses the database's five states, so nothing needs a translation table", () => {
    const statuses: readonly MemberStatus[] = [
      "pending",
      "active",
      "inactive",
      "removed",
      "rejected",
    ];
    const ids: readonly MemberId[] = statuses.map((status) =>
      asMemberId(`status-${status}`),
    );
    expect(ids).toHaveLength(5);
  });
});
