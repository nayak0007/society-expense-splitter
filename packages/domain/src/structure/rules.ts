import { can } from "../member/permission-evaluator";
import { RULE_ALLOWED, type RuleOutcome } from "../society/rules";
import type { MemberRole, SocietyMembership } from "../society/society";

/**
 * Capability rules for the building module.
 *
 * Pure and total — no I/O, no clock — so the API can enforce the identical rule
 * inside a transaction and the mobile app can decide whether to *offer* an action
 * without a round trip.
 *
 * ## These delegate to the matrix rather than naming roles
 *
 * `canManageStructure("treasurer")` is spelled `can(role, 'structure.edit')`, not
 * `role === 'admin'` (SAD §9.3: "This function is the single source of truth").
 * A role literal written here would be a second copy of a cell the conformance
 * test does not enumerate — and the failure mode is silent under- or
 * over-granting rather than an error. The convenience matters for a second
 * reason: the day `structure.edit` is granted to a Committee Member, this file,
 * the API guard, the RLS policy and the UI affordance all move together.
 *
 * ## Which actions exist, and why there are two
 *
 * `structure.edit` is Admin-only in PRD §2.1 ("Create/edit buildings, wings,
 * apartments") and already existed. `structure.view` did **not**: the SAD's action
 * union has no read action for structure at all, while its own permission table
 * grants every role a view. It is added for the same reason SAD §9.3 already
 * records three additions (`expense.view`, `payment.pay_own`, `complaint.create`)
 * — an action its matrix needs but its union omitted — and it is what lets the
 * building routes be **header-scoped** (and therefore run behind `SocietyGuard`
 * and `PermissionGuard`, which are inert without a declared permission) rather
 * than being addressed by a path parameter with no guard at all.
 */

/** PRD §2.1 "Create/edit buildings, wings, apartments" — Admin only. */
export function canManageStructure(role: MemberRole | null): RuleOutcome {
  if (role !== null && can(role, "structure.edit")) return RULE_ALLOWED;
  return {
    allowed: false,
    reason: "Only a society Admin can change the society structure.",
  };
}

/**
 * May this role see the society's buildings?
 *
 * Every role except a Guest. A Guest is the narrowest role by design (PRD §2.1
 * grants it gate logging and nothing else; the SAD's table marks it `—` on
 * dashboard, structure and finances alike), so the answer follows the matrix
 * rather than a judgement about what a security guard "probably" needs.
 */
export function canViewStructure(role: MemberRole | null): RuleOutcome {
  if (role !== null && can(role, "structure.view")) return RULE_ALLOWED;
  return {
    allowed: false,
    reason: "Your role in this society cannot view its structure.",
  };
}

/**
 * Everything the UI may offer for one membership, derived in one place.
 *
 * Shipped in the API's responses so the client never re-derives a permission from
 * a role string — the same reason `SocietyCapabilities` exists: a disabled button
 * and a rejected request must not be able to disagree (SAD §9.3).
 */
export interface StructureCapabilities {
  /** Create, edit and delete buildings. */
  readonly canManage: boolean;
  /** Read the building list and a single building. */
  readonly canView: boolean;
}

const NO_CAPABILITIES: StructureCapabilities = {
  canManage: false,
  canView: false,
};

/**
 * A `removed` membership has nothing, and a `pending` one has nothing either.
 *
 * The `pending` case is deliberate and is the one that could have gone the other
 * way: a pending member *can* see the society they applied to (`society_snapshot`
 * allows it, so the "waiting for approval" screen can show its name), and the
 * join flow has to pick a building before the request is approved. But that
 * selection is addressed by the **join code**, not by the society — a code is a
 * capability, and the picker for it belongs to the join RPC (T043/T054), not to
 * this module's member-scoped reads. Until that exists, a pending member sees no
 * structure, and `structure.view` refusing them is the honest answer rather than
 * a partially-true one.
 */
export function evaluateStructureCapabilities(
  membership: SocietyMembership | null,
): StructureCapabilities {
  if (membership === null || membership.status !== "active") {
    return NO_CAPABILITIES;
  }
  return {
    canManage: canManageStructure(membership.role).allowed,
    canView: canViewStructure(membership.role).allowed,
  };
}
