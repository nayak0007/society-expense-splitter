import type { ExpenseMonthGroup } from '../hooks/use-expenses';
import type { ExpenseSummary } from '../repository/expense.repository';

/**
 * The flattened row list a `FlashList` renders, built from the month groups.
 *
 * Kept in its own module (no React, no FlashList import) so it can be unit-tested directly and
 * so the screen file stays a composition. `FlashList` takes a flat `data` array, so a month
 * group becomes a header row followed by that month's expense rows; `key` is stable and unique
 * per row, which is what lets the list recycle without re-mounting a row that did not change.
 */
export type ExpenseListRow =
  | {
      readonly kind: 'month';
      readonly key: string;
      readonly label: string;
      readonly totalPaise: number;
      readonly count: number;
    }
  | { readonly kind: 'expense'; readonly key: string; readonly expense: ExpenseSummary };

export function toRows(groups: readonly ExpenseMonthGroup[]): ExpenseListRow[] {
  const rows: ExpenseListRow[] = [];
  for (const group of groups) {
    rows.push({
      kind: 'month',
      key: `month:${group.key}`,
      label: group.label,
      totalPaise: group.totalPaise,
      count: group.expenses.length,
    });
    for (const expense of group.expenses) {
      rows.push({ kind: 'expense', key: `expense:${expense.id}`, expense });
    }
  }
  return rows;
}
