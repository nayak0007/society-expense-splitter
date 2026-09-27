import { MEMBER_ROLES } from "../../society/society";
import type { MemberRole } from "../../society/society";
import {
  ACTIONS,
  actionsFor,
  can,
  isAction,
  isScopedAction,
  SCOPED_ACTIONS,
} from "../permission-evaluator";
import type { Action } from "../permission-evaluator";

/**
 * The conformance test SAD §9.3 asks for: "a parameterised test iterates every
 * `(role × action)` pair against the PRD matrix and fails the build on any
 * divergence."
 *
 * The table below is **transcribed from PRD §2.1 by hand**, deliberately not
 * derived from the evaluator — a test that computed its expectations from the
 * implementation would pass no matter what either said, which is precisely the
 * failure mode this file exists to prevent.
 *
 * Divergences are collected and asserted as a list rather than emitted as one
 * test per pair: 180 generated cases drown the signal, and the useful output here
 * is *which* cells drifted.
 */

/** Roles granted each action (✅ and 🟡 — the PRD grants both). */
const PRD_MATRIX: Readonly<Record<Action, readonly MemberRole[]>> = {
  "society.edit": ["admin"],
  "structure.edit": ["admin"],
  // Added to the union by T042: SAD §9.3's §9.5 table grants every role but Guest
  // a view of the society, while its own action union has no read action for
  // structure. Guest is excluded because PRD §2.1 gives that role gate logging
  // and nothing else — the same conservative cell the Guest test below asserts.
  "structure.view": [
    "admin",
    "treasurer",
    "committee_member",
    "resident",
    "tenant",
  ],
  "society.delete": ["admin"],
  "member.view": [
    "admin",
    "treasurer",
    "committee_member",
    "resident",
    "tenant",
  ],
  "member.invite": ["admin", "treasurer"],
  "member.approve": ["admin", "treasurer"],
  "member.role_change": ["admin"],
  "member.remove": ["admin"],
  "expense.create": ["admin", "treasurer", "committee_member"],
  "expense.view": [
    "admin",
    "treasurer",
    "committee_member",
    "resident",
    "tenant",
  ],
  "expense.publish": ["admin", "treasurer"],
  "expense.approve": ["admin"],
  "expense.void": ["admin", "treasurer", "committee_member"],
  "payment.record": ["admin", "treasurer"],
  "payment.verify": ["admin", "treasurer"],
  "payment.refund": ["admin", "treasurer"],
  "payment.pay_own": [
    "admin",
    "treasurer",
    "committee_member",
    "resident",
    "tenant",
  ],
  "cycle.create": ["admin", "treasurer"],
  "cycle.publish": ["admin", "treasurer"],
  "reminder.send": ["admin", "treasurer"],
  "complaint.create": [
    "admin",
    "treasurer",
    "committee_member",
    "resident",
    "tenant",
  ],
  "complaint.assign": ["admin", "committee_member"],
  "complaint.resolve": ["admin", "committee_member", "resident", "tenant"],
  "notice.post": ["admin", "treasurer", "committee_member"],
  "notice.emergency": ["admin", "treasurer", "committee_member"],
  "visitor.log": ["admin", "guest"],
  "visitor.approve": [
    "admin",
    "treasurer",
    "committee_member",
    "resident",
    "tenant",
  ],
  "report.view_all": [
    "admin",
    "treasurer",
    "committee_member",
    "resident",
    "tenant",
  ],
  "report.export": ["admin", "treasurer"],
  "audit.view": ["admin", "treasurer"],
  "subscription.manage": ["admin"],
};

/** The 🟡 cells — owned/assigned-record grants that a handler must narrow. */
const PRD_SCOPED: readonly Action[] = [
  "expense.create",
  "expense.void",
  "complaint.assign",
  "complaint.resolve",
  "report.view_all",
  "audit.view",
];

/** Every `(action, role)` pair the matrix can be asked about. */
const ALL_PAIRS: readonly (readonly [Action, MemberRole])[] = ACTIONS.flatMap(
  (action) => MEMBER_ROLES.map((role) => [action, role] as const),
);

describe("permission evaluator — coverage", () => {
  it("covers every action the PRD grants, and invents none", () => {
    expect([...ACTIONS].sort()).toEqual(Object.keys(PRD_MATRIX).sort());
  });

  it("grants only to real roles", () => {
    for (const roles of Object.values(PRD_MATRIX)) {
      for (const role of roles) {
        expect(MEMBER_ROLES).toContain(role);
      }
    }
  });

  it("exercises every role × action pair, so none can go untested", () => {
    expect(ALL_PAIRS).toHaveLength(ACTIONS.length * MEMBER_ROLES.length);
    expect(ACTIONS.length * MEMBER_ROLES.length).toBe(192);
  });
});

