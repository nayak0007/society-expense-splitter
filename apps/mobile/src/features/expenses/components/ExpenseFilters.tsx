import { View } from 'react-native';

import { ChoiceChips } from '@/components/forms/ChoiceChips';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/TextInput';
import type { ExpenseStatus } from '@ses/domain';

import type { ExpenseListQuery } from '../repository/expense.repository';
import { EXPENSE_STATUS_LABELS } from '../schemas/expense.schemas';

/**
 * The expense list's filter panel (SAD §7.5's named filters, PRD §3.5.3).
 *
 * ## The panel is controlled, and the screen owns the value
 *
 * All state lives in the screen (`ExpenseListScreen`), which debounces the search and resets
 * the cursor on a change. The panel is a pure view: it renders the current `values` and calls
 * `onChange` with a whole new object, so the screen has one place to decide what a change
 * means — exactly the shape the member directory uses.
 *
 * ## Server-side filters, never a local `filter()`
 *
 * Every field here maps to a parameter of `GET /expenses` (see `toExpenseListQuery`); none of
 * it filters a local array. A local filter would be wrong the moment a society has more
 * expenses than one page — and it would get the pagination wrong too, because the cursor is
 * computed over the *filtered* set the server holds, not the page the client happens to have.
 *
 * ## Free-text bounds are conservative on purpose
 *
 * The date and amount fields are plain text on this milestone rather than a date/amount
 * picker: a value that does not parse is **omitted** rather than sent as garbage, so a
 * half-typed `2026-1` simply does not narrow anything until it is a complete `YYYY-MM-DD`.
 * The API validates the same bounds again, so the worst a malformed value can do is nothing.
 */
export interface ExpenseFilterState {
  readonly q: string;
  readonly status: ExpenseStatus | 'all';
  readonly categoryId: string | null;
  readonly buildingId: string | null;
  readonly dateFrom: string;
  readonly dateTo: string;
  readonly amountMin: string;
  readonly amountMax: string;
}

export const EMPTY_EXPENSE_FILTERS: ExpenseFilterState = {
  q: '',
  status: 'all',
  categoryId: null,
  buildingId: null,
  dateFrom: '',
  dateTo: '',
  amountMin: '',
  amountMax: '',
};

const STATUS_OPTIONS: readonly { readonly value: ExpenseStatus | 'all'; readonly label: string }[] =
  [
    { value: 'all', label: 'All' },
    { value: 'draft', label: EXPENSE_STATUS_LABELS.draft },
    { value: 'pending_approval', label: EXPENSE_STATUS_LABELS.pending_approval },
    { value: 'published', label: EXPENSE_STATUS_LABELS.published },
    { value: 'void', label: EXPENSE_STATUS_LABELS.void },
  ];

