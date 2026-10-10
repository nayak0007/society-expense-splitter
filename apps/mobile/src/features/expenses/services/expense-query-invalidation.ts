/**
 * The attachment cache-refresh seam — Roadmap T076 (§11 "query invalidation").
 *
 * ## Why a registry rather than `useQueryClient` in the upload hook
 *
 * An upload finishes long after the gesture that started it, and the screen that must
 * refresh is often **not** the one that owns the uploader: the scanner mints the URL, the
 * detail screen underneath it renders the bill list, and a staged file is flushed by the
 * form right before it navigates away. Reaching for React Query inside every one of those
 * components would make each of them require a provider to render, which is exactly the
 * coupling the feature's component tests avoid today.
 *
 * So the app **registers** its invalidation once (in `AppProviders`, beside the query
 * client it belongs to) and the feature calls a plain function. In a test with no provider
 * the registry is empty, the call is a no-op, and nothing throws — a screen test is about
 * the screen, not about the cache.
 *
 * This is the same shape as `repository/expense.deps.ts`: one module-level seam, set where
 * the real thing exists.
 */

/** What the app registers: refresh the bill list (and anything derived) for one expense. */
export type ExpenseAttachmentsInvalidator = (expenseId: string) => void;

let invalidator: ExpenseAttachmentsInvalidator | null = null;

/** Called once by the app's provider tree, with a closure over the real query client. */
export function registerExpenseAttachmentsInvalidator(
  next: ExpenseAttachmentsInvalidator | null,
): void {
  invalidator = next;
}

/**
 * Ask the app to re-read one expense's bills.
 *
 * Silent when nothing is registered, and never throwing: an upload that completed must not
 * fail because a cache refresh could not be scheduled. The next fetch is the authority
 * either way — this only makes it happen sooner.
 */
export function invalidateExpenseAttachments(expenseId: string): void {
  invalidator?.(expenseId);
}

/** Test seam: forget the registered invalidator. */
export function resetExpenseAttachmentsInvalidator(): void {
  invalidator = null;
}