describe("can() against PRD §2.1", () => {
  it("matches the PRD for every role × action pair", () => {
    const divergences = ALL_PAIRS.filter(
      ([action, role]) =>
        can(role, action) !== PRD_MATRIX[action].includes(role),
    ).map(([action, role]) => `${action} × ${role}`);

    expect(divergences).toEqual([]);
  });
});

describe("scoped actions", () => {
  it("marks exactly the PRD's conditional grants", () => {
    expect([...SCOPED_ACTIONS].sort()).toEqual([...PRD_SCOPED].sort());
  });

  it("keeps a full grant out of the scoped set", () => {
    // `society.edit` is ✅ for admin — a handler must not be told to narrow it.
    expect(isScopedAction("society.edit")).toBe(false);
    expect(isScopedAction("member.role_change")).toBe(false);
  });

  it("treats a conditional grant as eligible, not as denial", () => {
    // The distinction that matters: the PRD grants a Committee Member their own
    // draft. Encoding 🟡 as denial would lock them out of it entirely.
    expect(can("committee_member", "expense.create")).toBe(true);
    expect(isScopedAction("expense.create")).toBe(true);

    // A Resident may close their own complaint, not somebody else's.
    expect(can("resident", "complaint.resolve")).toBe(true);
    expect(isScopedAction("complaint.resolve")).toBe(true);
  });

  it("leaves a Guest with the single action that role exists for", () => {
    // A Guest is deliberately the narrowest role: gate logging and nothing else.
    expect(actionsFor("guest")).toEqual(["visitor.log"]);
  });
});

describe("privilege boundaries (PRD §13)", () => {
  const ADMIN_ONLY: readonly Action[] = [
    "society.edit",
    "structure.edit",
    "society.delete",
    "member.role_change",
    "member.remove",
    "expense.approve",
    "subscription.manage",
  ];

  it("holds Admin-only actions to exactly one role", () => {
    const leaked = ADMIN_ONLY.flatMap((action) =>
      MEMBER_ROLES.filter((role) => role !== "admin" && can(role, action)).map(
        (role) => `${action} × ${role}`,
      ),
    );

    expect(leaked).toEqual([]);
  });

  it("never lets a non-Admin change a role", () => {
    // The named threat: privilege escalation to Treasurer. Only an Admin holds
    // the action, and the use case additionally refuses self-modification.
    const holders = MEMBER_ROLES.filter((role) =>
      can(role, "member.role_change"),
    );
    expect(holders).toEqual(["admin"]);
  });

  it("denies a Guest all financial visibility", () => {
    const financial: readonly Action[] = [
      "expense.create",
      "expense.view",
      "expense.publish",
      "expense.approve",
      "expense.void",
      "payment.record",
      "payment.verify",
      "payment.pay_own",
      "report.view_all",
      "report.export",
      "audit.view",
      "subscription.manage",
    ];

    expect(financial.filter((action) => can("guest", action))).toEqual([]);
  });

  it("gives a Resident no say over settings, roster or billing", () => {
    const governance: readonly Action[] = [
      "society.edit",
      "structure.edit",
      "member.invite",
      "member.approve",
      "member.role_change",
      "member.remove",
      "cycle.create",
      "cycle.publish",
    ];

    expect(governance.filter((action) => can("resident", action))).toEqual([]);
    expect(governance.filter((action) => can("tenant", action))).toEqual([]);
    // …while the roster itself is readable: PRD §3.3's directory is a resident
    // screen, and `member.view` is what puts it behind the guard chain.
    expect(can("resident", "member.view")).toBe(true);
    expect(can("guest", "member.view")).toBe(false);
  });

  it("keeps a Treasurer out of society administration", () => {
    // The compensating control for letting a Treasurer approve members and
    // publish cycles: they still cannot edit the society, change roles or pay
    // for the subscription (PRD §13, "malicious/compromised treasurer").
    const adminOnly: readonly Action[] = [
      "society.edit",
      "structure.edit",
      "society.delete",
      "member.role_change",
      "member.remove",
      "expense.approve",
      "subscription.manage",
    ];

    expect(adminOnly.filter((action) => can("treasurer", action))).toEqual([]);
  });
});

describe("isAction()", () => {
  it("accepts every declared action", () => {
    const rejected = ACTIONS.filter((action) => !isAction(action));
    expect(rejected).toEqual([]);
  });

  it("rejects a near miss, the wrong separator and a non-string", () => {
    expect(isAction("expense.created")).toBe(false);
    // The colon form is the mistake worth naming: it is what a caller writes
    // when they have seen the decorator but not the matrix.
    expect(isAction("expense:create")).toBe(false);
    expect(isAction("")).toBe(false);
    expect(isAction(undefined)).toBe(false);
    expect(isAction(7)).toBe(false);
  });
});
