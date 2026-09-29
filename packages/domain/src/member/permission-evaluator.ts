import type { MemberRole } from "../society/society";

/**
 * The role→action matrix — SAD §9.3, encoded from PRD §2.1.
 *
 * **This file is the single source of truth.** The API's `PermissionGuard` calls
 * it, the mobile UI calls it, and the committed RLS policies mirror it. SAD §9.3
 * is explicit that these three must not each own a copy: a matrix that exists in
 * three languages drifts in the same way a schema does, and the failure mode is
 * silent over- or under-granting rather than an error. A conformance test
 * (`__tests__/permission-evaluator.test.ts`) walks every `(role × action)` pair
 * against the PRD and fails the build on any divergence.
 *
 * ## Why this is not in `society/`
 *
 * Permissions are scoped to a **membership**, not a society and not a user
 * (PRD §2: "One user may be a Resident in Society A and a Treasurer in Society
 * B"). The matrix's input is a role from a membership, so it lives beside the
 * member concept rather than inside the society aggregate.
 *
 * ## ✅ and 🟡 are both "eligible"
 *
 * The PRD marks three kinds of cell: ✅ full, 🟡 own/assigned records only, ⬜
 * none. `can()` answers the coarse question — *may a role ever perform this
 * action?* — so a 🟡 role is **eligible**, and the resource-level question ("is
 * it *this* member's draft?") is a second, narrower check the owning module
 * performs. Encoding 🟡 as denial instead would be wrong in a way that is easy to
 * miss: a Committee Member could not assign a complaint to themselves, and a
 * Resident could not close their own complaint, although the PRD grants both.
 *
 * The consequence is deliberate and worth stating plainly: **passing
 * `@RequirePermission` for a scoped action is not authorisation on its own.** The
 * handler must narrow with `isScopedAction()`. `SCOPED_ACTIONS` exists so that
 * requirement is machine-checkable rather than folklore, and so a route that
 * declares one can be found by grep.
 */

/**
 * Every action in the system — SAD §9.3's union verbatim, plus the three actions
 * its own §9.5 table grants but omits from the union (`expense.view`,
 * `payment.pay_own`, `complaint.create`), plus the two read actions two modules
 * needed before their routes could be guarded at all (`structure.view`, T042;
 * `member.view`, T045).
 *
 * Dotted, not colon-separated: the SAD, the PRD's implementation note and the
 * existing mobile `RequirePermission` call sites all use `'expense.create'`.
 */
export const ACTIONS = [
  "society.edit",
  "society.delete",
  "structure.edit",
  "structure.view",
  "member.view",
  "member.invite",
  "member.approve",
  "member.role_change",
  "member.remove",
  "expense.create",
  "expense.view",
  "expense.publish",
  "expense.approve",
  "expense.void",
  "payment.record",
  "payment.verify",
  "payment.refund",
  "payment.pay_own",
  "cycle.create",
  "cycle.publish",
  "reminder.send",
  "complaint.create",
  "complaint.assign",
  "complaint.resolve",
  "notice.post",
  "notice.emergency",
  "visitor.log",
  "visitor.approve",
  "report.view_all",
  "report.export",
  "audit.view",
  "subscription.manage",
] as const;

export type Action = (typeof ACTIONS)[number];

const ACTION_SET: ReadonlySet<string> = new Set(ACTIONS);

/**
 * The matrix, written as grants per action rather than per role.
 *
 * Per action, because that is how a reviewer reads it against the PRD: one row of
 * PRD §2.1 maps to one entry here, so a divergence shows up as a diff on the
 * capability someone changed rather than as a wall of role keys.
 *
 * `full` is ✅; `scoped` is 🟡 (eligible, then narrowed against the resource);
 * an omitted role is ⬜.
 */
interface Grants {
  readonly full: readonly MemberRole[];
  readonly scoped?: readonly MemberRole[];
}

