import {
  asExpenseError,
  err,
  evaluateExpenseCategoryCapabilities,
  expenseError,
  ok,
} from "@ses/domain";
import type {
  ExpenseCategory,
  ExpenseCategoryCapabilities,
  ExpenseCategoryId,
  ExpenseCategoryRepository,
  ExpenseError,
  ExpenseMembershipReader,
  ExpenseReferenceReader,
  Result,
  SocietyId,
  SocietyMembership,
  UserId,
} from "@ses/domain";

/**
 * Use-case dependencies.
 *
 * Explicit and injected, never imported as singletons — the property that makes a use
 * case a pure function of `(deps, actor, …)` and lets a unit test pass a five-line
 * fake. No DI container, no module mocking, no `jest.mock`.
 *
 * Three dependencies because the answers come from three different questions, and
 * each is enforced by a different mechanism:
 *
 *  - `memberships` answers "what may this caller do here" — mirrored by the API's
 *    guard chain and by T060's `can_view_expenses`/`can_publish_expenses`;
 *  - `categories` answers "what is stored here" — mirrored by RLS alone;
 *  - `expenses` answers "is this category still in use", which is the *delete* rule
 *    and is a question about a different table.
 *
 * Folding `expenses` into the category port would tie a read of one table to the
 * adapter that owns another — see `ExpenseReferenceReader` in `@ses/domain` for the
 * full argument, which is the one `ApartmentRepository.countForBuilding` makes.
 */
export interface ExpenseCategoryDeps {
  readonly categories: ExpenseCategoryRepository;
  readonly expenses: ExpenseReferenceReader;
  readonly memberships: ExpenseMembershipReader;
}

/** Everything a use case needs to decide about one society and one caller. */
export interface ExpenseCategoryContext {
  /**
   * The caller's own membership. `active` is *not* guaranteed — a pending or removed
   * member reaches here so that the capability evaluation, which is the single place
   * that rule lives, decides what happens rather than the load step pre-empting it
   * with a different answer.
   */
  readonly membership: SocietyMembership;
  readonly capabilities: ExpenseCategoryCapabilities;
}

/** One wording, used by every write, so three refusals cannot drift apart. */
export const EXPENSE_CATEGORY_CHANGE_REASON =
  "Only a society Admin or Treasurer can change expense categories.";

/** One wording, used by the read. */
export const EXPENSE_CATEGORY_VIEW_REASON =
  "Your role in this society cannot view its expense categories.";

/**
 * Loads the caller's relationship to a society, or fails with `not_found`.
 *
 * `not_found` — never `forbidden` — when there is no membership at all: PRD T041
 * requires that a non-member cannot tell another tenant's society apart from a
 * non-existent id, and RLS enforces the same rule underneath so the answer is
 * identical whichever layer refuses.
 *
 * A `removed` membership is folded into the same answer, for the reason
 * `loadStructureContext` records: the caller once belonged and no longer does, there
 * is no state they can act in, and telling them "you were removed" from an endpoint
 * about expense categories would be a second, weaker answer to a question the
 * society module already answers properly.
 */
export async function loadExpenseCategoryContext(
  deps: ExpenseCategoryDeps,
  actor: UserId,
  societyId: SocietyId,
): Promise<Result<ExpenseCategoryContext, ExpenseError>> {
  try {
    const membership = await deps.memberships.findMembership(societyId, actor);

    if (membership === null || membership.status === "removed") {
      return err(
        expenseError("not_found", "That society is not available to you."),
      );
    }

    return ok({
      membership,
      capabilities: evaluateExpenseCategoryCapabilities(membership),
    });
  } catch (error: unknown) {
    return err(asExpenseError(error));
  }
}

/**
 * Turns a capability into a result. The message comes from the caller, which knows
 * which action it was attempting — so "Only a society Admin or Treasurer can change
 * expense categories" is attached to a write and "cannot view its expense categories"
 * to a read, from one evaluation of one matrix.
 */
