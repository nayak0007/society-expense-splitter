import { Inject, Injectable } from "@nestjs/common";
import {
  Expense,
  Money,
  asExpenseCategoryId,
  asExpenseError,
  asMemberId,
  canOnResource,
  createParticipantSelector,
  expenseError,
  isExpenseEditableStatus,
  memberSnapshotOf,
  paise,
} from "@ses/domain";
import type {
  ApartmentBasis,
  Clock,
  ExpenseApprovalPolicyReader,
  ExpenseCategory,
  ExpenseCategoryRepository,
  ExpenseDraftFields,
  ExpenseId,
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
  EDIT_FORBIDDEN,
  loadCategoryOrNotFound,
  loadExpenseOrNotFound,
  loadMembershipOrNotFound,
  snapshotOf,
  submitAboveThreshold,
  unwrap,
} from "./expense-draft.support";
import {
  resolveSplitPlan,
  type PreviewSplitConfig,
} from "./preview-split.use-case";

/**
 * Edit an expense in `draft` or `pending_approval` — Roadmap T065, PRD §3.5.
 *
 * ## The steps, in the order that decides error precedence
 *
 * ```text
 * update(command)
 *   ├─ membership                                  (authorisation subject)
 *   ├─ the stored expense                          (not_found for foreign ids)
 *   ├─ canOnResource("expense.void", snapshot)     (the 🟡 "own drafts" site)
 *   ├─ editable state?                             (invalid_transition otherwise)
 *   ├─ category, only when the patch needs it
 *   ├─ resolveSplitPlan, only when strategy/basis moved
 *   ├─ Expense.edit(...)                           (T061's input rules, one version)
 *   ├─ submitAboveThreshold(...)                   (draft → pending, full holders)
 *   └─ repository.update(..., expectedVersion)     (atomic optimistic lock)
 * ```
 *
 * The record is loaded before the resource decision — the snapshot's facts
 * (`createdBy`, whether it is still a draft) only exist on the row — but the
 * *write* is the SQL comparison, never a JS one: the update carries
 * `WHERE version = expectedVersion AND status IN ('draft','pending_approval')` and
 * a lost race answers `version_mismatch` with the row's current version.
 *
 * ## Merge semantics
 *
 * An absent field leaves the stored value alone; an explicit `null` clears a
 * nullable one. That merge happens **here**, in one place, and the repository writes
 * the whole resultant row — so there is exactly one representation of "what this
 * expense now is", and SQL never re-implements absent-versus-null.
 *
 * ## What an edit cannot do
 *
 * It cannot touch a `published` or `void` expense (that is T068's recalculation with
 * a diff preview and T069's void), cannot change `status` except through the
 * threshold rule, and cannot change `createdBy` or the tenant. It raises no domain
 * event: the catalogue has none for an edit, and T068 owns the revision row the PRD
 * asks for.
 */

/** What the route hands the use case — the contract has parsed and refined it. */
export interface UpdateExpenseCommand {
  /** The version the caller read; required, because a lock that can be omitted is not one. */
  readonly expectedVersion: number;
  readonly title?: string | undefined;
  readonly amountPaise?: number | undefined;
  readonly expenseDate?: string | undefined;
  readonly categoryId?: string | undefined;
  readonly description?: string | null | undefined;
  readonly vendorName?: string | null | undefined;
  readonly paymentSource?: PaymentSource | undefined;
  readonly paidByMemberId?: string | null | undefined;
  readonly splitStrategy?: SplitStrategy | undefined;
  readonly apartmentBasis?: ApartmentBasis | null | undefined;
  readonly splitConfig?: PreviewSplitConfig | null | undefined;
  readonly participantSelector?: unknown;
}

@Injectable()
export class UpdateExpenseUseCase {
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

