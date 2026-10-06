import {
  asExpenseCategoryId,
  asExpenseError,
  asExpenseId,
  asMemberId,
  expenseError,
  isExpenseEditableStatus,
  paise,
} from "@ses/domain";
import type {
  Clock,
  Expense,
  ExpenseApprovalPolicy,
  ExpenseApprovalPolicyReader,
  ExpenseCategory,
  ExpenseCategoryRepository,
  ExpenseCursor,
  ExpenseError,
  ExpenseId,
  ExpenseListQuery,
  ExpenseMembershipReader,
  ExpenseRecord,
  ExpenseRepository,
  ExpenseResourceSnapshot,
  ExpenseStatus,
  Result,
  SocietyId,
  SocietyMembership,
  UserId,
} from "@ses/domain";
import { z } from "zod";

import { toAppError } from "../expense-category-error.mapper";

/**
 * The pieces every T065 use case repeats — the loaders, the resource snapshot, the
 * threshold rule and the `Result` seam — in one place, so five files cannot drift.
 *
 * This module is a support file beside the five use cases the Roadmap names, and it
 * is deliberately *not* a sixth use case: nothing here orchestrates. Each function is
 * one rule with one owner, and the rule is stated here once rather than five times.
 */

/** No membership and a removed one are one answer — PRD T041's 404-not-403. */
export const EXPENSE_NOT_FOUND = "That expense is not available to you.";

/** The refusal a caller reads when `canOnResource` says no to a create. */
export const CREATE_FORBIDDEN =
  "Only a society Admin, Treasurer or Committee Member can add an expense.";

/** The refusal a caller reads when narrowing says no to an edit. */
export const EDIT_FORBIDDEN =
  "Only a society Admin or Treasurer — or the Committee Member who created a draft — can edit this expense.";

/** PRD §3.5: drafts are hard-deletable **by their creator**. */
export const DELETE_FORBIDDEN =
  "Only the member who created a draft can delete it.";

/**
 * The caller's membership, or `not_found`.
 *
 * The same rule the preview use case keeps: no membership and a removed membership
 * are one answer (a distinguishable one would let a caller prove another tenant's
 * society exists), and a `pending` membership is left for the resource decision to
 * refuse — its grant is a grant on a membership the society has not admitted.
 */
export async function loadMembershipOrNotFound(
  memberships: ExpenseMembershipReader,
  actor: UserId,
  societyId: SocietyId,
): Promise<SocietyMembership> {
  let membership: SocietyMembership | null;
  try {
    membership = await memberships.findMembership(societyId, actor);
  } catch (error: unknown) {
    throw toAppError(asExpenseError(error));
  }

  if (membership === null || membership.status === "removed") {
    throw toAppError(
      expenseError("not_found", "That society is not available to you."),
    );
  }
  return membership;
}

/** One expense of the caller's society, or `not_found`. */
export async function loadExpenseOrNotFound(
  expenses: ExpenseRepository,
  actor: UserId,
  societyId: SocietyId,
  expenseId: ExpenseId,
): Promise<ExpenseRecord> {
  let record: ExpenseRecord | null;
  try {
    record = await expenses.findById(expenseId, societyId, actor);
  } catch (error: unknown) {
    throw toAppError(asExpenseError(error));
  }

  if (record === null) {
    throw toAppError(expenseError("not_found", EXPENSE_NOT_FOUND));
  }
  return record;
}

/**
 * The category an expense is filed under, or `not_found` — read through T062's own
 * `findCategory`, so a soft-deleted category and another society's are the same
 * answer an insert would meet moments later.
 *
 * An **inactive** category resolves normally, which is T062's recorded hand-off: the
 * expense form filters on `isActive` (that is the picker's rule), while a draft whose
 * category was deactivated after the fact must stay editable — refusing the save
 * would strand it.
 */
export async function loadCategoryOrNotFound(
  categories: ExpenseCategoryRepository,
  actor: UserId,
  societyId: SocietyId,
  categoryId: string,
): Promise<ExpenseCategory> {
  let category: ExpenseCategory | null;
  try {
    category = await categories.findCategory(
      asExpenseCategoryId(categoryId),
      societyId,
      actor,
    );
  } catch (error: unknown) {
    throw toAppError(asExpenseError(error));
  }

  if (category === null) {
    throw toAppError(
      expenseError("not_found", "That category is not available to you."),
    );
  }
  return category;
}

/**
 * The stored expense, reduced to the facts authorisation reads.
 *
 * `published` is `status !== "draft"` — the matrix's two states as the PRD's own
 * cells draw them, and the *stricter* reading for the 🟡 "own drafts" cell: a
 * `pending_approval` expense is not a draft, so a Committee Member's grant does not
 * cover it (the RLS update policy agrees: their branch requires `status = 'draft'`).
 * Admin and Treasurer hold `expense.void` outright, so the field never narrows them.
 */
export function snapshotOf(record: ExpenseRecord): ExpenseResourceSnapshot {
  return {
    kind: "expense",
    societyId: record.societyId,
    createdByMembershipId: record.createdBy,
    published: record.status !== "draft",
  };
}

