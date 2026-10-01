import { can } from "../member/permission-evaluator";
import { RULE_ALLOWED, type RuleOutcome } from "../society/rules";
import type { MemberRole, SocietyMembership } from "../society/society";

/**
 * Capability rules for expense categories (Roadmap T062).
 *
 * Pure and total — no I/O, no clock — so the API can enforce the identical rule
 * inside the guard chain, the mobile app can decide whether to *offer* "add
 * category" without a round trip, and the response's `capabilities` block and the
 * button a screen renders cannot disagree (SAD §9.3).
 *
 * ## Which actions, and why no new one was added
 *
 * T062's acceptance is exactly two sentences: "Admin and treasurer can write; all
 * members can read." The matrix already answers both, and it answers them with the
 * *same actions the database's own policies use*:
 *
 *  - `expense.publish` is `{ full: [admin, treasurer] }` and T060's
 *    `can_publish_expenses()` is `is_society_member_manager()` = Admin or Treasurer.
 *    The migration's comment on that predicate says so in as many words — "Active
 *    holder of `expense.publish` / `expense.void` — **and of category writes** — in
 *    this society" — and it is what every category policy is `USING`/`WITH CHECK`.
 *  - `expense.view` marks every role but Guest, which is T060's `can_view_expenses()`
 *    (`admin, treasurer, committee, resident, tenant`).
 *
 * There is no `category.*` action in `ACTIONS`, and adding one would be the wrong
 * move even though it reads naturally: a second action per cell is a second thing
 * to keep in step with the two SQL predicates, and the day `expense.publish` is
 * granted to a Committee Member (a product change the PRD's roadmap could make) the
 * policy, the guard and this file all move together — where a `category.manage`
 * action would silently stay behind.
 *
 * ## Why there is no resource-level narrowing
 *
 * Both actions are **green** (`full`) cells for every role that holds them, so no
 * `canOnResource` narrowing applies and no route needs to be listed in the API's
 * `NARROWED_ROUTES`. The reason is structural rather than an omission: a category
 * has no owner, no assignee and no draft state, so the only question the matrix can
 * ask about one is the tenant question — and `societyId` is already the scope every
 * query carries. This is the same position `structure.edit` is in.
 */

/**
 * May this role change a society's expense categories?
 *
 * "Change" is one capability for create, edit, deactivate and delete, because T062's
 * acceptance draws no line between them — and the database agrees: the same
 * predicate guards the `INSERT` policy, the `UPDATE` policy and the reference check
 * inside `expense_category_soft_delete()`. The rule that *does* separate a delete
 * from an edit is about the category's expenses, not about the caller's role, so it
 * is a use-case rule and not a capability.
 */
export function canManageExpenseCategories(
  role: MemberRole | null,
): RuleOutcome {
  if (role !== null && can(role, "expense.publish")) return RULE_ALLOWED;
  return {
    allowed: false,
    reason: "Only a society Admin or Treasurer can change expense categories.",
  };
}

/**
 * May this role see the society's expense categories?
 *
 * Every role except a Guest — PRD §2.1 grants a Guest gate logging and nothing else,
 * and `expense.view`'s cell is `—` for them, so the answer follows the matrix rather
 * than a judgement about what a security guard "probably" needs.
 */
export function canViewExpenseCategories(role: MemberRole | null): RuleOutcome {
  if (role !== null && can(role, "expense.view")) return RULE_ALLOWED;
  return {
    allowed: false,
    reason: "Your role in this society cannot view its expense categories.",
  };
}

/**
 * Everything the UI may offer for one membership, derived in one place.
 *
 * Shipped in the list response so the client never re-derives a permission from a
 * role string — the same reason `StructureCapabilities` and `SocietyCapabilities`
 * exist: a disabled button and a rejected request must not be able to disagree.
 */
export interface ExpenseCategoryCapabilities {
  /** Create, edit, deactivate and delete categories. */
  readonly canManage: boolean;
  /** Read the category list. */
  readonly canView: boolean;
}

const NO_CAPABILITIES: ExpenseCategoryCapabilities = {
  canManage: false,
  canView: false,
};

/**
 * A membership that is not `active` has nothing — including a `pending` one.
 *
 * The `pending` case is the one that could have gone either way, and it is decided
 * the way `evaluateStructureCapabilities` decides it: a pending member's
 * `expense.view` is a grant on a membership the society has not admitted yet, and
 * T060's `can_view_expenses()` requires `status = 'active'` outright. The two layers
 * agree, which is the only outcome that matters — a screen that offered the list to
 * a pending member would be a screen whose first request 403s.
 */
export function evaluateExpenseCategoryCapabilities(
  membership: SocietyMembership | null,
): ExpenseCategoryCapabilities {
  if (membership === null || membership.status !== "active") {
    return NO_CAPABILITIES;
  }
  return {
    canManage: canManageExpenseCategories(membership.role).allowed,
    canView: canViewExpenseCategories(membership.role).allowed,
  };
}
