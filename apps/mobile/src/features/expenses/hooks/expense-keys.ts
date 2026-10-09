import type { ExpenseListQuery } from '../repository/expense.repository';

/**
 * React Query key factory for expenses (T073).
 *
 * Every key carries **both** the society and the signed-in user, for the reason
 * `member-keys.ts` records: the society is what the data belongs to and the user is who may
 * read it, so a cached reply can never be served to the wrong tenant or the wrong session —
 * the client-side mirror of `SocietyGuard` and RLS (SAD §1.1). Switching the active society
 * therefore changes the key and React Query cannot serve the previous society's ledger.
 *
 * ## The filters are part of the key, and are canonicalised first
 *
 * Two filtered pages are two different answers, so a key that ignored the filters would show
 * `status=published` rows under a `status=draft` chip. The filters go through
 * `serializeExpenseFilters` rather than being dropped into the key as an object, so a screen
 * that rebuilds an identical filter object on every render still hits the same entry — React
 * Query hashes an object by contents, and a canonical string makes that explicit rather than
 * incidental.
 */
export function serializeExpenseFilters(query: ExpenseListQuery): string {
  const parts: string[] = [];
  const push = (key: string, value: string | number | undefined): void => {
    if (value === undefined || value === '') return;
    parts.push(`${key}=${String(value)}`);
  };

  push('categoryId', query.categoryId);
  push('status', query.status);
  push('dateFrom', query.dateFrom);
  push('dateTo', query.dateTo);
  push('amountPaiseMin', query.amountPaiseMin);
  push('amountPaiseMax', query.amountPaiseMax);
  push('buildingId', query.buildingId);
  push('createdBy', query.createdBy);
  push('q', query.q);
  push('limit', query.limit);

  return parts.join('&');
}

export const expenseKeys = {
  all: ['expense'] as const,
  /** The infinite list, keyed by society, user and the canonicalised filters. */
  list: (societyId: string | null, userId: string | null, query: ExpenseListQuery) =>
    ['expense', 'list', societyId, userId, serializeExpenseFilters(query)] as const,
  detail: (expenseId: string | null, societyId: string | null, userId: string | null) =>
    ['expense', 'detail', societyId, expenseId, userId] as const,
  splits: (expenseId: string | null, societyId: string | null, userId: string | null) =>
    ['expense', 'splits', societyId, expenseId, userId] as const,
  revisions: (expenseId: string | null, societyId: string | null, userId: string | null) =>
    ['expense', 'revisions', societyId, expenseId, userId] as const,
  comments: (expenseId: string | null, societyId: string | null, userId: string | null) =>
    ['expense', 'comments', societyId, expenseId, userId] as const,
  attachments: (expenseId: string | null, societyId: string | null, userId: string | null) =>
    ['expense', 'attachments', societyId, expenseId, userId] as const,
  /** The category `id → name` map the list and detail resolve a category label from. */
  categoryNames: (societyId: string | null, userId: string | null) =>
    ['expense', 'category-names', societyId, userId] as const,
  /** The society's buildings, for the building filter's options. */
  buildingOptions: (societyId: string | null, userId: string | null) =>
    ['expense', 'building-options', societyId, userId] as const,
  /**
   * The society's **active** categories, for the form's picker (T074).
   *
   * A separate key from `categoryNames` rather than the same read twice: the map the list and
   * detail resolve labels from is not the choice list a form offers, and a form must not show a
   * deactivated category that a historical row still needs to name.
   */
  categoryOptions: (societyId: string | null, userId: string | null) =>
    ['expense', 'category-options', societyId, userId] as const,
  /** The society's billable members, for the form's payer picker (T074). */
  payerOptions: (societyId: string | null, userId: string | null) =>
    ['expense', 'payer-options', societyId, userId] as const,
  /**
   * One `preview-split` answer (T075), keyed by a canonical string of the request.
   *
   * `requestKey` is the caller's own canonicalisation of the request — the configurator
   * builds it from the amount, strategy, basis, config and selector, so two requests
   * that mean the same thing hit one cache entry and a changed strategy is a new one.
   * The society and user are in the key for the same reason every other key carries
   * them: a cached split must never be served to the wrong tenant or session.
   */
  splitPreview: (societyId: string | null, userId: string | null, requestKey: string) =>
    ['expense', 'split-preview', societyId, userId, requestKey] as const,
};
