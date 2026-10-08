import { Ionicons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorScreen } from '@/components/ui/ErrorScreen';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';

import { ExpenseCard } from '../components/ExpenseCard';
import {
  EMPTY_EXPENSE_FILTERS,
  ExpenseFilters,
  hasActiveFilters,
  toExpenseListQuery,
} from '../components/ExpenseFilters';
import type { ExpenseFilterState } from '../components/ExpenseFilters';
import {
  useExpenseBuildingOptions,
  useExpenseCategoryNames,
  useExpenses,
} from '../hooks/use-expenses';
import type { ExpenseSummary } from '../repository/expense.repository';
import { formatPaise } from '../schemas/expense.schemas';
import { expenseErrorMessage } from '../services/expense.service';

import { toRows } from './expense-list-rows';

/**
 * The expense ledger (PRD §3.5.3, Roadmap T073).
 *
 * ## Why `FlashList`
 *
 * The acceptance target is 60 fps over 1 000 expenses, and `ScrollView`/`map` renders all of
 * them. `FlashList` recycles views, so only the visible window is mounted. The installed major
 * is **v2**, which auto-measures items and — unlike v1 — does **not** require or accept
 * `estimatedItemSize`; sizing is measured, so there is no estimate to tune (see
 * `docs/` note in the milestone report). `getItemType` is supplied so a month header and an
 * expense row are recycled as distinct types rather than reshaped from one another.
 *
 * ## Server-side pagination, month headers as rows
 *
 * The cursor stream comes from `useExpenses` (`GET /expenses?cursor=…`); the month grouping is
 * applied to the **deduplicated** pages, and the groups are flattened into a single row list
 * because `FlashList` takes a flat `data` array. Duplicates across a page boundary are dropped
 * in one place (`groupExpensesByMonth`), so a row cannot be rendered twice.
 *
 * ## The screen decides; the panel renders
 *
 * Filters are held here — debounced search, chip state — and the panel is a controlled view. A
 * change resets pagination implicitly, because the query key includes the canonicalised filters
 * and React Query starts a fresh stream for a new key. Switching the active society does the
 * same by changing the key, which is the cache-invalidation-on-switch requirement.
 */
export default function ExpenseListScreen() {
  const router = useRouter();
  const [filters, setFilters] = useState<ExpenseFilterState>(EMPTY_EXPENSE_FILTERS);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  // One beat behind the keyboard, so a request is sent only when typing pauses.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(filters.q), 300);
    return () => clearTimeout(timer);
  }, [filters.q]);

  const query = useMemo(
    () => ({ ...toExpenseListQuery({ ...filters, q: debouncedQuery }), limit: 25 }),
    [filters, debouncedQuery],
  );

  const { groups, isLoading, isRefreshing, isLoadingMore, error, refetch, loadMore } =
    useExpenses(query);
  const { names } = useExpenseCategoryNames();
  const { buildings } = useExpenseBuildingOptions();

  const rows = useMemo(() => toRows(groups), [groups]);
  const buildingOptions = useMemo(
    () => buildings.map((building) => ({ id: building.id, name: building.name })),
    [buildings],
  );
  const categoryOptions = useMemo(() => Array.from(names, ([id, name]) => ({ id, name })), [names]);

  if (isLoading) {
    return <LoadingIndicator message="Loading expenses…" />;
  }

  // Only when there is nothing to show: a failed refetch over cached rows keeps the rows.
  if (error != null && groups.length === 0) {
    return (
      <ErrorScreen
        title="Could not load expenses"
        description={expenseErrorMessage(error)}
        onRetry={refetch}
      />
    );
  }

  const openExpense = (expense: ExpenseSummary): void =>
    router.push({ pathname: '/(app)/expenses/[id]', params: { id: expense.id } });

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ title: 'Expenses' }} />

      <View className="gap-3 px-lg pt-md">
        <Button variant="tonal" onPress={() => setShowFilters((current) => !current)}>
          {showFilters || hasActiveFilters(filters) ? 'Hide filters' : 'Filter expenses'}
        </Button>
        {showFilters ? (
          <ExpenseFilters
            values={filters}
            onChange={setFilters}
            categoryOptions={categoryOptions}
            buildingOptions={buildingOptions}
          />
        ) : null}
      </View>

      <FlashList
        data={rows}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.kind}
        renderItem={({ item }) =>
          item.kind === 'month' ? (
            <MonthHeader label={item.label} totalPaise={item.totalPaise} count={item.count} />
          ) : (
            <View className="px-lg pb-3">
              <ExpenseCard
                expense={item.expense}
                categoryName={names.get(item.expense.categoryId) ?? null}
                onPress={() => openExpense(item.expense)}
              />
            </View>
          )
        }
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        refreshing={isRefreshing}
        onRefresh={refetch}
        ListEmptyComponent={
          <EmptyState
            icon={<Ionicons name="receipt-outline" size={48} />}
            title={hasActiveFilters(filters) ? 'No expenses match' : 'No expenses yet'}
            description={
              hasActiveFilters(filters)
                ? 'Try a different filter, or clear them to see the whole ledger.'
                : 'Expenses recorded in this society will appear here, newest first.'
            }
          />
        }
        ListFooterComponent={
          isLoadingMore ? (
            <Text variant="bodySmall" color="outline" align="center">
              Loading more…
            </Text>
          ) : null
        }
        contentContainerStyle={{ paddingBottom: 24 }}
      />
    </View>
  );
}

/** A month section header — the label plus the month's summed total (integer paise). */
function MonthHeader({
  label,
  totalPaise,
  count,
}: {
  readonly label: string;
  readonly totalPaise: number;
  readonly count: number;
}) {
  return (
    <View className="flex-row items-baseline justify-between px-lg pb-2 pt-4">
      <Text variant="titleSmall">{label}</Text>
      <Text variant="bodySmall" color="onSurfaceVariant">
        {`${String(count)} · ${formatPaise(totalPaise)}`}
      </Text>
    </View>
  );
}