export function requireExpenseCategoryCapability(
  capabilities: ExpenseCategoryCapabilities,
  capability: keyof ExpenseCategoryCapabilities,
  reason: string,
): Result<true, ExpenseError> {
  return capabilities[capability]
    ? ok(true)
    : err(expenseError("forbidden", reason));
}

/** A loaded society context plus one category inside it. */
export interface ExpenseCategoryLoaded extends ExpenseCategoryContext {
  readonly category: ExpenseCategory;
}

/**
 * Loads the caller's context and one category, or fails.
 *
 * The lookup is scoped by `societyId` **and** by the caller, and a category that
 * exists but belongs to another society is reported as `not_found` rather than as a
 * permission problem — a distinguishable answer lets a caller enumerate vocabulary
 * they cannot see.
 *
 * ## Why the row is loaded even for a patch that "only" changes one flag
 *
 * Two rules need the current state, and neither is a field-by-field check:
 *
 *  - the strategy/basis pair is a fact about the *pair*, so a patch that sets the
 *    strategy has to be resolved against the stored basis and a patch that sets the
 *    basis against the stored strategy (`resolveCategoryApartmentBasis`);
 *  - a rename has to keep its own name, which the uniqueness index's predicate
 *    excludes by id — so `exceptId` can only be supplied by a caller that knows the
 *    row's current name and id.
 *
 * Reading first is also what makes "this category is not yours" answer `not_found`
 * before any rule mentions a field.
 *
 * `deleted_at` rows are absent rather than rejected, because the repository filters
 * them: there is no state in which a removed category is addressable, so there is
 * none to report specially.
 */
export async function loadExpenseCategory(
  deps: ExpenseCategoryDeps,
  actor: UserId,
  societyId: SocietyId,
  categoryId: ExpenseCategoryId,
): Promise<Result<ExpenseCategoryLoaded, ExpenseError>> {
  const loaded = await loadExpenseCategoryContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  try {
    const category = await deps.categories.findCategory(
      categoryId,
      societyId,
      actor,
    );
    if (category === null) {
      return err(
        expenseError("not_found", "That category is not available to you."),
      );
    }
    return ok({ ...loaded.value, category });
  } catch (error: unknown) {
    return err(asExpenseError(error));
  }
}

/**
 * Refuses a name a live category of this society already carries.
 *
 * ## This is a courtesy, not the rule
 *
 * The rule is the partial unique index
 * `uq_expense_categories_society_name … WHERE deleted_at IS NULL`, and the adapter
 * translates its `23505` into the same `conflict` — so a concurrent creator between
 * this read and the insert lands on the same typed error rather than a 500. What this
 * check buys is the ordinary case answering without an exception round trip, and a
 * refusal that names the offending *field* from the module's own vocabulary instead
 * of from a classifier reading a constraint name.
 *
 * ## It compares exactly what the index compares
 *
 * Same society, live rows only, exact string, excluding the row being updated
 * (`exceptId`). It deliberately does **not** lower-case either side: a
 * case-insensitive comparison here would refuse a create the database would accept,
 * which is a rule with nothing behind it — and the divergence would only ever be
 * discovered by a society that wanted both `Lift` and `lift`. `createCategoryName`
 * has already collapsed whitespace, so the two strings being compared are the two
 * that will be stored.
 */
export async function requireCategoryNameAvailable(
  deps: ExpenseCategoryDeps,
  actor: UserId,
  societyId: SocietyId,
  name: string,
  exceptId?: ExpenseCategoryId,
): Promise<Result<true, ExpenseError>> {
  try {
    const existing = await deps.categories.findByName(
      name,
      societyId,
      actor,
      exceptId,
    );
    return existing === null
      ? ok(true)
      : err(
          expenseError(
            "conflict",
            "A category with that name already exists in this society.",
            // The field matters: a form has to attach the failure to the input the
            // user typed rather than showing a banner beside it.
            { field: "name" },
          ),
        );
  } catch (error: unknown) {
    return err(asExpenseError(error));
  }
}
