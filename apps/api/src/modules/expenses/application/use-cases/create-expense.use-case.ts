import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import {
  Expense,
  Money,
  asExpenseError,
  asExpenseId,
  asMemberId,
  canOnResource,
  createParticipantSelector,
  expenseError,
  memberSnapshotOf,
  paise,
} from "@ses/domain";
import type {
  ApartmentBasis,
  Clock,
  ExpenseApprovalPolicyReader,
  ExpenseCategoryRepository,
  ExpenseDraftFields,
  ExpenseMembershipReader,
  ExpenseRecord,
  ExpenseRepository,
  PaymentSource,
  SocietyId,
  SplitStrategy,
  UserId,
} from "@ses/domain";

import { MEMBERSHIP_READER } from "../../../../common/authorization/membership-reader";
import { toAppError } from "../expense-category-error.mapper";
import { EXPENSE_CATEGORY_REPOSITORY } from "../expense-category.tokens";
import {
  EXPENSE_APPROVAL_POLICY_READER,
  EXPENSE_CLOCK,
  EXPENSE_REPOSITORY,
} from "../expense.tokens";
import {
  CREATE_FORBIDDEN,
  loadCategoryOrNotFound,
  loadMembershipOrNotFound,
  submitAboveThreshold,
  unwrap,
} from "./expense-draft.support";
import {
  resolveSplitPlan,
  type PreviewSplitConfig,
} from "./preview-split.use-case";

/**
 * Create an expense — Roadmap T065, PRD §3.4.
 *
 * ## The steps, in the order that decides error precedence
 *
 * ```text
 * create(command)
 *   ├─ membership                                (authorisation subject)
 *   ├─ canOnResource("expense.create", draft)    (the 🟡 narrowing site)
 *   ├─ category (T062's read)                     (not_found for foreign/deleted)
 *   ├─ selector (createParticipantSelector)      (canonical, stored)
 *   ├─ resolveSplitPlan                          (T064's strategy/basis defaults)
 *   ├─ Expense.create(...)                       (T061's input rules)
 *   ├─ submitAboveThreshold(...)                 (PRD §2.2's rule)
 *   └─ repository.create(...)                    (one INSERT, RLS-scoped)
 * ```
 *
 * The contract pipe has already refused a malformed body, the guard chain has
 * refused a caller without the action, and this file's order is the rest: a
 * caller who fixes the first error can always re-run and reach the next one, and a
 * request that names a cross-society category never costs a settings read.
 *
 * ## What the client cannot say
 *
 * `status` is never read from the request: a new expense is `draft`, and only the
 * threshold rule can move it to `pending_approval` (and only for a caller the
 * database will accept writing that state). `createdBy` is the caller's membership,
 * never a body field. The category's flags are never trusted — the category is read
 * server-side, and its `defaultSplitStrategy`/`defaultApartmentBasis` are the only
 * facts taken from it, through the *same* `resolveSplitPlan` T064's preview calls, so
 * the preview and the saved draft cannot disagree about what a form will do.
 *
 * ## Nothing here publishes, splits or charges
 *
 * One row is inserted, with `published_at` null, no split row, no due and no event —
 * `Expense.create()` raises none and `submitForApproval()` raises none (T061's
 * catalogue has only `expense.published`/`expense.voided`). T066 owns everything
 * that makes a bill real, and the integration suite measures the tables it would
 * touch before and after this use case runs.
 */

/** What the route hands the use case — already parsed by the contract schema. */
export interface CreateExpenseCommand {
  readonly title: string;
  readonly amountPaise: number;
  readonly expenseDate: string;
  readonly categoryId: string;
  /** The column is `description`; the PRD calls the form field "notes". */
  readonly description?: string | null | undefined;
  readonly vendorName?: string | null | undefined;
  readonly paymentSource?: PaymentSource | undefined;
  readonly paidByMemberId?: string | null | undefined;
  readonly splitStrategy?: SplitStrategy | undefined;
  readonly apartmentBasis?: ApartmentBasis | null | undefined;
  readonly splitConfig?: PreviewSplitConfig | undefined;
  /** `unknown` on purpose: `createParticipantSelector` is the validator. */
  readonly participantSelector?: unknown;
}

@Injectable()
export class CreateExpenseUseCase {
  constructor(
    @Inject(EXPENSE_REPOSITORY)
    private readonly expenses: ExpenseRepository,
    @Inject(EXPENSE_CATEGORY_REPOSITORY)
    private readonly categories: ExpenseCategoryRepository,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: ExpenseMembershipReader,
    @Inject(EXPENSE_APPROVAL_POLICY_READER)
    private readonly policies: ExpenseApprovalPolicyReader,
    @Inject(EXPENSE_CLOCK) private readonly clock: Clock,
  ) {}

  /** Creates one draft (or pending-approval) expense and returns what landed. */
  async create(
    actor: UserId,
    societyId: SocietyId,
    command: CreateExpenseCommand,
  ): Promise<ExpenseRecord> {
    const membership = await loadMembershipOrNotFound(
      this.memberships,
      actor,
      societyId,
    );

    // The narrowing site the route inventory requires for a 🟡 action: the record
    // the caller is about to write is a draft, which is what a Committee Member's
    // `expense.create` cell covers.
    const allowed = canOnResource(
      memberSnapshotOf(membership),
      "expense.create",
      {
        kind: "expense",
        societyId,
        createdByMembershipId: membership.id,
        published: false,
      },
    );
    if (!allowed) {
      throw toAppError(expenseError("forbidden", CREATE_FORBIDDEN));
    }

    const category = await loadCategoryOrNotFound(
      this.categories,
      actor,
      societyId,
      command.categoryId,
    );

    const selector = await unwrap(
      createParticipantSelector(command.participantSelector ?? {}),
    );

    const plan = await unwrap(
      resolveSplitPlan(
        {
          amountPaise: command.amountPaise,
          selector,
          categoryId: command.categoryId,
          splitStrategy: command.splitStrategy,
          apartmentBasis: command.apartmentBasis,
          splitConfig: command.splitConfig,
        },
        category,
      ),
    );

    const expense = await unwrap(
      Expense.create({
        id: asExpenseId(randomUUID()),
        societyId,
        categoryId: category.id,
        title: command.title,
        amount: Money.fromPaise(paise(command.amountPaise)),
        expenseDate: command.expenseDate,
        createdBy: membership.id,
        clock: this.clock,
      }),
    );

    await submitAboveThreshold(
      expense,
      membership,
      actor,
      societyId,
      this.policies,
      this.clock,
    );

    const fields: ExpenseDraftFields = {
      description: command.description ?? null,
      vendorName: command.vendorName ?? null,
      paymentSource: command.paymentSource ?? "society_account",
      paidByMemberId:
        command.paidByMemberId == null
          ? null
          : asMemberId(command.paidByMemberId),
      splitStrategy: plan.strategy,
      apartmentBasis: plan.basis,
      splitConfig: command.splitConfig ?? {},
      participantSelector: selector,
    };

    try {
      return await this.expenses.create({ expense, fields }, actor);
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }
  }
}
