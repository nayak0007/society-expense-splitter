import { asMemberId, asSocietyId, asUserId } from "@ses/domain";
import type { MemberRole } from "@ses/domain";

import { assignMemberRole } from "../use-cases/assign-role";
import { listRoles } from "../use-cases/list-roles";
import {
  getMemberPermissions,
  listMyPermissions,
} from "../use-cases/permissions";
import { revokeMemberRole } from "../use-cases/revoke-role";
import type { MemberDeps } from "../use-cases/support";
import { FakeMemberRepository } from "./support/fake-member-repository";
import { expectErr, expectOk } from "./support/result-expectations";

/**
 * T046's use cases — role assignment, revocation and permission introspection.
 *
 * What these tests are *for*, in order of value:
 *
 *  1. **Privilege escalation, in both directions it can happen.** A caller changing their own
 *     role, and a non-Admin caller changing anybody's. Both are refused before storage is
 *     touched, and the assertion is on the repository's *call log*, because "nothing was written"
 *     is the property that matters and the returned error alone does not prove it.
 *  2. **The caps are counts, evaluated against active holders only.** Two treasurers refuse a
 *     third; a suspended treasurer does not hold a slot, so a society that suspended one can
 *     appoint their replacement.
 *  3. **The effective-permission list folds status.** A suspended treasurer's permissions are
 *     empty even though the *role's* grant is not — the fold that makes the answer match what the
 *     guard will do, rather than what the matrix says in the abstract.
 *  4. **Every refusal is typed.** `role_cap_exceeded`, `forbidden`, `conflict` and `not_found` are
 *     different answers to different questions, and the API maps each one differently (T046's
 *     screens branch on them).
 */

const SOCIETY = "society-1";
const OTHER_SOCIETY = "society-2";

const ADMIN = "user-admin";
const TREASURER = "user-treasurer";
const RESIDENT = "user-resident";
const GUEST = "user-guest";
const PENDING = "user-pending";
const SUSPENDED_TREASURER = "user-suspended-treasurer";

interface Setup {
  readonly deps: MemberDeps;
  readonly members: FakeMemberRepository;
}

function setup(): Setup {
  const members = new FakeMemberRepository();
  members.seedMember(SOCIETY, {
    id: "m-admin",
    userId: ADMIN,
    role: "admin",
    displayName: "Anita Rao",
  });
  members.seedMember(SOCIETY, {
    id: "m-treasurer",
    userId: TREASURER,
    role: "treasurer",
    displayName: "Bharat Shah",
  });
  members.seedMember(SOCIETY, {
    id: "m-resident",
    userId: RESIDENT,
    role: "resident",
    displayName: "Meera Krishnan",
  });
  members.seedMember(SOCIETY, {
    id: "m-guest",
    userId: GUEST,
    role: "guest",
    displayName: "Gate 1",
  });
  members.seedMember(SOCIETY, {
    id: "m-pending",
    userId: PENDING,
    role: "resident",
    status: "pending",
    displayName: "Pending Person",
  });
  members.seedMember(SOCIETY, {
    id: "m-suspended-treasurer",
    userId: SUSPENDED_TREASURER,
    role: "treasurer",
    status: "inactive",
    displayName: "Suspended Treasurer",
  });
  members.seedMember(OTHER_SOCIETY, {
    id: "m-foreign",
    role: "resident",
    displayName: "Other Society Person",
  });
  return { deps: { members }, members };
}

/** Every role a member currently holds, read from storage rather than from a return value. */
function roleOf(
  members: FakeMemberRepository,
  id: string,
): MemberRole | undefined {
  return members.stored(id)?.role;
}

