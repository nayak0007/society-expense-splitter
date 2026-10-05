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
  ExpenseRecalculation,
  ExpenseRecord,
  ExpenseRepository,
  PaymentSource,
  SocietyId,
  SocietyMembership,
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
import { RecalculateExpenseUseCase } from "./recalculate-expense.use-case";

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
  /** T068's operator note; present only on a published revision. */
  readonly changeNote?: string | undefined;
}

/**
 * The two answers one `PATCH` can produce.
 *
 * A draft or pending edit answers the row it wrote and `recalculation: null`; a
 * published edit answers the row this revision wrote **plus** the diff the database
 * measured over the rows that committed (T068, ADR-0009). The controller branches on
 * that field, which is the only place the two response shapes differ — the expense
 * itself is the same DTO on both paths.
 */
export interface UpdateExpenseOutcome {
  readonly expense: ExpenseRecord;
  /** Present exactly when a published expense was revised. */
  readonly recalculation: ExpenseRecalculation | null;
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
    private readonly recalculateExpense: RecalculateExpenseUseCase,
  ) {}

  /**
   * Applies one patch, or refuses it with the reason the caller can act on.
   *
   * ## The dispatch, and why it is here rather than in the controller
   *
   * `PATCH /expenses/:expenseId` addresses one row whose door depends on its status,
   * and only the loaded row knows which door that is. A published expense is revised
   * — T068's recalculation, which re-resolves, re-prices, re-writes the dues and
   * records a revision — while a draft or pending row is edited as before (T065).
   * Deciding it in the controller would mean loading the expense there, or routing on
   * something the caller supplied; deciding it here costs the single load both paths
   * already need.
   *
   * ## The published path refuses the fields it cannot change
   *
   * `expenseDate`, `categoryId`, `paymentSource` and `paidByMemberId` are legal on a
   * draft and **immutable after publication** (`categoryId` because a category edit
   * must not silently re-route a live bill; the rest for the reasons ADR-0009 §4
   * records). They are refused by name with a `validation` error, never dropped: a
   * client that sends one has a bug, and answering "saved" for a change that was not
   * made is the worst possible answer. A `changeNote` on a *draft* edit is refused
   * for the mirror-image reason — there is no revision row for it to annotate, and
   * silently discarding an operator's note loses information.
   */
  async update(
    actor: UserId,
    societyId: SocietyId,
    expenseId: ExpenseId,
    command: UpdateExpenseCommand,
  ): Promise<UpdateExpenseOutcome> {
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

    if (record.status === "published") {
      assertPublishedEditAllowed(command);
      const recalculation = await this.recalculateExpense.recalculate(
        actor,
        societyId,
        expenseId,
        {
          expectedVersion: command.expectedVersion,
          title: command.title,
          description: command.description,
          vendorName: command.vendorName,
          amountPaise: command.amountPaise,
          splitStrategy: command.splitStrategy,
          apartmentBasis: command.apartmentBasis,
          splitConfig: command.splitConfig,
          participantSelector: command.participantSelector,
          changeNote: command.changeNote ?? null,
        },
      );
      return { expense: recalculation.expense, recalculation };
    }

    if (!isExpenseEditableStatus(record.status)) {
      throw toAppError(
        expenseError(
          "invalid_transition",
          `A ${record.status} expense cannot be edited as a draft. Only drafts and expenses awaiting approval can be edited.`,
          { from: record.status },
        ),
      );
    }

    const expense = await this.updateEditable(
      actor,
      societyId,
      record,
      membership,
      command,
    );
    return { expense, recalculation: null };
  }

  /** T065's draft/pending edit, unchanged — the record and membership are pre-loaded. */
  private async updateEditable(
    actor: UserId,
    societyId: SocietyId,
    record: ExpenseRecord,
    membership: SocietyMembership,
    command: UpdateExpenseCommand,
  ): Promise<ExpenseRecord> {
    if (command.changeNote !== undefined) {
      throw toAppError(
        expenseError(
          "validation",
          "A change note accompanies a published revision; a draft edit has no revision to annotate.",
          { field: "changeNote" },
        ),
      );
    }

    const allowed = canOnResource(
      memberSnapshotOf(membership),
      "expense.void",
      snapshotOf(record),
    );
    if (!allowed) {
      throw toAppError(expenseError("forbidden", EDIT_FORBIDDEN));
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

/**
 * The fields a published edit may not carry, in one list, so the refusal cannot
 * drift from the port's `ExpenseRecalculationFields` allow-list.
 *
 * The wire name travels with the column so the `validation` error names the input a
 * form has to highlight (`categoryId`), which is the module's own convention.
 */
const IMMUTABLE_AFTER_PUBLICATION: readonly (readonly [
  keyof UpdateExpenseCommand,
  string,
])[] = [
  ["expenseDate", "expenseDate"],
  ["categoryId", "categoryId"],
  ["paymentSource", "paymentSource"],
  ["paidByMemberId", "paidByMemberId"],
];

/**
 * Refuses a published patch that names a field the revision cannot change.
 *
 * A **field error per offending field** would need the error vocabulary to carry a
 * list; the module's shape is one field per refusal, so the first offending field in
 * the list's own order is reported. That is deliberate: a form fixes one input at a
 * time, and the client's next request surfaces the next refusal if it sent several —
 * rather than a single message naming four boxes the client has to parse.
 *
 * `paidByMemberId` and `paymentSource` are refused although T068 could leave them
 * alone: they are immutable because a revision must not restate who paid (the money
 * already moved), and accepting-and-ignoring is exactly the silent no-op the product
 * owner ruled out.
 */
function assertPublishedEditAllowed(command: UpdateExpenseCommand): void {
  const offending = IMMUTABLE_AFTER_PUBLICATION.find(
    ([key]) => command[key] !== undefined,
  );
  if (offending === undefined) return;

  const [key, field] = offending;
  throw toAppError(
    expenseError(
      "validation",
      `A published expense cannot change ${key}: the date, the category and who paid are fixed once the bill is published. Revise the title, description, vendor, amount, split configuration or participants instead.`,
      { field },
    ),
  );
}
