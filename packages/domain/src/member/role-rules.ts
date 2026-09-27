import { actionsFor, can } from "./permission-evaluator";
import type { Action } from "./permission-evaluator";
import { MEMBER_ROLES } from "../society/society";
import type { MemberRole } from "../society/society";
import { memberError } from "./errors";
import type { MemberError } from "./errors";
import { err, ok } from "../shared/result";
import type { Result } from "../shared/result";
import type { MemberStatus } from "./member";

/**
 * Role-change rules — Roadmap T046, from PRD §2.2 and §2.3.
 *
 * ## Why this is a module of its own next to `permission-evaluator.ts`
 *
 * The evaluator answers *what a role may do*; this answers *who may hand that role out, and to
 * whom*. They are different questions with different sources in the PRD — §2.1's capability
 * matrix against §2.2's role definitions and §2.3's transition table — and keeping them apart is
 * what stops a rule like "at most 2 treasurers" from being smuggled into the matrix as a
 * capability, where the conformance test would then have to pretend it is a cell of §2.1.
 *
 * ## The three rules that are *not* here, and where they are
 *
 *  1. **A member may not change their own role.** `chk_member_self_change()` raises
 *     `MEMBER_ROLE_CHANGE_FORBIDDEN` in the database, and the use case refuses first so the
 *     caller gets a sentence instead of a SQLSTATE. Not restated as a rule object here because
 *     it is a property of the *write path*, not of a pair of roles.
 *  2. **A society must keep an active Admin.** `chk_admin_present()` raises
 *     `SOCIETY_ADMIN_REQUIRED`, which the module already reports as `sole_admin`.
 *  3. **The two caps** (≤ 3 admins, ≤ 2 treasurers) are here, because they are counts rather
 *     than states: no row can see them, so only a caller that has counted can enforce them —
 *     and the same counts are re-checked by a trigger, since two admins promoting at once would
 *     each pass their own read.
 *
 * ## Order is the PRD's
 *
 * `ROLE_ORDER` is PRD §2.1's column order, and the catalogue endpoints and the mobile role
 * picker both render it. Seniority in the UI matters: a list that puts `guest` above `admin`
 * reads as a bug even when every rule behind it is right.
 */
export const ROLE_ORDER: readonly MemberRole[] = [
  "admin",
  "treasurer",
  "committee_member",
  "resident",
  "tenant",
  "guest",
];

/**
 * The role a membership holds unless somebody is given another one.
 *
 * The column default (`DEFAULT_MEMBER_ROLE`) and the self-join policy both pin it, and
 * *revoking* a role means returning to it — PRD §2.3's transitions all end at `resident` (or at
 * `removed`), which is why revoke is a role change rather than a deletion of anything.
 */
export const REVOKE_TARGET_ROLE: MemberRole = "resident";

/**
 * The caps, from PRD §2.2 — verbatim, including that they are about **active** members.
 *
 * A suspended treasurer does not occupy a slot: they cannot act, and counting them would make a
 * society that suspended somebody unable to appoint their replacement.
 */
export const MAX_ADMINS = 3;
export const MAX_TREASURERS = 2;

export const ROLE_LIMITS: Readonly<Partial<Record<MemberRole, number>>> = {
  admin: MAX_ADMINS,
  treasurer: MAX_TREASURERS,
};

/**
 * The cap that applies to a role, or `undefined` when none does.
 *
 * Exported so a caller can skip the count a cap would need: `checkRoleLimit` is the rule, but
 * counting is a read, and a role with no limit does not have to pay for one. On the mobile
 * client that read is an HTTP request, which is exactly where "unnecessary permission queries"
 * (the task's own words) stops being a nicety.
 */
export function roleLimit(role: MemberRole): number | undefined {
  return ROLE_LIMITS[role];
}

/** One role as the catalogue presents it: a name and everything it may do. */
export interface RoleDefinition {
  readonly role: MemberRole;
  /** `actionsFor(role)` — the evaluator's own answer, never a second list. */
  readonly permissions: readonly Action[];
}

/**
 * Every role with its full permission set, in PRD order.
 *
 * The permissions are **not** written here: they are the evaluator's `actionsFor(role)`, which
 * is the same function the guard, the RLS mirror and the mobile affordance logic read. A
 * catalogue that restated the matrix would be the fourth copy §9.3 warns about, and the one
 * nobody would notice drifting until a UI offered an action the API refuses.
 */
export function roleDefinitions(): readonly RoleDefinition[] {
  return ROLE_ORDER.map((role) => ({ role, permissions: actionsFor(role) }));
}

/** One role's definition, or `undefined` for a value that is not a role at all. */
export function roleDefinition(role: MemberRole): RoleDefinition {
  return { role, permissions: actionsFor(role) };
}

/** Is this string one of the six roles? (`role` arrives from a URL or a body.) */
export function isMemberRole(value: unknown): value is MemberRole {
  return (
    typeof value === "string" &&
    (MEMBER_ROLES as readonly string[]).includes(value)
  );
}