/**
 * The society's current approval threshold in paise, or `not_found`.
 *
 * `null` is "no such society, or no live membership for this caller" — the two
 * are one answer for the reason `ExpenseApprovalPolicyReader` records, and the
 * refusal is the same `not_found` the other loaders throw.
 */
export async function readApprovalThreshold(
  policies: ExpenseApprovalPolicyReader,
  actor: UserId,
  societyId: SocietyId,
): Promise<bigint> {
  let policy: ExpenseApprovalPolicy | null;
  try {
    policy = await policies.findById(societyId, actor);
  } catch (error: unknown) {
    throw toAppError(asExpenseError(error));
  }

  if (policy === null) {
    throw toAppError(
      expenseError("not_found", "That society is not available to you."),
    );
  }

  return policy.settings.approvalThresholdPaise;
}

/**
 * Route an unpublished expense by the society's threshold — T070's submission rule
 * (ADR-0011 D3/D4 and the Committee fix).
 *
 * ## The two answers, and why both directions exist
 *
 * ```text
 *   amount >= current threshold  →  pending_approval  (an Admin must decide)
 *   amount <  current threshold  →  draft             (no approval is required)
 * ```
 *
 * Entering `pending_approval` is **not** permission to publish: approval is a full
 * Admin cell, and publication re-evaluates the amount against the *current*
 * threshold inside `expense_publish()` under the row lock (D4). Routing an expense
 * into the queue therefore grants the caller nothing they did not already have.
 *
 * ## `>=` and not `>` (D3)
 *
 * An amount **at** the threshold requires approval. The strict `>` this function
 * used before T070 was the temporary T065 reading and is superseded: 1,000,000
 * paise triggers with a 1,000,000-paise threshold.
 *
 * ## The Committee deadlock is fixed here (ADR-0011)
 *
 * The old rule required a **full** `expense.create` grant, so a Committee Member's
 * above-threshold draft was never promoted — and an `insert`/`update` policy that
 * only accepted `status = 'draft'` from their branch made promoting it impossible
 * anyway. Both are gone: the threshold alone decides, and migration #31 lets a
 * `can_draft_expenses` caller's row carry `status IN ('draft',
 * 'pending_approval')`. The narrowing that remains is the *stored* row's: a
 * submitted expense is outside their reach (their `expense.create` grant is
 * own-drafts-only, the update policy's `USING` clause still requires `draft`, and
 * `snapshotOf` reads any non-draft row as published), which is exactly the workflow
 * D1 describes — submit, then wait for an Admin to approve or reject.
 *
 * ## D8's other direction
 *
 * A `pending_approval` expense whose amount drops below the *current* threshold is
 * returned to `draft`: the approval it was waiting for is not required any more.
 * This is reached only from the two edit doors (a create is always a draft), which
 * is why it lives here rather than in the entity: the entity cannot read the
 * society's threshold.
 *
 * A promotion that is not needed returns before the settings read, so the common
 * below-threshold draft write costs no extra query.
 */
export async function routeForApproval(
  expense: Expense,
  actor: UserId,
  societyId: SocietyId,
  policies: ExpenseApprovalPolicyReader,
  clock: Clock,
): Promise<void> {
  // Published and void expenses are out of scope: their routes own them (T066's
  // publish, T068's recalculation, T069's void).
  if (!isExpenseEditableStatus(expense.status)) return;

  // The threshold is read on every routed write, because both directions matter: a
  // draft may need promotion, and a `pending_approval` row may need demotion.
  const threshold = await readApprovalThreshold(policies, actor, societyId);

  if (expense.amount.paise >= threshold) {
    if (expense.status === "draft") {
      const submitted = expense.submitForApproval(clock);
      if (!submitted.ok) throw toAppError(submitted.error);
    }
    // Already `pending_approval`: the edit already cleared the approval
    // (`Expense.edit()`, and the database's guard), so a fresh decision is
    // required and nothing else needs to move.
    return;
  }

  if (expense.status === "pending_approval") {
    const reverted = expense.revertToDraft(clock);
    if (!reverted.ok) throw toAppError(reverted.error);
  }
}

/**
 * Unwraps a `Result` — or a promise of one — into a value or a thrown `AppError`.
 *
 * The same seam the preview use case keeps, and for the same reason: the controller
 * never branches on `ok`, and a pure `Result` refusal and a repository failure reach
 * the HTTP layer in one shape.
 */
export async function unwrap<T>(
  pending: Result<T, ExpenseError> | Promise<Result<T, ExpenseError>>,
): Promise<T> {
  const result = await pending;
  if (!result.ok) {
    throw toAppError(result.error);
  }
  return result.value;
}

// ─────────────────────────────────────────────────────────────────────────────
// The list path — T065's filters, shared with T070's approval queue
// ─────────────────────────────────────────────────────────────────────────────

