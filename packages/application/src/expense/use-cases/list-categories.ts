import { asExpenseError, err, ok } from "@ses/domain";
import type {
  ExpenseCategory,
  ExpenseCategoryCapabilities,
  ExpenseError,
  Result,
  SocietyId,
  SocietyMembership,
  UserId,
} from "@ses/domain";

import {
  EXPENSE_CATEGORY_VIEW_REASON,
  loadExpenseCategoryContext,
  requireExpenseCategoryCapability,
} from "./support";
import type { ExpenseCategoryDeps } from "./support";

/**
 * List a society's expense categories (Roadmap T062, PRD §3.5.3 / §Categories).
 *
 * ## Why the reading role is checked here and not only in SQL
 *
 * The repository's query runs under RLS, which already returns nothing to a
 * non-member — so this guard changes no outcome for a member. It changes the
 * *answer*: an empty list is indistinguishable from a society whose vocabulary has
 * not been seeded yet, and a Guest (whose role holds no `expense.view`) would see a
 * plausible empty state rather than being told their role cannot view the
 * categories. "Nothing here yet" and "not for you" must not be the same screen.
 *
 * ## Why the list carries deactivated categories
 *
 * Because the management screen is the only place one can be brought back, and an
 * active-only list would make deactivation a one-way door. `isActive` travels on
 * every row, so a client that wants the picker's view — active only — filters in one
 * line rather than needing a second endpoint. See `ExpenseCategoryRepository.
 * listCategories` for the full argument.
 *
 * ## Why an empty list is not an error
 *
 * A society that has just been created is seeded with nineteen rows by
 * `seed_society()`, so an empty list means the seed has never run for it — a state
 * the structure step of the same onboarding flow can produce. Returning `[]` with
 * `capabilities` is what lets the client render "add your first category" instead of
 * an error state, and it is the answer a test can assert against.
 */
export interface ExpenseCategoryList {
  readonly categories: readonly ExpenseCategory[];
  readonly membership: SocietyMembership;
  readonly capabilities: ExpenseCategoryCapabilities;
}

export async function listExpenseCategories(
  deps: ExpenseCategoryDeps,
  actor: UserId,
  societyId: SocietyId,
): Promise<Result<ExpenseCategoryList, ExpenseError>> {
  const loaded = await loadExpenseCategoryContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  const guard = requireExpenseCategoryCapability(
    loaded.value.capabilities,
    "canView",
    EXPENSE_CATEGORY_VIEW_REASON,
  );
  if (!guard.ok) return guard;

  try {
    // Ordering is the repository's: `display_order`, then `name`. Doing it here
    // instead would mean sorting an already-sorted page in memory, which is the same
    // answer for the first page and the wrong one for the second.
    const categories = await deps.categories.listCategories(societyId, actor);

    return ok({
      categories,
      membership: loaded.value.membership,
      capabilities: loaded.value.capabilities,
    });
  } catch (error: unknown) {
    return err(asExpenseError(error));
  }
}
