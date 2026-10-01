import { Inject, Injectable } from "@nestjs/common";
import {
  createExpenseCategory,
  deleteExpenseCategory,
  listExpenseCategories,
  updateExpenseCategory,
} from "@ses/application";
import type {
  CreateExpenseCategoryCommand,
  ExpenseCategoryDeps,
  ExpenseCategoryList,
  UpdateExpenseCategoryCommand,
} from "@ses/application";
import type {
  ExpenseCategory,
  ExpenseCategoryId,
  ExpenseCategoryRepository,
  ExpenseError,
  ExpenseMembershipReader,
  ExpenseReferenceReader,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import { MEMBERSHIP_READER } from "../../../common/authorization/membership-reader";
import { toAppError } from "./expense-category-error.mapper";
import {
  EXPENSE_CATEGORY_REPOSITORY,
  EXPENSE_REFERENCE_READER,
} from "./expense-category.tokens";

/**
 * The API's view of the expense-category use cases.
 *
 * **No business rules live here.** Every rule — the capability checks, the value
 * objects, the strategy/basis pair, the duplicate-name check, the reference check,
 * "absent means unchanged" — is already implemented in `@ses/application`, which the
 * mobile app calls too. This class does the two things that are genuinely specific to
 * HTTP:
 *
 *  1. it supplies the dependencies (`ExpenseCategoryRepository`,
 *     `ExpenseReferenceReader` and the membership read the capability evaluation needs)
 *     from the container rather than as values;
 *  2. it unwraps `Result` into a value or a thrown `AppError`, because a controller
 *     that had to branch on `ok` on every route would reintroduce the per-endpoint
 *     divergence the shared layer exists to prevent.
 *
 * The `(deps, actor, …) → Result` shape is what makes (1) trivial: the use cases are
 * pure functions, so there is nothing to construct per request and nothing to reset
 * between them.
 *
 * ## Why the membership reader is injected rather than the society's operations
 *
 * `SocietyOperations` exposes the profile a screen renders, which is a different
 * question from "what role does this caller hold here": that read returns the society,
 * the roster and the capabilities, and asking it for one role would make every category
 * request pay for a roster. `MEMBERSHIP_READER` is the narrow port the use cases
 * declare, and the provider behind it is still the one implementation of a `members`
 * row translation — the societies module exports it already for the structure module,
 * so this module adds no cross-module wiring of its own.
 */
@Injectable()
export class ExpenseCategoryOperations {
  constructor(
    @Inject(EXPENSE_CATEGORY_REPOSITORY)
    private readonly categories: ExpenseCategoryRepository,
    @Inject(EXPENSE_REFERENCE_READER)
    private readonly expenses: ExpenseReferenceReader,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: ExpenseMembershipReader,
  ) {}

  private get deps(): ExpenseCategoryDeps {
    return {
      categories: this.categories,
      expenses: this.expenses,
      memberships: this.memberships,
    };
  }

  async list(
    actor: UserId,
    societyId: SocietyId,
  ): Promise<ExpenseCategoryList> {
    return unwrap(listExpenseCategories(this.deps, actor, societyId));
  }

  async create(
    actor: UserId,
    societyId: SocietyId,
    command: CreateExpenseCategoryCommand,
  ): Promise<ExpenseCategory> {
    return unwrap(createExpenseCategory(this.deps, actor, societyId, command));
  }

  async update(
    actor: UserId,
    societyId: SocietyId,
    categoryId: ExpenseCategoryId,
    command: UpdateExpenseCategoryCommand,
  ): Promise<ExpenseCategory> {
    return unwrap(
      updateExpenseCategory(this.deps, actor, societyId, categoryId, command),
    );
  }

  async remove(
    actor: UserId,
    societyId: SocietyId,
    categoryId: ExpenseCategoryId,
  ): Promise<void> {
    return unwrap(
      deleteExpenseCategory(this.deps, actor, societyId, categoryId),
    );
  }
}

/**
 * Awaits a use case and converts failure into the API's exception.
 *
 * `await` before branching, rather than `.then`, so a rejected promise (an adapter
 * throwing something the use case could not classify — the one case the use cases let
 * escape) propagates as itself and reaches the filter's `INTERNAL` path, instead of
 * being mistaken for a domain failure.
 */
async function unwrap<T>(
  pending: Promise<Result<T, ExpenseError>>,
): Promise<T> {
  const result = await pending;
  if (!result.ok) {
    throw toAppError(result.error);
  }
  return result.value;
}
