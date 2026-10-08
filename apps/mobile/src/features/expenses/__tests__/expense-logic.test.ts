import { makeExpense } from '../__fixtures__/expense-fixtures';
import { groupExpensesByMonth } from '../hooks/use-expenses';
import {
  formatExpenseDate,
  formatMonth,
  formatPaise,
  groupIndian,
  monthKey,
} from '../schemas/expense.schemas';
import { toRows } from '../screens/expense-list-rows';
import type { ExpensePage } from '../repository/expense.repository';

describe('formatPaise — integer paise, Indian grouping, no float', () => {
  it('formats whole rupees with two decimals', () => {
    expect(formatPaise(4_500_000)).toBe('₹45,000.00');
  });

  it('groups by the Indian convention (last three, then pairs)', () => {
    expect(formatPaise(12_345_678)).toBe('₹1,23,456.78');
    expect(formatPaise(1_000_000_000)).toBe('₹1,00,00,000.00');
  });

  it('pads the paise remainder and handles zero', () => {
    expect(formatPaise(0)).toBe('₹0.00');
    expect(formatPaise(5)).toBe('₹0.05');
    expect(formatPaise(150)).toBe('₹1.50');
  });

  it('keeps a negative sign outside the grouping', () => {
    expect(formatPaise(-50_000)).toBe('-₹500.00');
  });

  it('accepts a bigint without conversion', () => {
    // The full Indian grouping: 9,00,71,99,25,47,409 — not 90,071,992,547,409.
    expect(formatPaise(9_007_199_254_740_993n)).toBe('₹9,00,71,99,25,47,409.93');
  });

  it('groupIndian leaves short groups untouched', () => {
    expect(groupIndian('123')).toBe('123');
    expect(groupIndian('1234')).toBe('1,234');
    expect(groupIndian('1234567')).toBe('12,34,567');
  });
});

describe('date helpers', () => {
  it('formats an expense date without a timezone shift', () => {
    expect(formatExpenseDate('2026-09-30')).toBe('30 Sep 2026');
  });

  it('formats a month key', () => {
    expect(formatMonth('2026-09')).toBe('September 2026');
    expect(monthKey('2026-09-30')).toBe('2026-09');
  });

  it('returns a malformed value unchanged rather than throwing', () => {
    expect(formatExpenseDate('not-a-date')).toBe('not-a-date');
  });
});

describe('groupExpensesByMonth', () => {
  const page = (expenses: ExpensePage['expenses'], nextCursor: string | null): ExpensePage => ({
    expenses,
    nextCursor,
    hasMore: nextCursor !== null,
  });

  it('groups by month, newest month first, and sums each month', () => {
    const groups = groupExpensesByMonth([
      page(
        [
          makeExpense({ id: 'a', expenseDate: '2026-09-30', amountPaise: 100 }),
          makeExpense({ id: 'b', expenseDate: '2026-09-02', amountPaise: 200 }),
          makeExpense({ id: 'c', expenseDate: '2026-08-31', amountPaise: 400 }),
        ],
        null,
      ),
    ]);

    expect(groups.map((group) => group.key)).toEqual(['2026-09', '2026-08']);
    expect(groups[0]!.label).toBe('September 2026');
    expect(groups[0]!.totalPaise).toBe(300);
    expect(groups[0]!.expenses.map((expense) => expense.id)).toEqual(['a', 'b']);
    expect(groups[1]!.totalPaise).toBe(400);
  });

  it('drops a row that appears on two cursor pages, counting it once', () => {
    const duplicate = makeExpense({ id: 'dup', expenseDate: '2026-09-30', amountPaise: 100 });
    const groups = groupExpensesByMonth([
      page([duplicate, makeExpense({ id: 'x', expenseDate: '2026-09-01' })], 'cursor-2'),
      page([duplicate, makeExpense({ id: 'y', expenseDate: '2026-09-01' })], null),
    ]);

    const ids = groups.flatMap((group) => group.expenses.map((expense) => expense.id));
    expect(ids).toEqual(['dup', 'x', 'y']);
    // The duplicate (100 paise) is not counted twice in the month total.
    expect(groups[0]!.totalPaise).toBe(100 + 4_500_000 + 4_500_000);
  });
});

describe('toRows', () => {
  it('emits a month header before that month’s expenses', () => {
    const groups = groupExpensesByMonth([
      {
        expenses: [makeExpense({ id: 'a', expenseDate: '2026-09-30' })],
        nextCursor: null,
        hasMore: false,
      },
    ]);
    const rows = toRows(groups);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'month', label: 'September 2026', count: 1 });
    expect(rows[1]).toMatchObject({ kind: 'expense' });
    expect(rows[1]!.key).toBe('expense:a');
    expect(rows[0]!.key).toBe('month:2026-09');
  });
});
