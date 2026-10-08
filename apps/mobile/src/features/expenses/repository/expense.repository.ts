/**
 * The mobile expense port — Roadmap T073.
 *
 * ## Why this is a mobile-local port rather than a `@ses/domain` one
 *
 * Every money-moving rule for expenses lives in the API (`@ses/application` has no expense
 * list/detail use cases; T065–T072 are server-side). The mobile client's job here is to
 * **read** the authoritative rows and render them, so this port is a thin, read-only view of
 * the API's DTOs — it deliberately computes nothing financial. Keeping it in the app (rather
 * than adding a domain port no API adapter implements) means the seam a test swaps is small
 * and the domain stays free of concerns only the client has.
 *
 * ## Nothing is recomputed
 *
 * A split's `amountPaise` is the number the API returned, verbatim: the client never
 * re-derives a split from a selector or a percentage. The detail screen shows what was
 * charged, and the split table's total is a **sum of the rows the server sent** — a display
 * fact, not a re-pricing.
 */

import type { AttachmentScanStatus, ExpenseStatus } from '@ses/domain';

/** One expense as the list and the detail header read it. */
export interface ExpenseSummary {
  readonly id: string;
  readonly societyId: string;
  readonly categoryId: string;
  readonly title: string;
  readonly description: string | null;
  /** Integer paise, exactly as stored. */
  readonly amountPaise: number;
  /** `YYYY-MM-DD` — the stored date, not an instant. */
  readonly expenseDate: string;
  readonly vendorName: string | null;
  readonly status: ExpenseStatus;
  /** Bumped on every write; `> 1` is the "edited" signal. */
  readonly version: number;
  readonly publishedAt: string | null;
  readonly voidedAt: string | null;
  readonly voidReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One current `expense_splits` row, read verbatim from the API. */
export interface ExpenseSplitView {
  readonly id: string;
  readonly memberId: string | null;
  readonly apartmentId: string | null;
  readonly amountPaise: number;
  readonly weight: string | null;
  readonly percent: string | null;
  readonly assignedReason: string | null;
  /** The label the row was snapshotted with at publish. */
  readonly memberName: string | null;
  readonly apartmentNumber: string | null;
}

/** One `expense_revisions` row — the pre-edit version and the editor's note. */
export interface ExpenseRevisionView {
  readonly id: string;
  /** The version that existed **before** the edit that produced V+1. */
  readonly version: number;
  readonly changedBy: string;
  readonly changeNote: string | null;
  readonly createdAt: string;
}

/** One comment in the flat stream; a soft-deleted row keeps its place with a null body. */
export interface ExpenseCommentView {
  readonly id: string;
  readonly authorId: string;
  readonly body: string | null;
  readonly deleted: boolean;
  readonly createdAt: string;
}

/** One completed bill of an expense. */
export interface ExpenseAttachmentView {
  readonly id: string;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly scanStatus: AttachmentScanStatus;
  readonly completedAt: string | null;
}

/** A short-lived authorized download link, plus the row's own metadata. */
export interface ExpenseAttachmentDownload {
  readonly url: string;
  readonly expiresAt: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly scanStatus: AttachmentScanStatus;
}

/** One page of the society's expenses plus the cursor for the next page. */
export interface ExpensePage {
  readonly expenses: readonly ExpenseSummary[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * The filters the API's `GET /expenses` accepts (SAD §7.5).
 *
 * Plain strings, not branded ids: a route parameter or a text field yields a `string`, and
 * the adapter is where scope is established. `undefined` means "no filter" and is omitted
 * rather than sent empty — the contract is `.strict()`, so `status=` would be refused.
 */
export interface ExpenseListQuery {
  readonly categoryId?: string | undefined;
  readonly status?: ExpenseStatus | undefined;
  readonly dateFrom?: string | undefined;
  readonly dateTo?: string | undefined;
  readonly amountPaiseMin?: number | undefined;
  readonly amountPaiseMax?: number | undefined;
  readonly buildingId?: string | undefined;
  readonly createdBy?: string | undefined;
  readonly q?: string | undefined;
  /** Base64 of `{ expenseDate, id }` — the opaque cursor. */
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

/** The read-only expense port the mobile feature consumes. */
export interface ExpenseRepository {
  list(societyId: string, actor: string, query: ExpenseListQuery): Promise<ExpensePage>;
  /** `null` for an expense the caller may not see — a cross-society id is a 404, folded here. */
  findById(id: string, societyId: string, actor: string): Promise<ExpenseSummary | null>;
  listSplits(
    expenseId: string,
    societyId: string,
    actor: string,
  ): Promise<readonly ExpenseSplitView[]>;
  listRevisions(
    expenseId: string,
    societyId: string,
    actor: string,
  ): Promise<readonly ExpenseRevisionView[]>;
  listComments(
    expenseId: string,
    societyId: string,
    actor: string,
  ): Promise<readonly ExpenseCommentView[]>;
  listAttachments(
    expenseId: string,
    societyId: string,
    actor: string,
  ): Promise<readonly ExpenseAttachmentView[]>;
  requestDownloadUrl(
    attachmentId: string,
    societyId: string,
    actor: string,
  ): Promise<ExpenseAttachmentDownload>;
  /** `id → name` for the society's categories, so a row can render a category name. */
  listCategoryNames(societyId: string, actor: string): Promise<ReadonlyMap<string, string>>;
  /**
   * The society's live buildings, for the building filter's options.
   *
   * Read through the expenses feature rather than by importing the structure feature's hook:
   * the linter forbids cross-feature imports, and a filter's option list is a read the filter
   * genuinely owns. Only the `id` and `name` are kept — the filter has no use for a building's
   * floors or counts.
   */
  listBuildingOptions(
    societyId: string,
    actor: string,
  ): Promise<readonly { readonly id: string; readonly name: string }[]>;
}