const MATRIX_SOURCE: Readonly<Record<Action, Grants>> = {
  // ── society ────────────────────────────────────────────────────────────────
  // PRD: "Edit society profile & structure" — Admin only.
  "society.edit": { full: ["admin"] },
  // PRD: "Create/edit buildings, wings, apartments" — Admin only.
  "structure.edit": { full: ["admin"] },
  // The read half of the structure pair, and an addition to SAD §9.3's union.
  //
  // The SAD's own §9.5 table gives every role except Guest a view of the society,
  // and PRD §2.1 grants all six "View society dashboard" — but the action union
  // in §9.3, which is what the evaluator enumerates, has no read action for
  // structure at all. That omission has a concrete consequence beyond tidiness:
  // `SocietyGuard` and `PermissionGuard` are inert unless a route declares a
  // permission, so without a read action the building routes could only be
  // addressed by a path parameter and would run with no membership resolution at
  // all. Adding it is the same move §9.3 already records for `expense.view`,
  // `payment.pay_own` and `complaint.create` — actions its own matrix needs and
  // its union omitted.
  //
  // Guest is deliberately **not** included: PRD §2.1 grants that role gate logging
  // and nothing else, and the narrower answer is the one a reviewer can check
  // against the PRD rather than against a judgement about what a security guard
  // needs. The conformance test below asserts this cell like every other.
  "structure.view": {
    full: ["admin", "treasurer", "committee_member", "resident", "tenant"],
  },
  // PRD: "Delete society" — Admin only.
  "society.delete": { full: ["admin"] },

  // ── members ────────────────────────────────────────────────────────────────
  // The read half of the member pair, and an addition to SAD §9.3's union for the
  // same reason `structure.view` is one (T045).
  //
  // PRD §2.1 has no "view members" row, but §3.3's Member Directory — "searchable
  // list with flat number, role badge, occupancy, dues status (visible per the role
  // matrix)" — is a screen every resident has, and the action union had no read
  // action that could put the roster behind the guard chain at all. Without one, the
  // directory route could only be addressed by a path parameter and would run with no
  // membership resolution whatsoever (see `buildings.controller.ts` for the full
  // argument).
  //
  // Guest is excluded, exactly as it is for `structure.view`: PRD §2.1 grants that
  // role gate logging and nothing else, so the narrower cell is the one a reviewer can
  // check against the PRD rather than against a judgement about what a security guard
  // needs. The SQL is broader (an active Guest can read the roster rows) and that
  // asymmetry is the same one the structure module documents: RLS decides which rows
  // exist for a database caller, the matrix decides which operations this API offers.
  "member.view": {
    full: ["admin", "treasurer", "committee_member", "resident", "tenant"],
  },
  // PRD: "Invite members" / "Approve join requests" — Admin and Treasurer.
  "member.invite": { full: ["admin", "treasurer"] },
  "member.approve": { full: ["admin", "treasurer"] },
  // PRD: "Assign / change roles" / "Remove members" — Admin only, and never
  // self-assignable (PRD §13: privilege escalation is the named threat).
  "member.role_change": { full: ["admin"] },
  "member.remove": { full: ["admin"] },

  // ── expenses ───────────────────────────────────────────────────────────────
  // SAD §9.5: admin ✅, treasurer ✅, committee 🟡 draft. PRD §13's risk table
  // — "malicious/compromised treasurer" — is why a Treasurer cannot approve:
  // `expense.approve` is Admin-only below.
  "expense.create": {
    full: ["admin", "treasurer"],
    scoped: ["committee_member"],
  },
  // PRD: "View all expenses & receipts" — everyone except Guest.
  "expense.view": {
    full: ["admin", "treasurer", "committee_member", "resident", "tenant"],
  },
  // PRD: "Define split rules" — Admin and Treasurer.
  "expense.publish": { full: ["admin", "treasurer"] },
  // PRD: "Approve expense above threshold" — Admin only. The default threshold
  // is ₹10,000 (PRD §2.2), which is exactly the point of separating this from
  // `expense.publish`.
  "expense.approve": { full: ["admin"] },
  // PRD: "Edit/delete expense" — admin ✅, treasurer ✅, committee 🟡 own drafts.
  // NOTE: SAD §9.5's condensed table omits the committee cell here, while its
  // own `canOnResource` example has an `expense.void` branch that only makes
  // sense if a non-Admin can reach it. The PRD row is the source, so it wins.
  "expense.void": {
    full: ["admin", "treasurer"],
    scoped: ["committee_member"],
  },

  // ── payments ───────────────────────────────────────────────────────────────
  // PRD: "Record offline payment (cash/cheque/NEFT)" and "Mark payment
  // verified" — Admin and Treasurer.
  "payment.record": { full: ["admin", "treasurer"] },
  "payment.verify": { full: ["admin", "treasurer"] },
  "payment.refund": { full: ["admin", "treasurer"] },
  // PRD: "Pay own dues online" — every member except Guest.
  "payment.pay_own": {
    full: ["admin", "treasurer", "committee_member", "resident", "tenant"],
  },

  // ── cycles ─────────────────────────────────────────────────────────────────
  // PRD: "Create maintenance cycle / run billing" and "Send reminders" — Admin
  // and Treasurer. This is the pair of actions whose absence of a Resident path
  // makes the monthly cycle a two-person job, which is the product's premise.
  "cycle.create": { full: ["admin", "treasurer"] },
  "cycle.publish": { full: ["admin", "treasurer"] },
  "reminder.send": { full: ["admin", "treasurer"] },

  // ── complaints ─────────────────────────────────────────────────────────────
  // PRD: "Raise complaint" — everyone except Guest.
  "complaint.create": {
    full: ["admin", "treasurer", "committee_member", "resident", "tenant"],
  },
  // PRD: "Assign complaint" — admin ✅, committee 🟡 to self, treasurer ⬜.
  "complaint.assign": { full: ["admin"], scoped: ["committee_member"] },
  // PRD: "Resolve complaint" — admin ✅, committee 🟡 assigned, resident and
  // tenant 🟡 own (close).
  "complaint.resolve": {
    full: ["admin"],
    scoped: ["committee_member", "resident", "tenant"],
  },

  // ── notices ────────────────────────────────────────────────────────────────
  // PRD: "Post notice" / "Post emergency notice" — Admin, Treasurer, Committee.
  // Residents deliberately cannot post: a notice board every member can write to
  // is one nobody reads.
  "notice.post": { full: ["admin", "treasurer", "committee_member"] },
  "notice.emergency": { full: ["admin", "treasurer", "committee_member"] },

  // ── visitors ───────────────────────────────────────────────────────────────
  // PRD: "Log visitor entry/exit (gate)" — Admin, and the Guest role's Security
  // sub-role. Notably NOT the Treasurer or a Committee Member: gate logging is
  // the one thing a Guest account exists to do.
  "visitor.log": { full: ["admin", "guest"] },
  // PRD: "Approve visitor for own flat" — everyone except Guest (a Guest does
  // not have a flat to approve visitors for).
  "visitor.approve": {
    full: ["admin", "treasurer", "committee_member", "resident", "tenant"],
  },

  // ── reporting ──────────────────────────────────────────────────────────────
  // PRD: "View reports (society-wide)" — admin ✅, treasurer ✅, committee ✅,
  // resident and tenant 🟡 summary only. Individual defaulter names are gated by
  // the same row (PRD §6), which is why the summary case is scoped rather than
  // granted outright.
  "report.view_all": {
    full: ["admin", "treasurer", "committee_member"],
    scoped: ["resident", "tenant"],
  },
  // PRD: "Export reports (PDF/CSV)" — Admin and Treasurer.
  "report.export": { full: ["admin", "treasurer"] },
  // PRD: "View audit log" — admin ✅, treasurer 🟡 financial only.
  "audit.view": { full: ["admin"], scoped: ["treasurer"] },

  // ── subscription ───────────────────────────────────────────────────────────
  // PRD: "Manage subscription & billing" — Admin only, because it spends the
  // society's money on the society's behalf.
  "subscription.manage": { full: ["admin"] },
};

