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

import type {
  CreateExpensePayload,
  ParticipantSelectorPayload,
  PreviewSplitResponseDto,
  SplitConfigPayload,
  UpdateExpensePayload,
} from '@ses/contracts';
import type {
  ApartmentBasis,
  AttachmentScanStatus,
  ExpenseStatus,
  PaymentSource,
  SplitStrategy,
} from '@ses/domain';

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
  /**
   * Where the money came from (PRD §3.4) and who actually paid it.
   *
   * Added by T074: the form prefills itself from the server's row and diffs against it, so both
   * fields have to travel on the summary a screen already reads. `paidByMemberId` is nullable
   * because the column is — a draft is allowed to be incomplete.
   */
  readonly paymentSource: PaymentSource;
  readonly paidByMemberId: string | null;
  /**
   * The **membership** that created the row.
   *
   * Carried by T074 because it is one of the two facts the edit gate reads (the other is the
   * status): a Committee Member may edit their own draft and no one else's, and
   * `canOnResource('expense.void', …)` decides that from this id — not from a role guess.
   */
  readonly createdBy: string;
  readonly status: ExpenseStatus;
  /**
   * The split's four stored fields, added by T075.
   *
   * The form both hydrates the configurator from them on an edit and diffs against
   * them on save, so they travel on the summary a screen already reads — the same
   * argument `paymentSource`/`paidByMemberId` make above. `splitConfig` and
   * `participantSelector` are the contract's own parsed shapes (the response schema
   * guarantees them), never opaque objects, so the editor can read an entry without
   * re-validating a `jsonb` blob.
   */
  readonly splitStrategy: SplitStrategy;
  readonly apartmentBasis: ApartmentBasis | null;
  readonly splitConfig: SplitConfigPayload;
  readonly participantSelector: ParticipantSelectorPayload;
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

/**
 * One selectable expense category, as the form's picker needs it.
 *
 * The category's split defaults travel with it (T075 §9): `default_split_strategy` is
 * what an untouched split initializes from, and `default_apartment_basis` is the basis
 * an `apartment` strategy starts with. They are read here rather than fetched
 * separately because the category response already carries them — the form would
 * otherwise make a second call to answer a question the first one already answered.
 */
export interface ExpenseCategoryOption {
  readonly id: string;
  readonly name: string;
  readonly defaultSplitStrategy: SplitStrategy;
  readonly defaultApartmentBasis: ApartmentBasis | null;
}

/**
 * One selectable payer — who the money actually came from (PRD §3.4's `paid_by_member_id`).
 *
 * Only the fields a picker renders: a member id is not a name, and a form that showed ids would
 * be asking a treasurer to memorise uuids.
 */
export interface ExpensePayerOption {
  readonly id: string;
  readonly displayName: string;
}

/**
 * One `POST /expenses/preview-split` request, minus the parts the port fills in.
 *
 * `splitConfig` and `participantSelector` are the contract's own payload shapes, so
 * the adapter can hand them straight to `apiRequest` and the shared schema validates
 * them at the boundary — the configurator never constructs a wire body by hand.
 */
export interface SplitPreviewRequest {
  readonly amountPaise: number;
  readonly categoryId?: string | null | undefined;
  readonly splitStrategy?: SplitStrategy | undefined;
  readonly apartmentBasis?: ApartmentBasis | null | undefined;
  readonly splitConfig?: SplitConfigPayload | undefined;
  readonly participantSelector: ParticipantSelectorPayload;
  /** Aborts an in-flight preview when a newer one supersedes it (the editor's own guard). */
  readonly signal?: AbortSignal | undefined;
}

/** The expense port the mobile feature consumes — reads for the list/detail, writes for the form. */
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

  // ── writes (T074) ─────────────────────────────────────────────────────────────────────────

  /**
   * Create a draft. The server decides the state (`draft`, or `pending_approval` above the
   * society's threshold) and mints the id; nothing is published, split or charged here.
   */
  create(societyId: string, actor: string, payload: CreateExpensePayload): Promise<ExpenseSummary>;

  /**
   * Edit a draft or pending-approval expense, or recalculate a published one.
   *
   * `payload` carries `expectedVersion`; a stale value is refused by the server with
   * `409 VERSION_MISMATCH`, which the caller turns into a conflict the user resolves. This form
   * only ever reaches the first two states — a published edit is a recalculation with its own
   * response shape and its own screen (§15 of the T074 audit).
   */
  update(
    expenseId: string,
    societyId: string,
    actor: string,
    payload: UpdateExpensePayload,
  ): Promise<ExpenseSummary>;

  /**
   * The society's **active** categories, for the form's picker.
   *
   * Separate from `listCategoryNames` on purpose: the list/detail screens resolve a label from a
   * map they already hold, while a form needs an ordered set of *choices* — and a deactivated
   * category must not be offered on a new expense even though it must still label a historical
   * row (T062's `is_active`).
   */
  listCategoryOptions(societyId: string, actor: string): Promise<readonly ExpenseCategoryOption[]>;

  // ── split preview (T075) ────────────────────────────────────────────────────────────────

  /**
   * Price a split without writing anything — `POST /expenses/preview-split`.
   *
   * The response is the contract's own DTO: the preview is a pure read whose fields are
   * already the ones a screen renders (allocations, warnings, unassigned), and a second
   * view-model copy would be a mapping with nothing to add. The adapter parses the
   * envelope against `previewSplitResponseSchema`, so a shape change fails at the boundary.
   */
  previewSplit(
    societyId: string,
    actor: string,
    request: SplitPreviewRequest,
  ): Promise<PreviewSplitResponseDto>;

  /**
   * The society's billable members, for the payer picker.
   *
   * Read through this feature's own adapter rather than imported from the members feature: the
   * dependency-cruiser rule forbids a feature reaching into another's internals, and this is a
   * read the form genuinely owns (the same reasoning `listBuildingOptions` records).
   */
  listPayerOptions(societyId: string, actor: string): Promise<readonly ExpensePayerOption[]>;
}
