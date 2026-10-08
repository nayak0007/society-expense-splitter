/**
 * Expense view vocabulary and formatting — Roadmap T073.
 *
 * ## Money never becomes a float
 *
 * `formatPaise` works entirely in `BigInt`: the integer paise value is split into whole
 * rupees and the two-digit remainder, and the rupee digits are grouped by a **string**
 * rule (last three, then pairs — the Indian lakh/crore grouping). No `Number` division,
 * no `toFixed`, no `Intl` with a numeric argument: a value near `Number.MAX_SAFE_INTEGER`
 * cannot drift, and the decorative separator never touches the amount.
 *
 * ## Labels are closed unions, not free strings
 *
 * The status labels are keyed by the exact stored vocabulary (`EXPENSE_STATUSES`), so a
 * status the build does not know renders as itself rather than as a blank badge.
 */

import type { ExpenseStatus } from '@ses/domain';

export const EXPENSE_STATUS_LABELS: Record<ExpenseStatus, string> = {
  draft: 'Draft',
  pending_approval: 'Awaiting approval',
  published: 'Published',
  void: 'Void',
};

/** Colour-role names for the status badge, matching `Text`'s `color` roles. */
export const EXPENSE_STATUS_TONES: Record<ExpenseStatus, 'neutral' | 'attention' | 'done'> = {
  draft: 'neutral',
  pending_approval: 'attention',
  published: 'done',
  void: 'attention',
};

/**
 * Integer paise → `₹1,23,456.78`.
 *
 * The rupees are grouped by the Indian convention (the last three digits, then groups of
 * two), which is what an Indian resident expects on a bill — `₹1,23,456`, not `₹123,456`.
 * Everything is done on digit strings derived from a `BigInt`, so the amount is never a
 * floating-point number at any point.
 */
export function formatPaise(value: number | bigint): string {
  const total = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  const negative = total < 0n;
  const absolute = negative ? -total : total;
  const rupees = absolute / 100n;
  const remainder = absolute % 100n;
  const sign = negative ? '-' : '';
  return `${sign}₹${groupIndian(rupees.toString())}.${remainder.toString().padStart(2, '0')}`;
}

/** `1234567` → `12,34,567` — the last group is three digits, every earlier group two. */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3);
  // A comma before every pair of digits counting from the right.
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${grouped},${lastThree}`;
}

/** `2026-10-01` → `1 Oct 2026`; a malformed value is returned unchanged. */
export function formatExpenseDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return value;
  const month = MONTHS[Number(match[2]) - 1];
  if (month === undefined) return value;
  return `${String(Number(match[3]))} ${month} ${match[1]}`;
}

/** `2026-10` → `October 2026` — the month header a grouped list renders. */
export function formatMonth(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (match === null) return key;
  const month = LONG_MONTHS[Number(match[2]) - 1];
  if (month === undefined) return key;
  return `${month} ${match[1]}`;
}

/** The `YYYY-MM` bucket an expense date belongs to; the grouping key for the list. */
export function monthKey(expenseDate: string): string {
  return expenseDate.slice(0, 7);
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const LONG_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
