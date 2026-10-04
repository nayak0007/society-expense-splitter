import {
  asExpenseCategoryId,
  asExpenseError,
  expenseError,
  grantKind,
} from "@ses/domain";
import type {
  Clock,
  Expense,
  ExpenseApprovalPolicy,
  ExpenseApprovalPolicyReader,
  ExpenseCategory,
  ExpenseCategoryRepository,
  ExpenseError,
  ExpenseId,
  ExpenseMembershipReader,
  ExpenseRecord,
  ExpenseRepository,
  ExpenseResourceSnapshot,
  Result,
  SocietyId,
  SocietyMembership,
  UserId,
} from "@ses/domain";

import { toAppError } from "../expense-category-error.mapper";

/**
 * The pieces every T065 use case repeats — the loaders, the resource snapshot, the
 * threshold rule and the `Result` seam — in one place, so five files cannot drift.
 *
 * This module is a support file beside the five use cases the Roadmap names, and it
 * is deliberately *not* a sixth use case: nothing here orchestrates. Each function is
 * one rule with one owner, and the rule is stated here once rather than five times.
 */

/** No membership and a removed one are one answer — PRD T041's 404-not-403. */
export const EXPENSE_NOT_FOUND = "That expense is not available to you.";

/** The refusal a caller reads when `canOnResource` says no to a create. */
export const CREATE_FORBIDDEN =
  "Only a society Admin, Treasurer or Committee Member can add an expense.";

/** The refusal a caller reads when narrowing says no to an edit. */
export const EDIT_FORBIDDEN =
  "Only a society Admin or Treasurer — or the Committee Member who created a draft — can edit this expense.";

/** PRD §3.5: drafts are hard-deletable **by their creator**. */
export const DELETE_FORBIDDEN =
  "Only the member who created a draft can delete it.";

/**
 * The caller's membership, or `not_found`.
 *
 * The same rule the preview use case keeps: no membership and a removed membership
 * are one answer (a distinguishable one would let a caller prove another tenant's
 * society exists), and a `pending` membership is left for the resource decision to
 * refuse — its grant is a grant on a membership the society has not admitted.
 */
export async function loadMembershipOrNotFound(
  memberships: ExpenseMembershipReader,
  actor: UserId,
  societyId: SocietyId,
): Promise<SocietyMembership> {
  let membership: SocietyMembership | null;
  try {
    membership = await memberships.findMembership(societyId, actor);
  } catch (error: unknown) {
    throw toAppError(asExpenseError(error));
  }

  if (membership === null || membership.status === "removed") {
    throw toAppError(
      expenseError("not_found", "That society is not available to you."),
    );
  }
  return membership;
}

/** One expense of the caller's society, or `not_found`. */
export async function loadExpenseOrNotFound(
  expenses: ExpenseRepository,
  actor: UserId,
  societyId: SocietyId,
  expenseId: ExpenseId,
): Promise<ExpenseRecord> {
  let record: ExpenseRecord | null;
  try {
    record = await expenses.findById(expenseId, societyId, actor);
  } catch (error: unknown) {
    throw toAppError(asExpenseError(error));
  }

  if (record === null) {
    throw toAppError(expenseError("not_found", EXPENSE_NOT_FOUND));
  }
  return record;
}

/**
 * The category an expense is filed under, or `not_found` — read through T062's own
 * `findCategory`, so a soft-deleted category and another society's are the same
 * answer an insert would meet moments later.
 *
 * An **inactive** category resolves normally, which is T062's recorded hand-off: the
 * expense form filters on `isActive` (that is the picker's rule), while a draft whose
 * category was deactivated after the fact must stay editable — refusing the save
 * would strand it.
 */
export async function loadCategoryOrNotFound(
  categories: ExpenseCategoryRepository,
  actor: UserId,
  societyId: SocietyId,
  categoryId: string,
): Promise<ExpenseCategory> {
  let category: ExpenseCategory | null;
  try {
    category = await categories.findCategory(
      asExpenseCategoryId(categoryId),
      societyId,
      actor,
    );
  } catch (error: unknown) {
    throw toAppError(asExpenseError(error));
  }

  if (category === null) {
    throw toAppError(
      expenseError("not_found", "That category is not available to you."),
    );
  }
  return category;
}

/**
 * The stored expense, reduced to the facts authorisation reads.
 *
 * `published` is `status !== "draft"` — the matrix's two states as the PRD's own
 * cells draw them, and the *stricter* reading for the 🟡 "own drafts" cell: a
 * `pending_approval` expense is not a draft, so a Committee Member's grant does not
 * cover it (the RLS update policy agrees: their branch requires `status = 'draft'`).
 * Admin and Treasurer hold `expense.void` outright, so the field never narrows them.
 */
export function snapshotOf(record: ExpenseRecord): ExpenseResourceSnapshot {
  return {
    kind: "expense",
    societyId: record.societyId,
    createdByMembershipId: record.createdBy,
    published: record.status !== "draft",
  };
}

/**
 * PRD §2.2's threshold: an expense **above** `approval_threshold_paise` enters
 * `pending_approval` and requires an Admin (Roadmap T065's acceptance).
 *
 * Two facts decide it, and both are checked before anything is read:
 *
 *  - a **full** `expense.create` holder (Admin, Treasurer) may submit; a 🟡
 *    Committee Member's expense stays a draft. That is the Roadmap's "Committee
 *    members may create drafts only", and it is also the database's rule — the
 *    `expenses_insert_author` policy requires `status = 'draft'` from a
 *    `can_draft_expenses` caller, so submitting on their behalf would be refused
 *    mid-transaction;
 *  - `>` and not `>=`: the PRD says "above the threshold", and T070's later "at or
 *    above" wording is that row's decision to make (recorded in T065's report).
 *
 * A promotion that is not needed returns before the settings read, so the common
 * draft write costs no extra query, and an already-submitted expense is never
 * re-submitted (`submitForApproval` would refuse the move anyway; skipping it keeps
 * the intent legible).
 */
export async function submitAboveThreshold(
  expense: Expense,
  membership: SocietyMembership,
  actor: UserId,
  societyId: SocietyId,
  policies: ExpenseApprovalPolicyReader,
  clock: Clock,
): Promise<void> {
  if (expense.status !== "draft") return;
  if (grantKind(membership.role, "expense.create") !== "full") return;

  let policy: ExpenseApprovalPolicy | null;
  try {
    policy = await policies.findById(societyId, actor);
  } catch (error: unknown) {
    throw toAppError(asExpenseError(error));
  }

  if (policy === null) {
    throw toAppError(
      expenseError("not_found", "That society is not available to you."),
    );
  }

  if (expense.amount.paise > policy.settings.approvalThresholdPaise) {
    const submitted = expense.submitForApproval(clock);
    if (!submitted.ok) throw toAppError(submitted.error);
  }
}

/**
 * Unwraps a `Result` — or a promise of one — into a value or a thrown `AppError`.
 *
 * The same seam the preview use case keeps, and for the same reason: the controller
 * never branches on `ok`, and a pure `Result` refusal and a repository failure reach
 * the HTTP layer in one shape.
 */
export async function unwrap<T>(
  pending: Result<T, ExpenseError> | Promise<Result<T, ExpenseError>>,
): Promise<T> {
  const result = await pending;
  if (!result.ok) {
    throw toAppError(result.error);
  }
  return result.value;
}
