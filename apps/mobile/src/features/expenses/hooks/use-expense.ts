import { useQuery } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';

import type {
  ExpenseAttachmentView,
  ExpenseCommentView,
  ExpenseRevisionView,
  ExpenseSplitView,
  ExpenseSummary,
} from '../repository/expense.repository';
import {
  loadExpense,
  loadExpenseAttachments,
  loadExpenseComments,
  loadExpenseRevisions,
  loadExpenseSplits,
  requestAttachmentDownloadUrl,
} from '../services/expense.service';

import { expenseKeys } from './expense-keys';

/**
 * One expense's read surface — Roadmap T073, PRD §3.5.3.
 *
 * The detail screen is composed of five server reads that share a scope but not a shape: the
 * expense header, its current splits, its revision history, its comment stream and its
 * completed bills. They are separate queries rather than one aggregate endpoint because each
 * is its own route already (T068/T072/T073) and a caller that only needs the chip does not
 * need the split table.
 *
 * ## The tenant stays out of the navigation
 *
 * Every key is scoped by the **active society from the store**, never the route parameter.
 * The route's `id` is the only thing taken from the URL; if a caller forged another tenant's
 * expense id the API answers `404` under RLS, and the hook renders "not available" — the
 * client never decides the tenant.
 */
export interface ExpenseDetailResult {
  readonly expense: ExpenseSummary | null;
  readonly isLoading: boolean;
  readonly error: unknown;
  refetch: () => void;
}

/** The expense header — the one read the whole screen depends on. */
export function useExpense(expenseId: string | null): ExpenseDetailResult {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: expenseKeys.detail(expenseId, societyId, userId),
    queryFn: () => loadExpense(userId ?? '', societyId ?? '', expenseId ?? ''),
    enabled: userId !== null && societyId !== null && expenseId !== null,
  });

  return {
    expense: query.data ?? null,
    isLoading: query.isPending && expenseId !== null,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}

/** The current split table — persisted rows, never a recomputation. */
export function useExpenseSplits(expenseId: string | null): {
  readonly splits: readonly ExpenseSplitView[];
  readonly isLoading: boolean;
  readonly error: unknown;
} {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: expenseKeys.splits(expenseId, societyId, userId),
    queryFn: () => loadExpenseSplits(userId ?? '', societyId ?? '', expenseId ?? ''),
    enabled: userId !== null && societyId !== null && expenseId !== null,
  });

  return {
    splits: query.data ?? [],
    isLoading: query.isPending && expenseId !== null,
    error: query.error,
  };
}

/** The revision history, oldest first — what the revision chip opens. */
export function useExpenseRevisions(expenseId: string | null): {
  readonly revisions: readonly ExpenseRevisionView[];
  readonly isLoading: boolean;
  readonly error: unknown;
} {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: expenseKeys.revisions(expenseId, societyId, userId),
    queryFn: () => loadExpenseRevisions(userId ?? '', societyId ?? '', expenseId ?? ''),
    enabled: userId !== null && societyId !== null && expenseId !== null,
  });

  return {
    revisions: query.data ?? [],
    isLoading: query.isPending && expenseId !== null,
    error: query.error,
  };
}

/** The comment stream, oldest first. */
export function useExpenseComments(expenseId: string | null): {
  readonly comments: readonly ExpenseCommentView[];
  readonly isLoading: boolean;
  readonly error: unknown;
} {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: expenseKeys.comments(expenseId, societyId, userId),
    queryFn: () => loadExpenseComments(userId ?? '', societyId ?? '', expenseId ?? ''),
    enabled: userId !== null && societyId !== null && expenseId !== null,
  });

  return {
    comments: query.data ?? [],
    isLoading: query.isPending && expenseId !== null,
    error: query.error,
  };
}

/** The completed bills of the expense. */
export function useExpenseAttachments(expenseId: string | null): {
  readonly attachments: readonly ExpenseAttachmentView[];
  readonly isLoading: boolean;
  readonly error: unknown;
} {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: expenseKeys.attachments(expenseId, societyId, userId),
    queryFn: () => loadExpenseAttachments(userId ?? '', societyId ?? '', expenseId ?? ''),
    enabled: userId !== null && societyId !== null && expenseId !== null,
  });

  return {
    attachments: query.data ?? [],
    isLoading: query.isPending && expenseId !== null,
    error: query.error,
  };
}

/**
 * Mint a download link for one bill, on demand.
 *
 * Deliberately **not** a query: a presigned URL is a short-lived credential, and prefetching
 * or caching one would hold a grant in memory past its usefulness. The screen requests it when
 * the user taps a bill, which is also when the "unscanned" caveat is shown.
 */
export async function fetchAttachmentDownloadUrl(attachmentId: string): Promise<string> {
  const societyId = useSocietyStore.getState().activeSocietyId;
  const userId = useAuthStore.getState().user?.id ?? '';
  const download = await requestAttachmentDownloadUrl(userId, societyId ?? '', attachmentId);
  return download.url;
}