/** True when any filter other than the search term is set — drives the "Clear" affordance. */
export function hasActiveFilters(filters: ExpenseFilterState): boolean {
  return (
    filters.q.trim().length > 0 ||
    filters.status !== 'all' ||
    filters.categoryId !== null ||
    filters.buildingId !== null ||
    filters.dateFrom.trim().length > 0 ||
    filters.dateTo.trim().length > 0 ||
    filters.amountMin.trim().length > 0 ||
    filters.amountMax.trim().length > 0
  );
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A whole, non-negative paise amount from a digits-only text field, or `undefined`. */
function parsePaise(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * The panel's values → the API query.
 *
 * An incomplete or malformed value is dropped rather than sent: the contract is `.strict()`
 * and would refuse a bad date with a field error the user cannot act on from a text field.
 */
export function toExpenseListQuery(filters: ExpenseFilterState): ExpenseListQuery {
  const q = filters.q.trim();
  const dateFrom = DATE_PATTERN.test(filters.dateFrom.trim()) ? filters.dateFrom.trim() : undefined;
  const dateTo = DATE_PATTERN.test(filters.dateTo.trim()) ? filters.dateTo.trim() : undefined;

  return {
    ...(q.length === 0 ? {} : { q }),
    ...(filters.status === 'all' ? {} : { status: filters.status }),
    ...(filters.categoryId === null ? {} : { categoryId: filters.categoryId }),
    ...(filters.buildingId === null ? {} : { buildingId: filters.buildingId }),
    ...(dateFrom === undefined ? {} : { dateFrom }),
    ...(dateTo === undefined ? {} : { dateTo }),
    ...(parsePaise(filters.amountMin) === undefined
      ? {}
      : { amountPaiseMin: parsePaise(filters.amountMin) }),
    ...(parsePaise(filters.amountMax) === undefined
      ? {}
      : { amountPaiseMax: parsePaise(filters.amountMax) }),
  };
}

export interface ExpenseFiltersProps {
  readonly values: ExpenseFilterState;
  onChange: (next: ExpenseFilterState) => void;
  readonly categoryOptions: readonly { readonly id: string; readonly name: string }[];
  readonly buildingOptions: readonly { readonly id: string; readonly name: string }[];
}

export function ExpenseFilters({
  values,
  onChange,
  categoryOptions,
  buildingOptions,
}: ExpenseFiltersProps) {
  const set = (patch: Partial<ExpenseFilterState>): void => onChange({ ...values, ...patch });

  const categoryChips = [
    { value: 'all' as const, label: 'All categories' },
    ...categoryOptions.map((option) => ({ value: option.id, label: option.name })),
  ];
  const buildingChips = [
    { value: 'all' as const, label: 'All buildings' },
    ...buildingOptions.map((option) => ({ value: option.id, label: option.name })),
  ];

  return (
    <View className="gap-3">
      <TextInput
        label="Search"
        value={values.q}
        onChangeText={(q) => set({ q })}
        helperText="By title, description or vendor"
        autoCapitalize="none"
      />

      <ChoiceChips
        label="Status"
        options={STATUS_OPTIONS}
        value={values.status}
        onChange={(status) => set({ status })}
      />

      {categoryOptions.length > 0 ? (
        <ChoiceChips
          label="Category"
          options={categoryChips}
          value={values.categoryId ?? 'all'}
          onChange={(categoryId) => set({ categoryId: categoryId === 'all' ? null : categoryId })}
        />
      ) : null}

      {buildingOptions.length > 0 ? (
        <ChoiceChips
          label="Building"
          options={buildingChips}
          value={values.buildingId ?? 'all'}
          onChange={(buildingId) => set({ buildingId: buildingId === 'all' ? null : buildingId })}
        />
      ) : null}

      <View className="flex-row gap-2">
        <View className="flex-1">
          <TextInput
            label="Date from"
            value={values.dateFrom}
            onChangeText={(dateFrom) => set({ dateFrom })}
            placeholder="YYYY-MM-DD"
            autoCapitalize="none"
            keyboardType="numbers-and-punctuation"
          />
        </View>
        <View className="flex-1">
          <TextInput
            label="Date to"
            value={values.dateTo}
            onChangeText={(dateTo) => set({ dateTo })}
            placeholder="YYYY-MM-DD"
            autoCapitalize="none"
            keyboardType="numbers-and-punctuation"
          />
        </View>
      </View>

      <View className="flex-row gap-2">
        <View className="flex-1">
          <TextInput
            label="Min paise"
            value={values.amountMin}
            onChangeText={(amountMin) => set({ amountMin })}
            placeholder="e.g. 100000"
            keyboardType="number-pad"
          />
        </View>
        <View className="flex-1">
          <TextInput
            label="Max paise"
            value={values.amountMax}
            onChangeText={(amountMax) => set({ amountMax })}
            placeholder="e.g. 5000000"
            keyboardType="number-pad"
          />
        </View>
      </View>

      {hasActiveFilters(values) ? (
        <Button variant="text" onPress={() => onChange(EMPTY_EXPENSE_FILTERS)}>
          Clear filters
        </Button>
      ) : null}
    </View>
  );
}
