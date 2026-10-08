import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';

import type {
  ExpenseCategoryOption,
  ExpenseListQuery,
  ExpensePage,
  ExpensePayerOption,
  ExpenseSummary,
} from '../repository/expense.repository';
import {
  loadBuildingOptions,
  loadCategoryOptions,
  loadExpenseCategoryNames,
  loadExpenses,
  loadPayerOptions,
} from '../services/expense.service';

import { expenseKeys } from './expense-keys';
import { formatMonth, monthKey } from '../schemas/expense.schemas';

/** One month's expenses — the list's grouping unit. */
export interface ExpenseMonthGroup {
  /** `YYYY-MM`. */
  readonly key: string;
  /** `October 2026`. */
  readonly label: string;
  /** The summed integer paise of the month's rows (a display total, never a re-pricing). */
  readonly totalPaise: number;
  readonly expenses: readonly ExpenseSummary[];
}

/**
 * Flatten every loaded page, drop duplicates, and group by month — newest first.
 *
 * ## Why dedupe is not optional
 *
 * Cursor pagination is stable but not transactional: a row inserted or edited between two
 * page requests can appear in both. React Query's `FlatList`-style `data` is a plain array,
 * so a duplicate id would be both a duplicate key warning and — worse — a row counted twice
 * in the month total. Deduplicating on `id` keeps the first occurrence and preserves order.
 *
 * The grouping walks the flattened order, so the month buckets come out newest-first and the
 * rows inside each keep the server's own `(expenseDate, id)` ordering — the grouping never
 * re-sorts, because the server already did.
 */
export function groupExpensesByMonth(pages: readonly ExpensePage[]): ExpenseMonthGroup[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const bucket = new Map<string, ExpenseSummary[]>();
  const totals = new Map<string, number>();

  for (const page of pages) {
    for (const expense of page.expenses) {
      if (seen.has(expense.id)) continue;
      seen.add(expense.id);
      const key = monthKey(expense.expenseDate);
      let rows = bucket.get(key);
      if (rows === undefined) {
        rows = [];
        bucket.set(key, rows);
        order.push(key);
      }
      rows.push(expense);
      totals.set(key, (totals.get(key) ?? 0) + expense.amountPaise);
    }
  }

  return order.map((key) => ({
    key,
    label: formatMonth(key),
    totalPaise: totals.get(key) ?? 0,
    expenses: bucket.get(key) ?? [],
  }));
}

/** Flatten pages to the deduplicated row list the list keys against. */
export function flattenExpenses(pages: readonly ExpensePage[]): ExpenseSummary[] {
  return groupExpensesByMonth(pages).flatMap((group) => group.expenses);
}

export interface ExpensesResult {
  readonly expenses: readonly ExpenseSummary[];
  readonly groups: readonly ExpenseMonthGroup[];
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly isLoadingMore: boolean;
  readonly hasMore: boolean;
  readonly error: unknown;
  refetch: () => void;
  loadMore: () => void;
}

/**
 * One infinite, filtered page-stream of the active society's expenses (SAD §7.4).
 *
 * Scoped to the **active society** read from the store, never a route parameter — the same
 * rule `useMembers` records, so the society a request reads and the society it writes are one
 * value. Disabled until both a user and a society are known, because a request with no tenant
 * would be answered `400` by the guard by design.
 *
 * `staleTime` is the app's default (30 s) and the list keeps the previous data across filter
 * changes through `placeholderData`, so changing a chip refines the list rather than blanking
 * it.
 */
export function useExpenses(query: ExpenseListQuery = {}): ExpensesResult {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const list = useInfiniteQuery({
    queryKey: expenseKeys.list(societyId, userId, query),
    queryFn: ({ pageParam }) =>
      loadExpenses(userId ?? '', societyId ?? '', {
        ...query,
        ...(pageParam === null ? {} : { cursor: pageParam }),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : null),
    enabled: userId !== null && societyId !== null,
    placeholderData: (previous) => previous,
  });

  const pages = list.data?.pages ?? [];
  const groups = groupExpensesByMonth(pages);

  return {
    expenses: flattenExpenses(pages),
    groups,
    isLoading: list.isPending && societyId !== null,
    isRefreshing: list.isFetching && !list.isPending && !list.isFetchingNextPage,
    isLoadingMore: list.isFetchingNextPage,
    hasMore: list.hasNextPage,
    error: list.error,
    refetch: () => void list.refetch(),
    loadMore: () => {
      if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
    },
  };
}

/**
 * The society's category `id → name` map.
 *
 * Read from `GET /expense-categories` (the same list the category manager uses) so a row and
 * a detail screen can label a category without a second expense field. It is cached under the
 * expense namespace because that is where it is *used*; it rarely changes, so it is a plain
 * query rather than an infinite one.
 */
export function useExpenseCategoryNames(): {
  readonly names: ReadonlyMap<string, string>;
} {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: expenseKeys.categoryNames(societyId, userId),
    queryFn: () => loadExpenseCategoryNames(userId ?? '', societyId ?? ''),
    enabled: userId !== null && societyId !== null,
  });

  return { names: query.data ?? new Map<string, string>() };
}

/**
 * The society's active categories, for the form's picker (T074).
 *
 * Same shape of read as `useExpenseCategoryNames` and a different question: that one labels the
 * rows the user is looking at, this one offers the choices the user may write. A deactivated
 * category appears in neither the list nor the choices — `listCategoryOptions` filters it out at
 * the adapter, where the server's `isActive` is known.
 */
export function useExpenseCategoryOptions(): {
  readonly categories: readonly ExpenseCategoryOption[];
  readonly isLoading: boolean;
} {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: expenseKeys.categoryOptions(societyId, userId),
    queryFn: () => loadCategoryOptions(userId ?? '', societyId ?? ''),
    enabled: userId !== null && societyId !== null,
  });

  return {
    categories: query.data ?? [],
    isLoading: query.isPending && userId !== null && societyId !== null,
  };
}

/** The society's billable members, for the form's payer picker (T074). */
export function useExpensePayerOptions(): {
  readonly payers: readonly ExpensePayerOption[];
  readonly isLoading: boolean;
} {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: expenseKeys.payerOptions(societyId, userId),
    queryFn: () => loadPayerOptions(userId ?? '', societyId ?? ''),
    enabled: userId !== null && societyId !== null,
  });

  return {
    payers: query.data ?? [],
    isLoading: query.isPending && userId !== null && societyId !== null,
  };
}

/**
 * The society's buildings, for the building filter's options.
 *
 * Read inside the expenses feature rather than by importing the structure feature's hook (the
 * linter forbids cross-feature imports): the filter is what needs the options, so the read
 * belongs to it. It is the same `GET /buildings` the structure screen uses.
 */
export function useExpenseBuildingOptions(): {
  readonly buildings: readonly { readonly id: string; readonly name: string }[];
} {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: expenseKeys.buildingOptions(societyId, userId),
    queryFn: () => loadBuildingOptions(userId ?? '', societyId ?? ''),
    enabled: userId !== null && societyId !== null,
  });

  return { buildings: query.data ?? [] };
}
