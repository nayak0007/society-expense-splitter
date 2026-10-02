import {
  asExpenseError,
  createParticipantSelector,
  err,
  evaluateExpenseParticipantCapabilities,
  expenseError,
  ok,
  resolveExpenseParticipants,
} from "@ses/domain";
import type {
  ExpenseCategoryId,
  ExpenseCategoryRepository,
  ExpenseError,
  ExpenseMembershipReader,
  ExpenseParticipantCapabilities,
  ExpenseParticipantReader,
  ExpenseParticipantResolution,
  ExpenseSocietyReader,
  Result,
  SocietyId,
  SocietyMembership,
  UserId,
} from "@ses/domain";

/**
 * Resolve a participant selector into the flats an expense bills and the member each
 * charge is addressed to — Roadmap T063, PRD §3.5.4.
 *
 * ## Where it sits
 *
 * The policy lives in three places, and this file is the seam between them:
 *
 *  - `@ses/domain` owns the **rules** — the selector's shape, eligibility, owner-only
 *    routing, the reasons, the order (`resolveExpenseParticipants`);
 *  - the ports answer the **questions of fact** — who is in this society, what does the
 *    category say, what does the society's vacancy policy say;
 *  - this use case composes them, and owns exactly the two things neither of the others
 *    can: **authorization** and the **composition of the owner-only flag** (selector
 *    `ownerOnly` *or* the category's `is_owner_only`).
 *
 * Nothing here persists anything: it reads, decides and returns. The publish path
 * (T066) writes what resolution produced, and the preview (T064) writes nothing at all —
 * which is why "resolution is side-effect free" is a property of the *type*: every
 * dependency is a read-shaped port.
 *
 * ## The category is loaded, never trusted
 *
 * When a `categoryId` is given the category is read from storage — the caller's copy of
 * a flag is not evidence (the API's contract may carry a `categoryId`, never
 * `isOwnerOnly`). The load is T062's own `findCategory`, so the semantics are already
 * decided: another society's category and a soft-deleted one are both `not_found`, and
 * an **inactive** category resolves normally. That last one is deliberate and is the
 * T062 port's own hand-off ("the expense form (T063) filters on it — that is the
 * picker's rule, not this read's"): deactivating a category must not make a historical
 * expense unrecalculable, so the *active* rule belongs to the new-expense path (T065)
 * where a picker can enforce it, not to resolution, which must answer for a row that
 * already exists.
 *
 * ## Why the selector arrives as `unknown`
 *
 * Because it is *stored* as `jsonb` (`expenses.participant_selector`), and a
 * recalculation replays what was saved rather than what a later client sends. Validating
 * it here — through the same `createParticipantSelector` a request would go through —
 * means the wire path and the replay path cannot disagree about what a selector is. The
 * API contract still validates the shape at the boundary for a good error message; this
 * is the rule.
 */

export interface ExpenseParticipantDeps {
  readonly memberships: ExpenseMembershipReader;
  readonly categories: ExpenseCategoryRepository;
  readonly participants: ExpenseParticipantReader;
  readonly society: ExpenseSocietyReader;
}

export interface ResolveExpenseParticipantsCommand {
  /** The selector as it was stored or sent — validated here, not trusted. */
  readonly selector: unknown;
  /** When present, the category supplies `is_owner_only` (PRD §3.5.4). */
  readonly categoryId?: ExpenseCategoryId | null | undefined;
}

export interface ExpenseParticipantContext {
  readonly membership: SocietyMembership;
  readonly capabilities: ExpenseParticipantCapabilities;
}

/** One wording, so a refusal cannot drift between callers. */
export const EXPENSE_PARTICIPANT_RESOLVE_REASON =
  "Only a society Admin, Treasurer or Committee Member can choose who an expense is charged to.";

/**
 * Loads the caller's relationship to the society, or fails with `not_found`.
 *
 * The same rule `loadExpenseCategoryContext` records — a non-member and a removed
 * member are one answer, because a distinguishable one would let a caller prove another
 * tenant's society exists — kept local rather than shared, because the two loaders carry
 * *different* capability blocks and the shape of the deps differs; the wording of the
 * refusal is the part that must not drift, and it is one string in one place.
 */
async function loadParticipantContext(
  deps: ExpenseParticipantDeps,
  actor: UserId,
  societyId: SocietyId,
): Promise<Result<ExpenseParticipantContext, ExpenseError>> {
  try {
    const membership = await deps.memberships.findMembership(societyId, actor);

    if (membership === null || membership.status === "removed") {
      return err(
        expenseError("not_found", "That society is not available to you."),
      );
    }

    return ok({
      membership,
      capabilities: evaluateExpenseParticipantCapabilities(membership),
    });
  } catch (error: unknown) {
    return err(asExpenseError(error));
  }
}

/**
 * Resolves the selector. `Result`, never a throw, for every expected refusal — the same
 * contract every use case in this package keeps.
 */
export async function resolveParticipantsForExpense(
  deps: ExpenseParticipantDeps,
  actor: UserId,
  societyId: SocietyId,
  command: ResolveExpenseParticipantsCommand,
): Promise<Result<ExpenseParticipantResolution, ExpenseError>> {
  const loaded = await loadParticipantContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  if (!loaded.value.capabilities.canResolve) {
    return err(expenseError("forbidden", EXPENSE_PARTICIPANT_RESOLVE_REASON));
  }

  const selector = createParticipantSelector(command.selector);
  if (!selector.ok) return selector;

  // The category's flag is read, never accepted from the caller; a category that is
  // absent, soft-deleted or another society's is `not_found` (T062's semantics).
  let categoryOwnerOnly = false;
  const categoryId = command.categoryId ?? null;
  if (categoryId !== null) {
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
      categoryOwnerOnly = category.isOwnerOnly;
    } catch (error: unknown) {
      return err(asExpenseError(error));
    }
  }

  try {
    const [directory, society] = await Promise.all([
      deps.participants.listSocietyParticipants(societyId, actor),
      deps.society.findById(societyId, actor),
    ]);

    if (society === null) {
      return err(
        expenseError("not_found", "That society is not available to you."),
      );
    }

    return resolveExpenseParticipants(directory, {
      selector: selector.value,
      // The society's policy, from the society's own row — never from the request.
      billVacantFlats: society.settings.billVacantFlats,
      // Two flags, one meaning: the selector may ask for owners, and an owner-only
      // category *requires* them. Composed here so neither the domain core nor a
      // caller has to know about the other one.
      ownerOnly: selector.value.ownerOnly || categoryOwnerOnly,
      // The PRD's reason is recorded only for the category's own rule (§3.5.4); a
      // selector that asked for owners directly moved nobody's charge.
      ownerOnlyAssignedReason: categoryOwnerOnly ? "owner_only_category" : null,
    });
  } catch (error: unknown) {
    return err(asExpenseError(error));
  }
}
