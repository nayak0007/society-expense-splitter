import { MEMBER_ROLES } from "../../society/society";
import type { MemberRole } from "../../society/society";
import { actionsFor } from "../permission-evaluator";
import {
  assignableRoles,
  canAssignRole,
  canRevokeRole,
  checkRoleChangeIsMeaningful,
  checkRoleLimit,
  checkRoleTarget,
  isMemberRole,
  MAX_ADMINS,
  MAX_TREASURERS,
  REVOKE_TARGET_ROLE,
  roleDefinition,
  roleDefinitions,
  ROLE_LIMITS,
  ROLE_ORDER,
} from "../role-rules";

/**
 * T046's role rules — PRD §2.2's caps and ownership, §2.3's transitions.
 *
 * The assertions are written against the PRD's numbers rather than against the constants, where
 * the two could drift: `expect(MAX_ADMINS).toBe(3)` is what makes a change to the constant a
 * deliberate act with a failing test in front of it, rather than a silent redefinition of what
 * a society may become.
 */

describe("ROLE_ORDER", () => {
  it("is PRD §2.1's column order", () => {
    expect(ROLE_ORDER).toEqual([
      "admin",
      "treasurer",
      "committee_member",
      "resident",
      "tenant",
      "guest",
    ]);
  });

  it("covers every role exactly once", () => {
    // The catalogue is built by mapping this array, so a role missing from it would simply
    // vanish from every endpoint that lists roles — with no error anywhere.
    expect([...ROLE_ORDER].sort()).toEqual([...MEMBER_ROLES].sort());
    expect(new Set(ROLE_ORDER).size).toBe(MEMBER_ROLES.length);
  });
});

describe("role definitions", () => {
  it("takes every permission set from the evaluator, never from a second list", () => {
    for (const role of ROLE_ORDER) {
      expect(roleDefinition(role).permissions).toEqual(actionsFor(role));
    }
  });

  it("shows an Admin the role-changing grant and a Treasurer none of it", () => {
    expect(roleDefinition("admin").permissions).toContain("member.role_change");
    expect(roleDefinition("admin").permissions).toContain("member.remove");
    expect(roleDefinition("treasurer").permissions).not.toContain(
      "member.role_change",
    );
    expect(roleDefinition("committee_member").permissions).not.toContain(
      "member.role_change",
    );
    expect(roleDefinition("resident").permissions).not.toContain(
      "member.role_change",
    );
  });

  it("lists every role, in order, with its permissions", () => {
    const definitions = roleDefinitions();
    expect(definitions.map((definition) => definition.role)).toEqual([
      ...ROLE_ORDER,
    ]);
    expect(
      definitions.every((definition) => definition.permissions.length > 0),
    ).toBe(true);
  });

  it("offers every role as assignable — the caps and self-change rule are the bounds", () => {
    // Not a filter over ROLE_ORDER by rule: no role is unassignable, and hiding one would
    // change what the API accepts depending on which screen asked.
    expect(assignableRoles()).toEqual([...ROLE_ORDER]);
  });
});

describe("isMemberRole", () => {
  it("accepts the six roles the database's enum holds", () => {
    for (const role of MEMBER_ROLES) {
      expect(isMemberRole(role)).toBe(true);
    }
  });

  it("refuses the SQL enum's own spelling of the committee role", () => {
    // `member_role` in Postgres says `committee`, TypeScript says `committee_member`, and
    // `society.rows.ts` carries the translation. This is the assertion that keeps the wider
    // vocabulary honest: a role value is one of six, and `committee` is not one of them — so a
    // caller cannot smuggle the raw enum value through an endpoint and have it stored as
    // something the matrix has never heard of.
    expect(isMemberRole("committee")).toBe(false);
    expect(isMemberRole("owner")).toBe(false);
    expect(isMemberRole("ADMIN")).toBe(false);
    expect(isMemberRole(null)).toBe(false);
    expect(isMemberRole(7)).toBe(false);
  });
});

describe("canAssignRole", () => {
  it("is an Admin grant and nobody else's", () => {
    const others: MemberRole[] = [
      "treasurer",
      "committee_member",
      "resident",
      "tenant",
      "guest",
    ];
    for (const role of others) {
      expect(canAssignRole(role, "resident")).toBe(false);
      expect(canAssignRole(role, "admin")).toBe(false);
    }
    for (const target of ROLE_ORDER) {
      expect(canAssignRole("admin", target)).toBe(true);
    }
  });
});

describe("canRevokeRole", () => {
  it("is the same grant as assigning, and lands on resident", () => {
    expect(canRevokeRole("admin")).toBe(true);
    expect(canRevokeRole("treasurer")).toBe(false);
    expect(canRevokeRole("resident")).toBe(false);
    expect(REVOKE_TARGET_ROLE).toBe("resident");
  });
});

describe("checkRoleLimit", () => {
  it("uses the PRD's numbers", () => {
    expect(MAX_ADMINS).toBe(3);
    expect(MAX_TREASURERS).toBe(2);
    expect(ROLE_LIMITS.admin).toBe(3);
    expect(ROLE_LIMITS.treasurer).toBe(2);
  });

  it("allows the last free slot and refuses the one after it", () => {
    expect(checkRoleLimit("admin", 2).ok).toBe(true);
    expect(checkRoleLimit("admin", 3).ok).toBe(false);
    expect(checkRoleLimit("treasurer", 1).ok).toBe(true);
    expect(checkRoleLimit("treasurer", 2).ok).toBe(false);
  });

  it("names the cap in the failure, so the screen can say which one", () => {
    const result = checkRoleLimit("treasurer", 2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("role_cap_exceeded");
    expect(result.error.message).toContain("2 treasurers");
    expect(result.error.details).toMatchObject({ field: "role", limit: 2 });
  });

  it("leaves the uncapped roles uncapped at any count", () => {
    // Committee members, residents, tenants and guests are not a scarce resource: PRD §2.2
    // caps exactly two roles, and 500 residents is a society, not a breach.
    for (const role of [
      "committee_member",
      "resident",
      "tenant",
      "guest",
    ] as const) {
      expect(checkRoleLimit(role, 500).ok).toBe(true);
    }
  });
});

describe("checkRoleChangeIsMeaningful", () => {
  it("refuses a no-op rather than reporting success", () => {
    const same = checkRoleChangeIsMeaningful("treasurer", "treasurer");
    expect(same.ok).toBe(false);
    if (same.ok) return;
    expect(same.error.code).toBe("conflict");
    expect(same.error.details).toMatchObject({ field: "role" });
  });

  it("allows every real change, in both directions", () => {
    expect(checkRoleChangeIsMeaningful("resident", "treasurer").ok).toBe(true);
    expect(checkRoleChangeIsMeaningful("treasurer", "resident").ok).toBe(true);
    expect(checkRoleChangeIsMeaningful("admin", "resident").ok).toBe(true);
  });
});

describe("checkRoleTarget", () => {
  it("refuses a membership that has not been admitted, or no longer is", () => {
    for (const status of ["pending", "rejected", "removed"] as const) {
      const result = checkRoleTarget(status);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("conflict");
    }
  });

  it("allows an active and a suspended membership", () => {
    // A suspended treasurer being reinstated at a lower role is an ordinary administrative
    // act, and refusing it would leave a society unable to rearrange roles while somebody is
    // suspended.
    expect(checkRoleTarget("active").ok).toBe(true);
    expect(checkRoleTarget("inactive").ok).toBe(true);
  });
});
