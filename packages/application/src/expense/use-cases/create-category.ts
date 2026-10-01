import {
  DEFAULT_CATEGORY_SPLIT_STRATEGY,
  asExpenseError,
  createCategoryColor,
  createCategoryDisplayOrder,
  createCategoryIcon,
  createCategoryName,
  err,
  ok,
  resolveCategoryApartmentBasis,
} from "@ses/domain";
import type {
  ApartmentBasis,
  CreateExpenseCategoryInput,
  ExpenseCategory,
  ExpenseError,
  Result,
  SocietyId,
  SplitStrategy,
  UserId,
} from "@ses/domain";

import {
  EXPENSE_CATEGORY_CHANGE_REASON,
  loadExpenseCategoryContext,
  requireCategoryNameAvailable,
  requireExpenseCategoryCapability,
} from "./support";
import type { ExpenseCategoryDeps } from "./support";

/**
 * Create an expense category (Roadmap T062, PRD §Categories: "seeded per society,
 * editable").
 *
 * The command is raw, wire-shaped input — every field unvalidated by the time it
 * arrives, which is the point: validation happens *here*, through the value objects,
 * so the API, a seed script and a test all get the same rules and the same
 * field-level errors. Nothing reaches the repository until the category is coherent.
 *
 * ## Admin **or Treasurer**, and that is not a copy of the structure module's rule
 *
 * `structure.edit` is Admin-only; this is not. Expense categories are society
 * *vocabulary* rather than physical structure, and the treasurer is the role that
 * maintains it — T060's own comment on `can_publish_expenses` says so outright
 * ("Active holder of `expense.publish` / `expense.void` — and of category writes — in
 * this society: Admin or Treasurer"), and it is the predicate behind the table's
 * `INSERT` and `UPDATE` policies. Reading the rule off the domain's matrix
 * (`canManageExpenseCategories`) rather than writing `role === "treasurer"` here is
 * what keeps the guard, the policy and the UI affordance in one place.
 *
 * ## The defaults are resolved here rather than left to the columns
 *
 * `default_split_strategy` defaults to `'equal'`, the three flags to `false`,
 * `is_active` to `true` and `display_order` to `0`. Every one of them is resolved by
 * this use case anyway, for the reason `createBuilding` resolves the display order:
 * the result should be the same whether the write went to Postgres or to a fake, and
 * a test asserting the shape of a freshly created category must not be asserting
 * which adapter ran.
 */
export interface CreateExpenseCategoryCommand {
  readonly name: string;
  readonly icon?: string | null | undefined;
  readonly color?: string | null | undefined;
  readonly defaultSplitStrategy?: SplitStrategy | undefined;
  readonly defaultApartmentBasis?: ApartmentBasis | null | undefined;
  readonly isOwnerOnly?: boolean | undefined;
  readonly isCapital?: boolean | undefined;
  readonly gstApplicable?: boolean | undefined;
  readonly isActive?: boolean | undefined;
  readonly displayOrder?: number | undefined;
}

export async function createExpenseCategory(
  deps: ExpenseCategoryDeps,
  actor: UserId,
  societyId: SocietyId,
  command: CreateExpenseCategoryCommand,
): Promise<Result<ExpenseCategory, ExpenseError>> {
  const loaded = await loadExpenseCategoryContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  const guard = requireExpenseCategoryCapability(
    loaded.value.capabilities,
    "canManage",
    EXPENSE_CATEGORY_CHANGE_REASON,
  );
  if (!guard.ok) return guard;

  const name = createCategoryName(command.name);
  if (!name.ok) return name;

  const icon = createCategoryIcon(command.icon);
  if (!icon.ok) return icon;

  const color = createCategoryColor(command.color);
  if (!color.ok) return color;

  const displayOrder = createCategoryDisplayOrder(command.displayOrder);
  if (!displayOrder.ok) return displayOrder;

  // The pair rule lives in the domain (`resolveCategoryApartmentBasis`): a basis
  // supplied for anything but the `apartment` strategy is dropped rather than
  // refused, because a form posting the whole object sends one on every save.
  const strategy =
    command.defaultSplitStrategy ?? DEFAULT_CATEGORY_SPLIT_STRATEGY;
  const basis = resolveCategoryApartmentBasis(
    strategy,
    command.defaultApartmentBasis ?? null,
  );

  const available = await requireCategoryNameAvailable(
    deps,
    actor,
    societyId,
    name.value,
  );
  if (!available.ok) return available;

  const input: CreateExpenseCategoryInput = {
    name: name.value,
    icon: icon.value,
    color: color.value,
    defaultSplitStrategy: strategy,
    defaultApartmentBasis: basis,
    isOwnerOnly: command.isOwnerOnly ?? false,
    isCapital: command.isCapital ?? false,
    gstApplicable: command.gstApplicable ?? false,
    // Settable, and `true` when absent. A society migrating its vocabulary in is the
    // caller that sends an explicit `false`.
    isActive: command.isActive ?? true,
    displayOrder: displayOrder.value,
  };

  try {
    return ok(await deps.categories.create(societyId, input, actor));
  } catch (error: unknown) {
    return err(asExpenseError(error));
  }
}