/** SAD §7.4: default 20, maximum 100 (the contract clamps; this is the floor). */
export const DEFAULT_EXPENSE_PAGE_SIZE = 20;
export const MAX_EXPENSE_PAGE_SIZE = 100;

/**
 * The list request, in the shape both list use cases accept.
 *
 * Structural, so the contract's parsed query (`ListExpensesQueryPayload`) satisfies
 * it without a mapping: every `undefined`-able field means "no filter", which is
 * exactly what the strict query schema produces for an absent parameter.
 */
export interface ExpenseListRequest {
  readonly categoryId?: string | undefined;
  readonly status?: ExpenseStatus | undefined;
  readonly dateFrom?: string | undefined;
  readonly dateTo?: string | undefined;
  readonly amountPaiseMin?: number | undefined;
  readonly amountPaiseMax?: number | undefined;
  readonly createdBy?: string | undefined;
  /** Full-text search over title, description and vendor. */
  readonly q?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/**
 * The request → the repository's query, with the status optionally forced.
 *
 * `forcedStatus` is how the approval queue states its one non-negotiable filter
 * (T070, ADR-0011 D7): the queue is *the* `status = pending_approval` view, so a
 * caller cannot ask it for something else — and it is the same builder the general
 * list uses, so a filter cannot mean one thing on one route and another on the other.
 *
 * The cursor is base64 of SAD §7.4's own sort tuple, decoded strictly: a malformed
 * cursor is a `validation` error naming `cursor`, not a silent "start over", which
 * would turn a client bug into duplicated rows on a screen.
 */
export function buildExpenseListQuery(
  request: ExpenseListRequest,
  forcedStatus?: ExpenseStatus,
): ExpenseListQuery {
  const status = forcedStatus ?? request.status;

  return {
    ...(request.categoryId === undefined
      ? {}
      : { categoryId: asExpenseCategoryId(request.categoryId) }),
    ...(status === undefined ? {} : { status }),
    ...(request.dateFrom === undefined ? {} : { dateFrom: request.dateFrom }),
    ...(request.dateTo === undefined ? {} : { dateTo: request.dateTo }),
    ...(request.amountPaiseMin === undefined
      ? {}
      : { amountPaiseMin: paise(request.amountPaiseMin) }),
    ...(request.amountPaiseMax === undefined
      ? {}
      : { amountPaiseMax: paise(request.amountPaiseMax) }),
    ...(request.createdBy === undefined
      ? {}
      : { createdBy: asMemberId(request.createdBy) }),
    ...(request.q === undefined ? {} : { search: request.q }),
    ...(request.cursor === undefined
      ? {}
      : { cursor: decodeExpenseCursor(request.cursor) }),
    limit: Math.min(
      request.limit ?? DEFAULT_EXPENSE_PAGE_SIZE,
      MAX_EXPENSE_PAGE_SIZE,
    ),
  };
}

/** The decoded tuple, validated as strictly as the wire that carried it. */
const cursorPayloadSchema = z.object({
  expenseDate: z.iso.date(),
  id: z.uuid(),
});

/**
 * The opaque cursor → the sort tuple, or a `validation` error naming `cursor`.
 *
 * `Buffer.from(..., "base64")` is forgiving of non-base64 input (it decodes what it
 * can and ignores the rest), which is exactly why the JSON parse and the schema
 * check follow: the pair is what makes a garbage cursor a refusal rather than a page
 * starting somewhere unintended.
 */
export function decodeExpenseCursor(cursor: string): ExpenseCursor {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
  } catch {
    throw toAppError(
      expenseError("validation", "The cursor is not valid.", {
        field: "cursor",
      }),
    );
  }

  const parsed = cursorPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw toAppError(
      expenseError("validation", "The cursor is not valid.", {
        field: "cursor",
      }),
    );
  }

  return {
    expenseDate: parsed.data.expenseDate,
    id: asExpenseId(parsed.data.id),
  };
}

/** The sort tuple → the opaque cursor. The client never constructs one. */
export function encodeExpenseCursor(cursor: ExpenseCursor): string {
  return Buffer.from(
    JSON.stringify({ expenseDate: cursor.expenseDate, id: cursor.id }),
    "utf8",
  ).toString("base64");
}

/**
 * One repository page → the wire result, with the cursor re-encoded.
 *
 * Shared by the general list and the approval queue so a page boundary cannot be
 * translated two different ways — the failure would be a queue that silently
 * re-shows its first page.
 */
export function toExpenseListResult(page: {
  readonly expenses: ExpenseListResultPage["expenses"];
  readonly nextCursor: ExpenseCursor | null;
}): ExpenseListResultPage {
  return {
    expenses: page.expenses,
    nextCursor:
      page.nextCursor === null ? null : encodeExpenseCursor(page.nextCursor),
    hasMore: page.nextCursor !== null,
  };
}

/** The page plus its wire cursor, as every expense-list route answers. */
export interface ExpenseListResultPage {
  readonly expenses: readonly ExpenseRecord[];
  /** Base64 of `{ expenseDate, id }`, or `null` on the last page. */
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}