/** Roles plus the actions it may ever perform, 🟡 included. */
const ELIGIBLE: Readonly<Record<MemberRole, ReadonlySet<Action>>> = (() => {
  const byRole = {
    admin: new Set<Action>(),
    treasurer: new Set<Action>(),
    committee_member: new Set<Action>(),
    resident: new Set<Action>(),
    tenant: new Set<Action>(),
    guest: new Set<Action>(),
  } satisfies Record<MemberRole, Set<Action>>;

  for (const action of ACTIONS) {
    const grants = MATRIX_SOURCE[action];
    for (const role of [...grants.full, ...(grants.scoped ?? [])]) {
      byRole[role].add(action);
    }
  }
  return byRole;
})();

/**
 * Actions whose grant is conditional on the resource (PRD's 🟡) and which
 * therefore **must** be narrowed by the owning handler before any record is
 * touched.
 */
export const SCOPED_ACTIONS: ReadonlySet<Action> = new Set(
  ACTIONS.filter((action) => (MATRIX_SOURCE[action].scoped?.length ?? 0) > 0),
);

/**
 * May `role` perform `action` at all?
 *
 * The coarse half of authorisation, and the only half a guard can answer: a guard
 * sees a role and an action, never a row. `true` means "eligible"; when the
 * action is in `SCOPED_ACTIONS` the caller must still narrow against the record.
 */
export function can(role: MemberRole, action: Action): boolean {
  return ELIGIBLE[role]?.has(action) ?? false;
}

/** True when a grant is conditional on the resource, so a handler must narrow. */
export function isScopedAction(action: Action): boolean {
  return SCOPED_ACTIONS.has(action);
}

/**
 * How a role holds an action: not at all, outright, or only on its own records.
 *
 * This is the distinction the PRD's own legend draws (`✅ full · 🟡 own/assigned
 * records only · ⬜ none`) and the one `can()` deliberately erases, because a
 * guard sees a role and an action and never a row. `canOnResource` needs it back:
 * a **full** grant needs no narrowing at all, a **scoped** one does, and the two
 * arrive at the same `true` from `can()`.
 *
 * It exists so the resource layer never has to special-case a role. The obvious
 * alternative — `if (member.role === "admin")` — would be a second grant list
 * maintained by hand, and it would be wrong the first time a cell changes: an
 * action whose 🟡 cell is granted to Admin as well (none today, but the shape is
 * one edit away) would take the override path and skip its own rule.
 *
 * Exported as a union rather than a boolean pair so the caller's own `switch` is
 * exhaustive over the three answers a matrix cell can give.
 */
export type GrantKind = "full" | "scoped" | "none";

/** The cell `(role × action)` in the matrix, told apart by kind. */
export function grantKind(role: MemberRole, action: Action): GrantKind {
  const grants = MATRIX_SOURCE[action];
  if (grants.full.includes(role)) {
    return "full";
  }
  if (grants.scoped?.includes(role) === true) {
    return "scoped";
  }
  return "none";
}

/** Narrowing helper for a value that arrived from a decorator or the wire. */
export function isAction(value: unknown): value is Action {
  return typeof value === "string" && ACTION_SET.has(value);
}

/** Every action a role may ever perform, in declaration order. */
export function actionsFor(role: MemberRole): readonly Action[] {
  return ACTIONS.filter((action) => can(role, action));
}
