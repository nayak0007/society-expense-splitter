/**
 * Expense service — the app's adapter over the expense repository.
 *
 * The same two responsibilities the member and structure services hold, and nothing else:
 *
 *  1. **Dependency wiring** — the repository is resolved per call through the composition
 *     root, so no hook imports the API adapter directly and a test swaps one seam.
 *  2. **Error → copy** — `expenseErrorMessage` turns a thrown failure into a sentence a
 *     screen can render, matching the other features' services.
 *
 * There is no wire-shape validation here, unlike the member service: the *repository*
 * validates every response against the shared contract, and these reads take no request body
 * that could carry a form error. The read query is assembled from plain strings and sent by
 * the adapter, which is where scope (the society header) is established.
 */

import type {
  ExpenseAttachmentDownload,
  ExpenseAttachmentView,
  ExpenseCommentView,
  ExpenseListQuery,
  ExpensePage,
  ExpenseRevisionView,
  ExpenseSplitView,
  ExpenseSummary,
} from '../repository/expense.repository';
import { getExpenseRepository } from '../repository/expense.deps';

/** One page of the active society's expenses. */
export async function loadExpenses(
  actorId: string,
  societyId: string,
  query: ExpenseListQuery,
): Promise<ExpensePage> {
  return getExpenseRepository().list(societyId, actorId, query);
}

/** One expense, or `null` when it is not available to the caller. */
export async function loadExpense(
  actorId: string,
  societyId: string,
  expenseId: string,
): Promise<ExpenseSummary | null> {
  return getExpenseRepository().findById(expenseId, societyId, actorId);
}

/** The current persisted split table — what was actually charged, never a recomputation. */
export async function loadExpenseSplits(
  actorId: string,
  societyId: string,
  expenseId: string,
): Promise<readonly ExpenseSplitView[]> {
  return getExpenseRepository().listSplits(expenseId, societyId, actorId);
}

/** The revision history, oldest first. */
export async function loadExpenseRevisions(
  actorId: string,
  societyId: string,
  expenseId: string,
): Promise<readonly ExpenseRevisionView[]> {
  return getExpenseRepository().listRevisions(expenseId, societyId, actorId);
}

/** The comment stream, oldest first. */
export async function loadExpenseComments(
  actorId: string,
  societyId: string,
  expenseId: string,
): Promise<readonly ExpenseCommentView[]> {
  return getExpenseRepository().listComments(expenseId, societyId, actorId);
}

/** The completed bills of an expense. */
export async function loadExpenseAttachments(
  actorId: string,
  societyId: string,
  expenseId: string,
): Promise<readonly ExpenseAttachmentView[]> {
  return getExpenseRepository().listAttachments(expenseId, societyId, actorId);
}

/** A short-lived, authorized download link for one bill. */
export async function requestAttachmentDownloadUrl(
  actorId: string,
  societyId: string,
  attachmentId: string,
): Promise<ExpenseAttachmentDownload> {
  return getExpenseRepository().requestDownloadUrl(attachmentId, societyId, actorId);
}

/** `id → name` for the society's expense categories, so a row can render a name. */
export async function loadExpenseCategoryNames(
  actorId: string,
  societyId: string,
): Promise<ReadonlyMap<string, string>> {
  return getExpenseRepository().listCategoryNames(societyId, actorId);
}

/** The society's buildings, for the list filter's building options. */
export async function loadBuildingOptions(
  actorId: string,
  societyId: string,
): Promise<readonly { readonly id: string; readonly name: string }[]> {
  return getExpenseRepository().listBuildingOptions(societyId, actorId);
}

/**
 * Error → copy the UI can render.
 *
 * `ApiError.message` is the API's own user-facing sentence (SAD §7.10), so it is rendered
 * verbatim; anything else is an unexpected failure and gets a safe generic line rather than a
 * raw `Error.message` that could name a table or a column.
 */
export function expenseErrorMessage(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'Something went wrong. Please try again.';
}
