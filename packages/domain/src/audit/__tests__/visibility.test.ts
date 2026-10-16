import { asMemberId, asSocietyId } from "../../shared/ids";
import { MEMBER_ROLES, MEMBERSHIP_STATUSES } from "../../society/society";
import type { MemberRole } from "../../society/society";
import { can } from "../../member/permission-evaluator";
import { canOnResource } from "../../member/resource-authorization";
import type { MemberSnapshot } from "../../member/resource-authorization";
import { auditVisibleCategories } from "../visibility";

/**
 * The audit log's read visibility — Roadmap T050 Stage E1, PRD §2.1.
 *
 * Every expectation comes from the matrix's own cell, quoted where it is asserted:
 *
 * > "View audit log | ✅ | 🟡 financial only | ⬜ | ⬜ | ⬜ | ⬜"
 *
 * so the test does not re-derive its answers from the implementation. The important
 * assertions are the negative ones — the set a Resident, a Committee Member or a Guest
 * gets, and the set an *inactive* Admin gets — because a visibility filter that is too
 * wide is invisible in ordinary use.
 */

const SOCIETY = asSocietyId("11111111-1111-4111-8111-111111111111");
const ME = asMemberId("33333333-3333-4333-8333-333333333333");

/** A member holding `role`, active unless a test says otherwise. */
function member(
  role: MemberRole,
  overrides: Partial<MemberSnapshot> = {},
): MemberSnapshot {
  return {
    membershipId: ME,
    societyId: SOCIETY,
    role,
    status: "active",
    ...overrides,
  };
}

describe("auditVisibleCategories", () => {
  it("gives an active Admin the whole log", () => {
    // "View audit log | ✅" — no narrowing, both categories.
    expect(auditVisibleCategories(member("admin"))).toEqual([
      "financial",
      "other",
    ]);
  });

  it("gives an active Treasurer the financial half only", () => {
    // "🟡 financial only".
    expect(auditVisibleCategories(member("treasurer"))).toEqual(["financial"]);
  });

  it.each(
    MEMBER_ROLES.filter(
      (role) => role !== "admin" && role !== "treasurer",
    ) as readonly MemberRole[],
  )("gives a %s nothing, exactly as the matrix's ⬜ cells say", (role) => {
    expect(auditVisibleCategories(member(role))).toEqual([]);
    // The precondition the assertion rests on: the role holds no `audit.view` grant
    // at all, so an empty list is the matrix's answer rather than this helper's.
    expect(can(role, "audit.view")).toBe(false);
  });

  it.each(MEMBERSHIP_STATUSES.filter((status) => status !== "active"))(
    "gives a %s Admin nothing — the role column is not the subject",
    (status) => {
      // The subject's own standing is decided before any rule: `canOnResource`
      // returns false for anything but an active membership, so an Admin whose row
      // says `suspended` reads nothing even though their role still says `admin`.
      expect(auditVisibleCategories(member("admin", { status }))).toEqual([]);
      expect(
        canOnResource(member("admin", { status }), "audit.view", {
          kind: "audit",
          societyId: SOCIETY,
          category: "financial",
        }),
      ).toBe(false);
    },
  );

  it("derives the set from the evaluator rather than from the role name", () => {
    // The property that makes this helper safe to keep: whatever `canOnResource`
    // answers per category *is* the answer, for every role, with no second rule in
    // between. Written as a cross-check against the evaluator itself.
    for (const role of MEMBER_ROLES) {
      const expected = (["financial", "other"] as const).filter((category) =>
        canOnResource(member(role), "audit.view", {
          kind: "audit",
          societyId: SOCIETY,
          category,
        }),
      );
      expect(auditVisibleCategories(member(role))).toEqual([...expected]);
    }
  });

  it("refuses a subject from another society's membership, so the filter is never cross-tenant", () => {
    // `canOnResource` refuses before any rule when the resource's tenant differs
    // from the subject's. The helper passes the subject's own society, so this
    // asserts the boundary it relies on rather than the helper's own behaviour.
    const foreign = member("admin", {
      societyId: asSocietyId("22222222-2222-4222-8222-222222222222"),
    });
    expect(
      canOnResource(foreign, "audit.view", {
        kind: "audit",
        societyId: SOCIETY,
        category: "financial",
      }),
    ).toBe(false);
  });
});