  /** Applies one patch, or refuses it with the reason the caller can act on. */
  async update(
    actor: UserId,
    societyId: SocietyId,
    expenseId: ExpenseId,
    command: UpdateExpenseCommand,
  ): Promise<ExpenseRecord> {
    const membership = await loadMembershipOrNotFound(
      this.memberships,
      actor,
      societyId,
    );

    const record = await loadExpenseOrNotFound(
      this.expenses,
      actor,
      societyId,
      expenseId,
    );

    const allowed = canOnResource(
      memberSnapshotOf(membership),
      "expense.void",
      snapshotOf(record),
    );
    if (!allowed) {
      throw toAppError(expenseError("forbidden", EDIT_FORBIDDEN));
    }

    // Checked before reconstitution, not only inside `edit()`: a published row
    // cannot be rebuilt as an aggregate without its split set (T061's invariant),
    // and the honest answer to "edit a published expense" is this refusal, not an
    // invariant failure about splits the caller never sent.
    if (!isExpenseEditableStatus(record.status)) {
      throw toAppError(
        expenseError(
          "invalid_transition",
          `A ${record.status} expense cannot be edited as a draft. Only drafts and expenses awaiting approval can be edited.`,
          { from: record.status },
        ),
      );
    }

    const planTouched =
      command.splitStrategy !== undefined ||
      command.apartmentBasis !== undefined;
    const effectiveCategoryId = command.categoryId ?? record.categoryId;
    const effectiveStrategy = command.splitStrategy ?? record.splitStrategy;
    const effectiveBasis =
      command.apartmentBasis !== undefined
        ? command.apartmentBasis
        : record.apartmentBasis;

    // Only when the patch can actually reach a category default, or names a new
    // category: the common title-only edit costs no category read.
    const needsCategory =
      command.categoryId !== undefined ||
      (planTouched &&
        effectiveStrategy === "apartment" &&
        effectiveBasis === null);
    let category: ExpenseCategory | null = null;
    if (needsCategory) {
      category = await loadCategoryOrNotFound(
        this.categories,
        actor,
        societyId,
        effectiveCategoryId,
      );
    }

    const plan = planTouched
      ? await unwrap(
          resolveSplitPlan(
            {
              // `resolveSplitPlan` does not read the amount; it is passed through for
              // shape only, exactly as the preview passes its own.
              amountPaise: command.amountPaise ?? Number(record.amount.paise),
              selector: record.participantSelector,
              categoryId: effectiveCategoryId,
              splitStrategy: effectiveStrategy,
              apartmentBasis: effectiveBasis,
              splitConfig: command.splitConfig ?? undefined,
            },
            category,
          ),
        )
      : { strategy: record.splitStrategy, basis: record.apartmentBasis };

    let selector = record.participantSelector;
    if (command.participantSelector !== undefined) {
      selector = await unwrap(
        createParticipantSelector(command.participantSelector ?? {}),
      );
    }

    const entity = await unwrap(
      Expense.reconstitute({
        id: record.id,
        societyId: record.societyId,
        categoryId: record.categoryId,
        title: record.title,
        amount: record.amount,
        expenseDate: record.expenseDate,
        createdBy: record.createdBy,
        status: record.status,
        // Editable states carry no splits (they exist only on a published row), so
        // the empty set is the row's own truth rather than a placeholder.
        splits: [],
        publishedAt: record.publishedAt,
        voidedAt: record.voidedAt,
        voidedBy: record.voidedBy,
        voidReason: record.voidReason,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        version: record.version,
      }),
    );

    await unwrap(
      entity.edit(
        {
          title: command.title,
          amount:
            command.amountPaise === undefined
              ? undefined
              : Money.fromPaise(paise(command.amountPaise)),
          expenseDate: command.expenseDate,
          categoryId:
            command.categoryId === undefined
              ? undefined
              : asExpenseCategoryId(command.categoryId),
        },
        this.clock,
      ),
    );

    await submitAboveThreshold(
      entity,
      membership,
      actor,
      societyId,
      this.policies,
      this.clock,
    );

    const fields: ExpenseDraftFields = {
      description:
        command.description !== undefined
          ? command.description
          : record.description,
      vendorName:
        command.vendorName !== undefined
          ? command.vendorName
          : record.vendorName,
      paymentSource: command.paymentSource ?? record.paymentSource,
      paidByMemberId:
        command.paidByMemberId === undefined
          ? record.paidByMemberId
          : command.paidByMemberId === null
            ? null
            : asMemberId(command.paidByMemberId),
      splitStrategy: plan.strategy,
      apartmentBasis: plan.basis,
      splitConfig:
        command.splitConfig !== undefined
          ? (command.splitConfig ?? {})
          : record.splitConfig,
      participantSelector: selector,
    };

    try {
      return await this.expenses.update(
        record.id,
        societyId,
        command.expectedVersion,
        { expense: entity, fields },
        actor,
      );
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }
  }
}
