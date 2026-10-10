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
  CreateExpensePayload,
  PreviewSplitResponseDto,
  UpdateExpensePayload,
} from '@ses/contracts';

import type {
  AttachmentCompletion,
  AttachmentUploadRequest,
  AttachmentUploadTarget,
  ExpenseAttachmentDownload,
  ExpenseAttachmentView,
  ExpenseCategoryOption,
  ExpenseCommentView,
  ExpenseListQuery,
  ExpensePage,
  ExpensePayerOption,
  ExpenseRevisionView,
  ExpenseSplitView,
  ExpenseSummary,
  SplitPreviewRequest,
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

/** Reserve an upload and mint its presigned PUT — T071's `POST /expenses/:id/attachments`. */
export async function reserveAttachmentUpload(
  actorId: string,
  societyId: string,
  expenseId: string,
  request: AttachmentUploadRequest,
): Promise<AttachmentUploadTarget> {
  return getExpenseRepository().requestAttachmentUpload(expenseId, societyId, actorId, request);
}

/** Confirm a finished upload — T071's `POST /attachments/:id/complete`. */
export async function confirmAttachmentUpload(
  actorId: string,
  societyId: string,
  attachmentId: string,
  checksum: string,
): Promise<AttachmentCompletion> {
  return getExpenseRepository().completeAttachmentUpload(
    attachmentId,
    societyId,
    actorId,
    checksum,
  );
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

/** The society's active categories, for the form's picker. */
export async function loadCategoryOptions(
  actorId: string,
  societyId: string,
): Promise<readonly ExpenseCategoryOption[]> {
  return getExpenseRepository().listCategoryOptions(societyId, actorId);
}

/** The society's billable members, for the form's payer picker. */
export async function loadPayerOptions(
  actorId: string,
  societyId: string,
): Promise<readonly ExpensePayerOption[]> {
  return getExpenseRepository().listPayerOptions(societyId, actorId);
}

/**
 * Price a split without writing anything — `POST /expenses/preview-split` (T075).
 *
 * A read in every sense that matters: the API writes no row, and this service
 * deliberately takes no in-flight guard, because a superseded preview is a stale answer
 * to drop rather than a mutation to deduplicate. The `signal` on the request is how the
 * preview hook cancels one it no longer needs.
 */
export async function loadSplitPreview(
  actorId: string,
  societyId: string,
  request: SplitPreviewRequest,
): Promise<PreviewSplitResponseDto> {
  return getExpenseRepository().previewSplit(societyId, actorId, request);
}

/**
 * Create a draft — `POST /v1/expenses`.
 *
 * Nothing is retried here, and nothing is deduplicated: the create route carries no
 * `Idempotency-Key` (only `publish` does, T066), so a blind retry after an ambiguous timeout
 * could record the bill twice. The screen's synchronous in-flight guard is what prevents the
 * *common* duplicate — a double tap — and an ambiguous network outcome is surfaced to the user
 * instead of being retried for them.
 */
export async function createExpense(
  actorId: string,
  societyId: string,
  payload: CreateExpensePayload,
): Promise<ExpenseSummary> {
  return getExpenseRepository().create(societyId, actorId, payload);
}

/** Edit a draft or pending-approval expense — `PATCH /v1/expenses/:expenseId`. */
export async function updateExpense(
  actorId: string,
  societyId: string,
  expenseId: string,
  payload: UpdateExpensePayload,
): Promise<ExpenseSummary> {
  return getExpenseRepository().update(expenseId, societyId, actorId, payload);
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