describe("assignMemberRole", () => {
  it("promotes a resident to Treasurer and reports the permissions that follow", async () => {
    const { deps, members } = setup();

    const view = expectOk(
      await assignMemberRole(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
        "treasurer",
      ),
    );

    expect(view.role).toBe("treasurer");
    expect(view.memberId).toBe("m-resident");
    // The permissions are the new role's — computed from the stored row, so the response can
    // never describe a state the database is not in.
    expect(view.permissions).toContain("payment.record");
    expect(view.permissions).not.toContain("member.role_change");
    expect(roleOf(members, "m-resident")).toBe("treasurer");
    expect(members.roleWrites()).toEqual([
      { id: "m-resident", role: "treasurer" },
    ]);
  });

  it("lets an Admin appoint a second Admin — PRD §2.2 allows up to three", async () => {
    const { deps, members } = setup();

    const view = expectOk(
      await assignMemberRole(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-treasurer"),
        "admin",
      ),
    );

    expect(view.role).toBe("admin");
    expect(view.permissions).toContain("member.role_change");
    expect(members.roleWrites()).toHaveLength(1);
  });

  it("refuses the caller's own role, before storage is touched", async () => {
    // The escalation this module exists to prevent, and the same refusal the database makes in
    // `chk_member_self_change()`. Asserted on the call log because "refused" and "not written"
    // are two facts and only the second one is security.
    const { deps, members } = setup();

    const error = expectErr(
      await assignMemberRole(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-admin"),
        "resident",
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(members.roleWrites()).toHaveLength(0);
    expect(roleOf(members, "m-admin")).toBe("admin");
  });

  it("refuses a Treasurer — role assignment is the Admin's grant alone", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await assignMemberRole(
        deps,
        asUserId(TREASURER),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
        "treasurer",
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(members.roleWrites()).toHaveLength(0);
  });

  it("refuses a resident, a Guest and a pending member alike", async () => {
    for (const actor of [RESIDENT, GUEST, PENDING]) {
      const { deps, members } = setup();
      const error = expectErr(
        await assignMemberRole(
          deps,
          asUserId(actor),
          asSocietyId(SOCIETY),
          asMemberId("m-resident"),
          "treasurer",
        ),
      );
      expect(["forbidden", "not_found"]).toContain(error.code);
      expect(members.roleWrites()).toHaveLength(0);
    }
  });

  it("refuses a third Treasurer", async () => {
    const { deps, members } = setup();
    // The 2-treasurer cap: `m-treasurer` is active, `m-suspended-treasurer` is not counted.
    members.seedMember(SOCIETY, { id: "m-treasurer-2", role: "treasurer" });

    const error = expectErr(
      await assignMemberRole(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
        "treasurer",
      ),
    );

    expect(error.code).toBe("role_cap_exceeded");
    expect(error.message).toContain("2 treasurers");
    expect(members.roleWrites()).toHaveLength(0);
  });

  it("counts only active holders, so a suspended Treasurer frees a slot", async () => {
    const { deps } = setup();
    // `m-treasurer` (active) + `m-suspended-treasurer` (inactive): at most one slot is taken.
    const view = expectOk(
      await assignMemberRole(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
        "treasurer",
      ),
    );

    expect(view.role).toBe("treasurer");
  });

  it("refuses a fourth Admin", async () => {
    const { deps, members } = setup();
    members.seedMember(SOCIETY, { id: "m-admin-2", role: "admin" });
    members.seedMember(SOCIETY, { id: "m-admin-3", role: "admin" });

    const error = expectErr(
      await assignMemberRole(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
        "admin",
      ),
    );

    expect(error.code).toBe("role_cap_exceeded");
    expect(error.message).toContain("3 admins");
    expect(members.roleWrites()).toHaveLength(0);
  });

  it("counts a population only where a rule reads the count", async () => {
    // Two different counts, two different reasons, and neither is unconditional:
    //
    //  - **the cap count** exists for the role being moved *into*, and only for the two roles that
    //    have a cap (PRD §2.2). Demoting an Admin to `resident` has no limit to check, so it must
    //    not cost a count — on the mobile caller that read is an HTTP request.
    //  - **the admin-presence count** exists only for a demotion *off* `admin`, which is the one
    //    direction that can empty a society of its Admins.
    const demote = setup();
    demote.members.seedMember(SOCIETY, { id: "m-admin-2", role: "admin" });

    expectOk(
      await assignMemberRole(
        demote.deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-admin-2"),
        "resident",
      ),
    );
    // Uncapped target role: the presence count alone.
    expect(demote.members.callCount("countActiveByRole")).toBe(1);

    const second = setup();
    expectOk(
      await assignMemberRole(
        second.deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
        "treasurer",
      ),
    );
    // Capped target role, no demotion: the cap count alone.
    expect(second.members.callCount("countActiveByRole")).toBe(1);
  });

  it("refuses a no-op instead of reporting a write that never happened", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await assignMemberRole(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-treasurer"),
        "treasurer",
      ),
    );

    expect(error.code).toBe("conflict");
    expect(members.roleWrites()).toHaveLength(0);
  });

  it("refuses to give a role to somebody who has not been admitted", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await assignMemberRole(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-pending"),
        "treasurer",
      ),
    );

    expect(error.code).toBe("conflict");
    expect(members.roleWrites()).toHaveLength(0);
  });

  it("answers not_found for another society's member, and for a removed one", async () => {
    const foreign = setup();
    const missing = expectErr(
      await assignMemberRole(
        foreign.deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-foreign"),
        "treasurer",
      ),
    );
    expect(missing.code).toBe("not_found");
    expect(foreign.members.roleWrites()).toHaveLength(0);

    const gone = setup();
    gone.members.seedMember(SOCIETY, {
      id: "m-removed",
      role: "treasurer",
      status: "removed",
    });
    const removed = expectErr(
      await assignMemberRole(
        gone.deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-removed"),
        "admin",
      ),
    );
    expect(removed.code).toBe("not_found");
  });

  it("refuses a role that is not one of the six", async () => {
    const { deps, members } = setup();

    // The parameter is typed, but the mobile app passes a value that arrived from a form, so the
    // runtime check is the one that keeps `committee` — the *SQL* enum's spelling — from becoming
    // a stored value the matrix has never heard of.
    const error = expectErr(
      await assignMemberRole(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
        "committee" as MemberRole,
      ),
    );

    expect(error.code).toBe("validation");
    expect(error.details).toMatchObject({ field: "role" });
    expect(members.roleWrites()).toHaveLength(0);
  });

  it("passes a repository failure through as a typed error", async () => {
    const { deps, members } = setup();
    members.failNext("setRole", new Error("connection reset"));

    const error = expectErr(
      await assignMemberRole(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
        "treasurer",
      ),
    );

    // An adapter throwing something unclassifiable becomes `unknown` — never a silent success.
    expect(error.code).toBe("unknown");
  });
});

