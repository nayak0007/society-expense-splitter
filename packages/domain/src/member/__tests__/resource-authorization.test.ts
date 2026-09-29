import { asMemberId, asSocietyId, asUserId } from "../../shared/ids";
import { MEMBER_ROLES } from "../../society/society";
import type { MemberRole, SocietyMembership } from "../../society/society";
import {
  ACTIONS,
  can,
  grantKind,
  SCOPED_ACTIONS,
} from "../permission-evaluator";
import type { Action } from "../permission-evaluator";
import {
  canOnResource,
  isResourceKind,
  memberSnapshotOf,
  NARROWED_ACTIONS,
  narrowingRuleFor,
  RESOURCE_KINDS,
} from "../resource-authorization";
import type {
  MemberSnapshot,
  ResourceKind,
  ResourceSnapshot,
} from "../resource-authorization";

/**
 * The resource half of the matrix — SAD §9.3's `canOnResource`.
 *
 * Every expectation below is written from **PRD §2.1's cell**, quoted in the test
 * that asserts it, rather than from the implementation: a test that computed its
 * expectations from the rules would pass whatever the rules said, which is the
 * failure mode this file exists to prevent.
 *
 * The most important assertions are the *negative* ones. A grant that is too wide
 * is invisible in ordinary use — the 🟡 cells exist precisely because the
 * too-wide answer is the one a caller reaches for — so each narrowing rule is
 * pinned from both sides: the own/assigned case passes and the other-member case
 * fails.
 */

const SOCIETY = asSocietyId("11111111-1111-4111-8111-111111111111");
const OTHER_SOCIETY = asSocietyId("22222222-2222-4222-8222-222222222222");

const ME = asMemberId("33333333-3333-4333-8333-333333333333");
const SOMEBODY_ELSE = asMemberId("44444444-4444-4444-8444-444444444444");

/** A member holding `role`, active in `SOCIETY` unless a test says otherwise. */
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

// ─────────────────────────────────────────────────────────────────────────────
// grantKind — the fact the narrow layer needs back
// ─────────────────────────────────────────────────────────────────────────────

