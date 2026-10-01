import { asExpenseError, err, expenseError, ok } from "@ses/domain";
import type {
  ExpenseCategoryId,
  ExpenseError,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import {
  EXPENSE_CATEGORY_CHANGE_REASON,
  loadExpenseCategory,
  requireExpenseCategoryCapability,
} from "./support";
import type { ExpenseCategoryDeps } from "./support";

/**
 * Delete an expense category (Roadmap T062: "Deletion blocked if expenses reference
 * the category; deactivation offered instead").
 *
 * Soft delete, and it returns nothing. The port's contract is `deleted_at` rather
 * than a `DELETE` — `DELETE` is not even granted on the table, and the tombstone is
 * written by `expense_category_soft_delete()` — so the application layer makes no
 * claim about physical deletion. Historical expenses name the category, and PRD
 * §3.1/§3.3 keep financial history; the row has to survive for those to keep their
 * subject.
 *
 * ## A category any expense has used is refused, and the refusal is a rule
 *
 * And the thing that makes this rule different from every other refusal in the
 * module: it is **not** about the caller's role and not about the payload. It is a
 * statement that the category is still load-bearing, which is why it has its own
 * error code rather than being a `conflict` — the copy a user needs is "deactivate it
 * instead", and collapsing the two would force the UI to match on message text to
 * tell that from "rename it".
 *
 * ## The reference check counts *every* expense, including voided ones
 *
 * `expenses` has no `deleted_at` at all — SAD §8.1 puts it in the "never deleted,
 * voided instead" tier — so there is no live-only filter to apply, and applying one
 * would be wrong anyway: a voided expense still renders its category's name in every
 * list and report it appears in. A category any expense has *ever* used is not
 * removable.
 *
 * ## Why the count comes from the expenses port
 *
 * `deps.expenses.countForCategory` — the port that owns the table being counted, the
 * same arrangement `deleteBuilding` has with `ApartmentRepository.countForBuilding`.
 * `ExpenseCategoryRepository` could have grown a `hasExpenses()`, but then the
 * category adapter would read a table it does not own and the number would be
 * unavailable for the message. The count is scoped by `(categoryId, societyId,
 * actor)` like every other read, so it can only ever count expenses the caller may
 * see.
 *
 * ## The count is *advisory*
 *
 * It is included in `details` so the message can say how many, but nothing branches
 * on it beyond that. Between this read and the delete another request could add an
 * expense — which is exactly why the database enforces the same rule
 * (`P0001/CATEGORY_HAS_EXPENSES` inside `expense_category_soft_delete()`), and why the
 * answer to that race is the same typed error rather than a 500.
 */
export async function deleteExpenseCategory(
  deps: ExpenseCategoryDeps,
  actor: UserId,
  societyId: SocietyId,
  categoryId: ExpenseCategoryId,
): Promise<Result<void, ExpenseError>> {
  const loaded = await loadExpenseCategory(deps, actor, societyId, categoryId);
  if (!loaded.ok) return loaded;

  const guard = requireExpenseCategoryCapability(
    loaded.value.capabilities,
    "canManage",
    EXPENSE_CATEGORY_CHANGE_REASON,
  );
  if (!guard.ok) return guard;

  try {
    const referenceCount = await deps.expenses.countForCategory(
      categoryId,
      societyId,
      actor,
    );

    if (referenceCount > 0) {
      return err(
        expenseError(
          "category_has_expenses",
          referenceCount === 1
            ? "1 expense uses this category. Deactivate it instead of deleting it."
            : `${referenceCount} expenses use this category. Deactivate it instead of deleting it.`,
          { count: referenceCount },
        ),
      );
    }

    await deps.categories.remove(categoryId, societyId, actor);
    return ok(undefined);
  } catch (error: unknown) {
    return err(asExpenseError(error));
  }
}