describe("revokeMemberRole", () => {
  it("returns a Treasurer to resident, keeping the row", async () => {
    const { deps, members } = setup();

    const view = expectOk(
      await revokeMemberRole(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-treasurer"),
      ),
    );

    expect(view.role).toBe("resident");
    expect(view.permissions).toContain("payment.pay_own");
    expect(view.permissions).not.toContain("payment.record");
    expect(members.roleWrites()).toEqual([
      { id: "m-treasurer", role: "resident" },
    ]);
    // Soft: the membership is still there, in the same flat, with its history.
    expect(members.stored("m-treasurer")?.status).toBe("active");
  });

  it("refuses a caller revoking their own role", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await revokeMemberRole(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-admin"),
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(members.roleWrites()).toHaveLength(0);
  });

  it("refuses to revoke what is not held", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await revokeMemberRole(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
      ),
    );

    expect(error.code).toBe("conflict");
    expect(members.roleWrites()).toHaveLength(0);
  });

  it("refuses a Treasurer caller as firmly as assignment does", async () => {
    const { deps, members } = setup();

    const error = expectErr(
      await revokeMemberRole(
        deps,
        asUserId(TREASURER),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(members.roleWrites()).toHaveLength(0);
  });
});

describe("listRoles", () => {
  it("returns the six roles in PRD order with the evaluator's permissions", async () => {
    const { deps } = setup();

    const catalogue = expectOk(
      await listRoles(deps, asUserId(RESIDENT), asSocietyId(SOCIETY)),
    );

    expect(catalogue.roles.map((definition) => definition.role)).toEqual([
      "admin",
      "treasurer",
      "committee_member",
      "resident",
      "tenant",
      "guest",
    ]);
    const admin = catalogue.roles.find(
      (definition) => definition.role === "admin",
    );
    expect(admin?.permissions).toContain("member.role_change");
    expect(catalogue.capabilities.canView).toBe(true);
    expect(catalogue.capabilities.canChangeRoles).toBe(false);
  });

  it("is readable by a Resident, refused to a Guest and absent for a non-member", async () => {
    const resident = setup();
    expectOk(
      await listRoles(resident.deps, asUserId(RESIDENT), asSocietyId(SOCIETY)),
    );

    const guest = setup();
    expect(
      expectErr(
        await listRoles(guest.deps, asUserId(GUEST), asSocietyId(SOCIETY)),
      ).code,
    ).toBe("forbidden");

    const outsider = setup();
    expect(
      expectErr(
        await listRoles(
          outsider.deps,
          asUserId("user-nobody"),
          asSocietyId(SOCIETY),
        ),
      ).code,
    ).toBe("not_found");
  });
});