describe("grantKind", () => {
  it("agrees with can() for every role × action pair", () => {
    // The two read the same table by different routes, and `can` is the one the
    // guard enforces. If they ever disagree, the resource layer would narrow an
    // action the guard already refused — or, worse, permit one outright.
    const divergences: string[] = [];
    for (const role of MEMBER_ROLES) {
      for (const action of ACTIONS) {
        const permitted = can(role, action);
        const kind = grantKind(role, action);
        if (permitted !== (kind !== "none")) {
          divergences.push(
            `${role} × ${action}: can=${permitted} kind=${kind}`,
          );
        }
      }
    }
    expect(divergences).toEqual([]);
  });

  it("tells a full grant from a conditional one", () => {
    // "Create expense | ✅ | ✅ | 🟡 (draft only) | ⬜ | ⬜ | ⬜"
    expect(grantKind("admin", "expense.create")).toBe("full");
    expect(grantKind("treasurer", "expense.create")).toBe("full");
    expect(grantKind("committee_member", "expense.create")).toBe("scoped");
    expect(grantKind("resident", "expense.create")).toBe("none");

    // "View audit log | ✅ | 🟡 financial only | ⬜ | ⬜ | ⬜ | ⬜"
    expect(grantKind("admin", "audit.view")).toBe("full");
    expect(grantKind("treasurer", "audit.view")).toBe("scoped");
    expect(grantKind("committee_member", "audit.view")).toBe("none");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Coverage — the drift guard
// ─────────────────────────────────────────────────────────────────────────────

describe("narrowing-rule coverage", () => {
  it("has exactly one rule per conditional (🟡) cell of the matrix", () => {
    // A new 🟡 cell added to the evaluator without a rule here would reach
    // `canOnResource` and be refused for everybody — including the role the PRD
    // grants. This is the assertion that makes adding a cell a deliberate act.
    expect([...NARROWED_ACTIONS].sort()).toEqual([...SCOPED_ACTIONS].sort());
  });

  it("registers a rule only for actions the matrix marks conditional", () => {
    for (const action of NARROWED_ACTIONS) {
      expect(SCOPED_ACTIONS.has(action)).toBe(true);
      // At least one role holds it conditionally — which role differs per cell
      // (Committee for expense.create, Treasurer for audit.view, Resident and
      // Tenant for report.view_all), so the assertion names the *kind*, not a role.
      const narrowed = MEMBER_ROLES.filter(
        (role) => grantKind(role, action) === "scoped",
      );
      expect(narrowed.length).toBeGreaterThan(0);
    }
  });

  it("reads a resource kind that exists in the union", () => {
    for (const action of NARROWED_ACTIONS) {
      const rule = narrowingRuleFor(action);
      expect(rule).toBeDefined();
      expect(isResourceKind(rule?.kind)).toBe(true);
    }
  });

  it("names the PRD cell each rule transcribes", () => {
    // Each rule quotes its source row, so a reviewer can check it without opening
    // the PRD — and a rule whose cell is edited starts looking wrong in review.
    // The conditional marker and the capability it belongs to are both required:
    // a cell quoted without its 🟡 is a rule whose justification is not visible.
    for (const action of NARROWED_ACTIONS) {
      const cell = narrowingRuleFor(action)?.cell ?? "";
      expect(cell).toContain("🟡");
      expect(cell).toContain("—");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail closed
// ─────────────────────────────────────────────────────────────────────────────

describe("failing closed", () => {
  const building: ResourceSnapshot = { kind: "building", societyId: SOCIETY };

  it("refuses a membership that is not active, whatever its role says", () => {
    // A suspended Admin holds nothing: "suspended member must not remain
    // authorised" is the security property this layer is here to keep, and
    // `PermissionGuard` already answers `MEMBER_INACTIVE` before this runs.
    for (const status of ["pending", "removed"] as const) {
      expect(
        canOnResource(member("admin", { status }), "structure.edit", building),
      ).toBe(false);
    }
  });

  it("refuses a record in another society before consulting any rule", () => {
    // The cross-tenant case, and the reason `societyId` is part of the subject.
    // An Admin of their own society is not an Admin of this row.
    expect(
      canOnResource(member("admin"), "structure.edit", {
        kind: "building",
        societyId: OTHER_SOCIETY,
      }),
    ).toBe(false);
    expect(
      canOnResource(member("admin"), "expense.void", {
        kind: "expense",
        societyId: OTHER_SOCIETY,
        createdByMembershipId: ME,
        published: false,
      }),
    ).toBe(false);
  });

  it("refuses an action that is not in the matrix at all", () => {
    // Reachable from an untyped boundary — a decorator with a loose signature, a
    // hand-written `SetMetadata`. "Unknown" must not mean "allowed".
    expect(
      canOnResource(
        member("admin"),
        "expense.destroy_everything" as unknown as Action,
        building,
      ),
    ).toBe(false);
  });

  it("refuses a resource kind an action's rule does not cover", () => {
    // A rule that reads `assigneeMembershipId` on a report is a bug; here it is a
    // refusal rather than a crash or an accidental permit.
    expect(
      canOnResource(member("committee_member"), "complaint.resolve", {
        kind: "report",
        societyId: SOCIETY,
        scope: "summary",
      }),
    ).toBe(false);
    expect(
      canOnResource(member("committee_member"), "expense.void", {
        kind: "audit",
        societyId: SOCIETY,
        category: "financial",
      }),
    ).toBe(false);
  });

  it("refuses a role wherever the matrix gives it nothing", () => {
    // Stated over the matrix rather than over a hand-picked list, so the assertion
    // stays true as cells change. Guest is the interesting subject because the one
    // cell it *does* hold (`visitor.log` — "Log visitor entry/exit (gate)") is the
    // reason a blanket "Guest is refused everything" would have been wrong.
    let refused = 0;
    for (const action of ACTIONS) {
      if (grantKind("guest", action) !== "none") {
        continue;
      }
      expect(canOnResource(member("guest"), action, resourceFor(action))).toBe(
        false,
      );
      refused += 1;
    }
    expect(refused).toBe(ACTIONS.length - 1);
  });

  it("decides rather than throwing, so a caller can map the refusal", () => {
    // `false` is a decision, not a status code: the use case decides whether that
    // is a 404 (a row the caller may not see) or a 403 (a rule they may know).
    expect(() =>
      canOnResource(member("admin"), "structure.view", {
        kind: "apartment",
        societyId: OTHER_SOCIETY,
      }),
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The six conditional cells
// ─────────────────────────────────────────────────────────────────────────────

describe("expense.create — 🟡 (draft only)", () => {
  const draft: ResourceSnapshot = {
    kind: "expense",
    societyId: SOCIETY,
    createdByMembershipId: null,
    published: false,
  };
  const published: ResourceSnapshot = { ...draft, published: true };

  it("lets a Committee Member create one that stays a draft", () => {
    expect(
      canOnResource(member("committee_member"), "expense.create", draft),
    ).toBe(true);
  });

  it("refuses a Committee Member creating something already published", () => {
    // The whole point of the cell: 🟡 is "draft only", so publishing stays with
    // the ✅ roles (`expense.publish`) rather than riding along with create.
    expect(
      canOnResource(member("committee_member"), "expense.create", published),
    ).toBe(false);
  });

  it("does not narrow the ✅ holders", () => {
    for (const role of ["admin", "treasurer"] as const) {
      expect(canOnResource(member(role), "expense.create", published)).toBe(
        true,
      );
    }
  });

  it("ignores ownership, because the record does not exist yet", () => {
    // A create has no creator: the snapshot carries whoever the caller said, and
    // the cell does not turn on it.
    expect(
      canOnResource(member("committee_member"), "expense.create", {
        ...draft,
        createdByMembershipId: SOMEBODY_ELSE,
      }),
    ).toBe(true);
  });
});

describe("expense.void — 🟡 own drafts", () => {
  const mine: ResourceSnapshot = {
    kind: "expense",
    societyId: SOCIETY,
    createdByMembershipId: ME,
    published: false,
  };

  it("lets a Committee Member edit their own draft", () => {
    expect(
      canOnResource(member("committee_member"), "expense.void", mine),
    ).toBe(true);
  });

  it("refuses somebody else's draft", () => {
    expect(
      canOnResource(member("committee_member"), "expense.void", {
        ...mine,
        createdByMembershipId: SOMEBODY_ELSE,
      }),
    ).toBe(false);
  });

  it("refuses their own draft once it is published", () => {
    expect(
      canOnResource(member("committee_member"), "expense.void", {
        ...mine,
        published: true,
      }),
    ).toBe(false);
  });

  it("does not narrow the ✅ holders, who may edit any draft", () => {
    const theirs = { ...mine, createdByMembershipId: SOMEBODY_ELSE };
    for (const role of ["admin", "treasurer"] as const) {
      expect(canOnResource(member(role), "expense.void", theirs)).toBe(true);
    }
  });

  it("refuses an unowned record for the conditional role", () => {
    // A snapshot with no creator cannot satisfy "own", and must not be read as
    // "owned by nobody, so fine".
    expect(
      canOnResource(member("committee_member"), "expense.void", {
        ...mine,
        createdByMembershipId: null,
      }),
    ).toBe(false);
  });
});

describe("complaint.assign — 🟡 to self", () => {
  const toMe: ResourceSnapshot = {
    kind: "complaint",
    societyId: SOCIETY,
    assigneeMembershipId: ME,
    raisedByMembershipId: SOMEBODY_ELSE,
  };

  it("lets a Committee Member take a complaint themselves", () => {
    expect(
      canOnResource(member("committee_member"), "complaint.assign", toMe),
    ).toBe(true);
  });

  it("refuses handing it to another member", () => {
    expect(
      canOnResource(member("committee_member"), "complaint.assign", {
        ...toMe,
        assigneeMembershipId: SOMEBODY_ELSE,
      }),
    ).toBe(false);
  });

  it("lets an Admin assign to anybody", () => {
    expect(
      canOnResource(member("admin"), "complaint.assign", {
        ...toMe,
        assigneeMembershipId: SOMEBODY_ELSE,
      }),
    ).toBe(true);
  });

  it("gives a Treasurer nothing — the PRD cell is ⬜", () => {
    expect(canOnResource(member("treasurer"), "complaint.assign", toMe)).toBe(
      false,
    );
  });
});

describe("complaint.resolve — 🟡 assigned / 🟡 own (close)", () => {
  const assignedToMe: ResourceSnapshot = {
    kind: "complaint",
    societyId: SOCIETY,
    assigneeMembershipId: ME,
    raisedByMembershipId: SOMEBODY_ELSE,
  };
  const raisedByMe: ResourceSnapshot = {
    ...assignedToMe,
    assigneeMembershipId: SOMEBODY_ELSE,
    raisedByMembershipId: ME,
  };

  it("lets a Committee Member resolve the one assigned to them", () => {
    expect(
      canOnResource(
        member("committee_member"),
        "complaint.resolve",
        assignedToMe,
      ),
    ).toBe(true);
  });

  it("lets a Resident close their own", () => {
    for (const role of ["resident", "tenant"] as const) {
      expect(canOnResource(member(role), "complaint.resolve", raisedByMe)).toBe(
        true,
      );
    }
  });

  it("does not let the two cells trade places", () => {
    // The cell is per-role, and this is the assertion that keeps it that way: a
    // Committee Member is not granted the *close-own* path, and a Resident is not
    // granted the *assigned* path.
    expect(
      canOnResource(
        member("committee_member"),
        "complaint.resolve",
        raisedByMe,
      ),
    ).toBe(false);
    expect(
      canOnResource(member("resident"), "complaint.resolve", assignedToMe),
    ).toBe(false);
  });

  it("refuses somebody else's complaint to every conditional holder", () => {
    const unrelated: ResourceSnapshot = {
      kind: "complaint",
      societyId: SOCIETY,
      assigneeMembershipId: SOMEBODY_ELSE,
      raisedByMembershipId: SOMEBODY_ELSE,
    };
    for (const role of ["committee_member", "resident", "tenant"] as const) {
      expect(canOnResource(member(role), "complaint.resolve", unrelated)).toBe(
        false,
      );
    }
  });

  it("lets an Admin resolve anything", () => {
    expect(
      canOnResource(member("admin"), "complaint.resolve", raisedByMe),
    ).toBe(true);
  });
});

describe("report.view_all — 🟡 summary", () => {
  it("gives a Resident the summary and not the society view", () => {
    expect(
      canOnResource(member("resident"), "report.view_all", {
        kind: "report",
        societyId: SOCIETY,
        scope: "summary",
      }),
    ).toBe(true);
    expect(
      canOnResource(member("resident"), "report.view_all", {
        kind: "report",
        societyId: SOCIETY,
        scope: "society",
      }),
    ).toBe(false);
  });

  it("does not narrow committee, treasurer or admin", () => {
    for (const role of ["admin", "treasurer", "committee_member"] as const) {
      expect(
        canOnResource(member(role), "report.view_all", {
          kind: "report",
          societyId: SOCIETY,
          scope: "society",
        }),
      ).toBe(true);
    }
  });
});

describe("audit.view — 🟡 financial only", () => {
  it("narrows a Treasurer to the financial entries", () => {
    expect(
      canOnResource(member("treasurer"), "audit.view", {
        kind: "audit",
        societyId: SOCIETY,
        category: "financial",
      }),
    ).toBe(true);
    expect(
      canOnResource(member("treasurer"), "audit.view", {
        kind: "audit",
        societyId: SOCIETY,
        category: "other",
      }),
    ).toBe(false);
  });

  it("shows an Admin everything", () => {
    expect(
      canOnResource(member("admin"), "audit.view", {
        kind: "audit",
        societyId: SOCIETY,
        category: "other",
      }),
    ).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The actions with no 🟡 cell
// ─────────────────────────────────────────────────────────────────────────────

describe("actions with no conditional cell", () => {
  it("answers with the tenant check alone", () => {
    // `structure.view` is ✅ for five roles and ⬜ for Guest. There is no rule to
    // narrow, so an in-society record is permitted for an eligible role and a
    // foreign one is refused — the whole extent of resource authorisation for a
    // cell the PRD does not qualify.
    for (const role of [
      "admin",
      "treasurer",
      "committee_member",
      "resident",
      "tenant",
    ] as const) {
      expect(
        canOnResource(member(role), "structure.view", {
          kind: "apartment",
          societyId: SOCIETY,
        }),
      ).toBe(true);
    }
    expect(
      canOnResource(member("resident"), "structure.view", {
        kind: "apartment",
        societyId: OTHER_SOCIETY,
      }),
    ).toBe(false);
  });

  it("requires no snapshot kind per action, only that the tenant matches", () => {
    // Nothing in the rules pins `structure.edit` to buildings, and it must not:
    // the same action governs buildings, wings and flats, and a rule that
    // enumerated them would have to be edited for every future resource.
    for (const kind of RESOURCE_KINDS) {
      expect(
        canOnResource(member("admin"), "structure.edit", resourceOfKind(kind)),
      ).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The subject mapping
// ─────────────────────────────────────────────────────────────────────────────

describe("memberSnapshotOf", () => {
  it("keeps the four authorisation facts and nothing else", () => {
    const membership: SocietyMembership = {
      id: ME,
      societyId: SOCIETY,
      userId: asUserId("55555555-5555-4555-8555-555555555555"),
      role: "treasurer",
      status: "active",
      occupancyType: "owner",
      joinedAt: "2026-01-01T00:00:00.000Z",
    };

    expect(memberSnapshotOf(membership)).toEqual({
      membershipId: ME,
      societyId: SOCIETY,
      role: "treasurer",
      status: "active",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

/** A well-formed snapshot for the resource an action's rule reads, if any. */
function resourceFor(action: Action): ResourceSnapshot {
  const rule = narrowingRuleFor(action);
  return resourceOfKind(rule?.kind ?? "society");
}

/**
 * A well-formed snapshot of `kind`, with every fact pointing at the caller — so a
 * test that means "this resource is not the caller's" has to say so explicitly.
 */
function resourceOfKind(kind: ResourceKind): ResourceSnapshot {
  switch (kind) {
    case "expense":
      return {
        kind,
        societyId: SOCIETY,
        createdByMembershipId: ME,
        published: false,
      };
    case "complaint":
      return {
        kind,
        societyId: SOCIETY,
        assigneeMembershipId: ME,
        raisedByMembershipId: ME,
      };
    case "report":
      return { kind, societyId: SOCIETY, scope: "society" };
    case "audit":
      return { kind, societyId: SOCIETY, category: "financial" };
    case "society":
    case "building":
    case "apartment":
    case "member":
    case "invitation":
    case "join_request":
      return { kind, societyId: SOCIETY };
  }
}
