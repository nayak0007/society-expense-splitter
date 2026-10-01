import {
  asExpenseError,
  createCategoryColor,
  createCategoryDisplayOrder,
  createCategoryIcon,
  createCategoryName,
  err,
  expenseError,
  ok,
  resolveCategoryApartmentBasis,
} from "@ses/domain";
import type {
  ApartmentBasis,
  ExpenseCategory,
  ExpenseCategoryId,
  ExpenseError,
  Result,
  SocietyId,
  SplitStrategy,
  UpdateExpenseCategoryInput,
  UserId,
} from "@ses/domain";

import {
  EXPENSE_CATEGORY_CHANGE_REASON,
  loadExpenseCategory,
  requireCategoryNameAvailable,
  requireExpenseCategoryCapability,
} from "./support";
import type { ExpenseCategoryDeps } from "./support";

/**
 * Edit an expense category (Roadmap T062: "Admin and treasurer can write…;
 * `default_split_strategy`, `is_owner_only`, `is_capital`, `gst_applicable` all
 * settable").
 *
 * ## Every seeded category is editable, because the PRD says so
 *
 * There is no immutability rule and none is encoded. PRD §Categories calls the
 * nineteen "seeded per society, **editable**" and draws no line between a seeded and
 * a society-created row; the schema has no `is_system` or `seed_key` to draw one
 * with. So `Maintenance` may be renamed, may have `gstApplicable` turned on and may
 * be deactivated — and the prompt-vs-Roadmap question this task had to answer ("may
 * default categories be redesigned?") is answered by the documents: T062 must not
 * *redesign* the nineteen (their names, order and two flags at birth are T060's
 * seed), but it must let a society change them afterwards, which is a different
 * thing from changing what they seed as.
 *
 * ## Absent means unchanged; `null` means cleared, for exactly three fields
 *
 * `icon`, `color` and `defaultApartmentBasis` are the nullable columns a society
 * genuinely needs to empty, so they carry `| null` in the command and a `null`
 * reaches the repository as a real assignment. Everything else is
 * `undefined`-or-a-value: `name` has no empty state, a strategy is one of five
 * values, and the three flags plus `isActive`/`displayOrder` are `NOT NULL`.
 *
 * ## The patch is validated as a whole, not field by field
 *
 * Every provided value goes through the same value objects the create path uses, and
 * the resulting `UpdateExpenseCategoryInput` carries only the keys the caller
 * actually set. Sending the *merged* object instead would make an edit that changed
 * only `isActive` also rewrite the name — harmless for the name and actively wrong
 * the moment a second writer has changed it in between.
 *
 * ## The strategy/basis pair is resolved against the stored row
 *
 * Which is why the category is loaded before the patch is built: a change from
 * `apartment` to `equal` has to *drop* the stored basis (a basis beside a non-apartment
 * strategy is a contradiction a reader would have to resolve), and a change in the
 * other direction has to keep the basis when the caller sends none. Only the basis
 * the request could have affected is written, so an edit that never mentioned either
 * field leaves both untouched.
 */
export interface UpdateExpenseCategoryCommand {
  readonly name?: string | undefined;
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

export async function updateExpenseCategory(
  deps: ExpenseCategoryDeps,
  actor: UserId,
  societyId: SocietyId,
  categoryId: ExpenseCategoryId,
  command: UpdateExpenseCategoryCommand,
): Promise<Result<ExpenseCategory, ExpenseError>> {
  const loaded = await loadExpenseCategory(deps, actor, societyId, categoryId);
  if (!loaded.ok) return loaded;

  const guard = requireExpenseCategoryCapability(
    loaded.value.capabilities,
    "canManage",
    EXPENSE_CATEGORY_CHANGE_REASON,
  );
  if (!guard.ok) return guard;

  if (!hasAnyField(command)) {
    // The wire contract refuses an empty patch too, so this is the second line: a
    // caller that reached the use case directly (a script, a test, the mobile
    // service) gets the same answer rather than a no-op write.
    return err(expenseError("validation", "Nothing to update."));
  }

  const current = loaded.value.category;
  const patch: MutablePatch = {};

  if (command.name !== undefined) {
    const name = createCategoryName(command.name);
    if (!name.ok) return name;
    patch.name = name.value;
  }

  if (command.icon !== undefined) {
    const icon = createCategoryIcon(command.icon);
    if (!icon.ok) return icon;
    patch.icon = icon.value;
  }

  if (command.color !== undefined) {
    const color = createCategoryColor(command.color);
    if (!color.ok) return color;
    patch.color = color.value;
  }

  if (command.displayOrder !== undefined) {
    const displayOrder = createCategoryDisplayOrder(command.displayOrder);
    if (!displayOrder.ok) return displayOrder;
    patch.displayOrder = displayOrder.value;
  }

  if (command.defaultSplitStrategy !== undefined) {
    patch.defaultSplitStrategy = command.defaultSplitStrategy;
  }

  const nextStrategy =
    command.defaultSplitStrategy ?? current.defaultSplitStrategy;
  const basisProvided = command.defaultApartmentBasis !== undefined;
  const strategyChanged =
    command.defaultSplitStrategy !== undefined &&
    command.defaultSplitStrategy !== current.defaultSplitStrategy;

  // Written only when this request could have changed it: a strategy move (which may
  // have to *drop* a stale basis) or an explicit basis. An edit that mentioned
  // neither field leaves both columns alone.
  if (strategyChanged || basisProvided) {
    patch.defaultApartmentBasis = resolveCategoryApartmentBasis(
      nextStrategy,
      basisProvided
        ? (command.defaultApartmentBasis ?? null)
        : current.defaultApartmentBasis,
    );
  }

  if (command.isOwnerOnly !== undefined) {
    patch.isOwnerOnly = command.isOwnerOnly;
  }
  if (command.isCapital !== undefined) {
    patch.isCapital = command.isCapital;
  }
  if (command.gstApplicable !== undefined) {
    patch.gstApplicable = command.gstApplicable;
  }
  if (command.isActive !== undefined) {
    patch.isActive = command.isActive;
  }

  if (patch.name !== undefined) {
    // `exceptId` is what lets a rename keep its own name — the unique index's
    // predicate excludes the row being updated, so this check has to as well or every
    // edit of a category whose name is unchanged would answer `conflict`.
    const available = await requireCategoryNameAvailable(
      deps,
      actor,
      societyId,
      patch.name,
      categoryId,
    );
    if (!available.ok) return available;
  }

  try {
    return ok(
      await deps.categories.update(categoryId, societyId, patch, actor),
    );
  } catch (error: unknown) {
    return err(asExpenseError(error));
  }
}

/**
 * The patch under construction, with mutable members.
 *
 * `UpdateExpenseCategoryInput` is `readonly` at every key — deliberately, because it
 * is what crosses the port — so building it up field by field needs one local type
 * that drops the modifier. It is not exported: the only thing a caller ever sees is
 * the frozen shape the port declares.
 */
type MutablePatch = {
  -readonly [
    K in keyof UpdateExpenseCategoryInput
  ]: UpdateExpenseCategoryInput[K];
};

function hasAnyField(command: UpdateExpenseCategoryCommand): boolean {
  return Object.values(command).some((value) => value !== undefined);
}