/**
 * May `actorRole` hand out `targetRole`?
 *
 * Admin-only, because PRD §2.1 gives "Assign / change roles" to the Admin alone — a Treasurer
 * administers money, not people, and the asymmetry is the point of having two roles.
 *
 * Every role is assignable by an Admin, `admin` included: PRD §2.2 allows up to three admins,
 * and the *self*-promotion case (the escalation §9.3 names as the threat) is refused separately
 * and unconditionally — by `chk_member_self_change()` in the database and by the use case
 * before it. What is deliberately **not** implemented is PRD §2.2's handover ("transfer requires
 * the new admin to accept"): acceptance needs a pending-transfer record, which is its own task,
 * so an Admin promoted today is promoted immediately and the acceptance step is listed as
 * remaining work rather than quietly dropped.
 */
export function canAssignRole(
  actorRole: MemberRole,
  targetRole: MemberRole,
): boolean {
  if (!can(actorRole, "member.role_change")) return false;
  return isMemberRole(targetRole);
}

/**
 * Refuses a change that would breach a cap, given how many **active** members already hold the
 * role — excluding the row being written, which is what makes re-assigning a member the role
 * they already hold count once rather than twice.
 */
export function checkRoleLimit(
  role: MemberRole,
  activeHoldersExcludingTarget: number,
): Result<true, MemberError> {
  const limit = roleLimit(role);
  if (limit === undefined || activeHoldersExcludingTarget < limit)
    return ok(true);

  return err(
    memberError(
      "role_cap_exceeded",
      role === "admin"
        ? `A society can have at most ${String(MAX_ADMINS)} admins.`
        : `A society can have at most ${String(MAX_TREASURERS)} treasurers.`,
      { field: "role", role, limit },
    ),
  );
}

/**
 * A role change that is not a change.
 *
 * Reported rather than ignored: the caller asked for a state and the answer is "already so",
 * and silently reporting success would leave a screen showing "saved" over a write that never
 * happened — which is exactly how an Admin concludes the feature is broken.
 */
export function checkRoleChangeIsMeaningful(
  currentRole: MemberRole,
  targetRole: MemberRole,
): Result<true, MemberError> {
  if (currentRole === targetRole) {
    return err(
      memberError("conflict", "That member already has this role.", {
        field: "role",
      }),
    );
  }
  return ok(true);
}

/**
 * Refuses a role write against a membership that cannot act.
 *
 * A `removed` member is not a member (the module's read port filters them out for the same
 * reason), and a `pending` or `rejected` applicant has not been admitted yet: promoting them
 * would be granting a role to somebody the society has not accepted, and demoting a rejected
 * applicant is meaningless. `inactive` is deliberately **allowed** — a suspended treasurer being
 * reinstated at a lower role is an ordinary administrative act.
 */
export function checkRoleTarget(
  status: MemberStatus,
): Result<true, MemberError> {
  if (status === "pending" || status === "rejected" || status === "removed") {
    return err(
      memberError(
        "conflict",
        "That membership is not active, so its role cannot be changed.",
        { field: "role", status },
      ),
    );
  }
  return ok(true);
}

/**
 * Refuses the demotion that would leave a society with no active Admin.
 *
 * The last-admin rule is enforced twice, deliberately: `chk_admin_present()` raises
 * `SOCIETY_ADMIN_REQUIRED` underneath (which this module reports as `sole_admin`, the code the
 * society module already uses for the same trigger), and this check runs first so the caller gets
 * a sentence about what to do instead of a SQLSTATE. Neither is redundant with the other — the
 * trigger also covers suspension and removal, which do not pass through a role change, and this
 * check is the only one that can explain the cap in the operation's own terms.
 *
 * `remainingAdmins` excludes the member being changed, which is why it is a count rather than a
 * boolean: the caller has just read the population, and passing the target's own row in would
 * make the last Admin look like one of two.
 */
export function checkAdminPresence(
  fromRole: MemberRole,
  toRole: MemberRole,
  remainingAdmins: number,
): Result<true, MemberError> {
  if (fromRole !== "admin" || toRole === "admin") return ok(true);
  if (remainingAdmins > 0) return ok(true);

  return err(
    memberError(
      "sole_admin",
      "A society needs at least one active Admin. Promote another member first.",
      { field: "role", remainingAdmins },
    ),
  );
}

/**
 * May `actorRole` take the role away from somebody else?
 *
 * One rule above `canAssignRole`: revoking is an assignment to `resident` (PRD §2.3's "Admin
 * revokes" row), so it is the same grant — and it is stated separately so a caller reads
 * "revoke" as the demotion it is rather than as a deletion of a row that keeps its history.
 */
export function canRevokeRole(actorRole: MemberRole): boolean {
  return canAssignRole(actorRole, REVOKE_TARGET_ROLE);
}

/**
 * The roles an Admin may pick in a UI, in PRD order.
 *
 * A presentation-shaped helper, and it lives here anyway because the alternative is a screen
 * filtering `ROLE_ORDER` against a rule it would have to re-derive. The list is every role: no
 * role is "unassignable" — the caps and the self-change rule are what bound the operation, and
 * none of them can be expressed by hiding an option.
 */
export function assignableRoles(): readonly MemberRole[] {
  return ROLE_ORDER;
}