describe("listMyPermissions", () => {
  it("answers with the caller's own role and its full grant", async () => {
    const { deps } = setup();

    const view = expectOk(
      await listMyPermissions(deps, asUserId(TREASURER), asSocietyId(SOCIETY)),
    );

    expect(view.memberId).toBe("m-treasurer");
    expect(view.role).toBe("treasurer");
    expect(view.permissions).toContain("cycle.publish");
    expect(view.permissions).not.toContain("member.role_change");
    expect(view.capabilities.canChangeRoles).toBe(false);
  });

  it("folds status: a suspended membership has no effective permissions", async () => {
    // The evaluator says a Treasurer may publish cycles; the guard refuses a suspended member
    // everything. The list has to agree with the guard, or the app promises what the API denies.
    const { deps } = setup();

    const view = expectOk(
      await listMyPermissions(
        deps,
        asUserId(SUSPENDED_TREASURER),
        asSocietyId(SOCIETY),
      ),
    );

    expect(view.role).toBe("treasurer");
    expect(view.permissions).toEqual([]);
    expect(view.capabilities.canView).toBe(false);
  });

  it("works for a caller who may do nothing — that is the point of it", async () => {
    // A pending member gets an answer about their own row rather than a refusal: the difference
    // between a locked door and an unexplained one.
    const { deps } = setup();

    const view = expectOk(
      await listMyPermissions(deps, asUserId(PENDING), asSocietyId(SOCIETY)),
    );

    expect(view.role).toBe("resident");
    expect(view.permissions).toEqual([]);
  });

  it("is not_found for somebody with no membership in the society", async () => {
    const { deps } = setup();

    const error = expectErr(
      await listMyPermissions(
        deps,
        asUserId("user-nobody"),
        asSocietyId(SOCIETY),
      ),
    );

    expect(error.code).toBe("not_found");
  });
});

describe("getMemberPermissions", () => {
  it("lets an Admin read another member's effective permissions", async () => {
    const { deps } = setup();

    const view = expectOk(
      await getMemberPermissions(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-treasurer"),
      ),
    );

    expect(view.memberId).toBe("m-treasurer");
    expect(view.role).toBe("treasurer");
    expect(view.permissions).toContain("payment.verify");
  });

  it("refuses a Treasurer another member's list, while letting them read their own", async () => {
    // The asymmetry is deliberate: `member.invite` lets a Treasurer keep the directory accurate,
    // and enumerating what every member can do is a different kind of information.
    const { deps } = setup();

    const other = expectErr(
      await getMemberPermissions(
        deps,
        asUserId(TREASURER),
        asSocietyId(SOCIETY),
        asMemberId("m-resident"),
      ),
    );
    expect(other.code).toBe("forbidden");

    const own = expectOk(
      await getMemberPermissions(
        deps,
        asUserId(TREASURER),
        asSocietyId(SOCIETY),
        asMemberId("m-treasurer"),
      ),
    );
    expect(own.memberId).toBe("m-treasurer");
  });

  it("answers not_found for another society's member", async () => {
    const { deps } = setup();

    const error = expectErr(
      await getMemberPermissions(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asMemberId("m-foreign"),
      ),
    );

    expect(error.code).toBe("not_found");
  });
});
