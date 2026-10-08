/**
 * Rupee text ⇄ integer paise — the expense form's money boundary (PRD §3.4, SAD §6.4).
 *
 * ## Why the parsing is here and not in the input, and not in the payload builder
 *
 * Three callers need the *same* answer: the resolver decides whether a typed value is
 * acceptable, `AmountInput` reports the paise it has read, and the payload builder turns the
 * field into `amountPaise`. A second implementation in any of them is a rounding rule with two
 * owners, which is the one class of bug this product cannot afford. So parsing is a pure
 * function, the callers are thin, and the boundary tests exercise this file directly.
 *
 * ## No floating point, at any point
 *
 * The rupee digits and the two paise digits are read out of the **string** and combined with
 * `BigInt` (`rupees * 100n + paise`). `Number` appears exactly once, at the end, after the
 * value has been proved to be within `Number.MAX_SAFE_INTEGER` — so the conversion cannot
 * round, and there is no intermediate float to disagree with the integer. `parseFloat`,
 * `toFixed` and `Number(x) / 100` are deliberately absent: each of them is a float operation
 * on money.
 *
 * ## Indian grouping is accepted, and only Indian grouping
 *
 * `1,23,456.78` is what an Indian bill looks like (last group of three, then pairs), and it is
 * what the form accepts. Un-grouped digits (`123456.78`) are accepted too, because a keypad
 * produces them. Anything that claims grouping and gets it wrong — `123,456` (western),
 * `1,2345`, `1,23,45` — is refused rather than silently reinterpreted: `123,456` and `1,23,456`
 * are two different amounts, and guessing which one was meant is not the parser's call.
 */

/** Why a rupee string was refused. `null` never appears here — it means "parsed". */
export type AmountProblem =
  'empty' | 'format' | 'grouping' | 'decimals' | 'negative' | 'zero' | 'range';

/** The result of reading a rupee string: exactly one of the two is meaningful. */
export interface ParsedAmount {
  /** Integer paise, within `Number.MAX_SAFE_INTEGER`; `null` when the text was refused. */
  readonly paise: number | null;
  /** Why it was refused, or `null` when it parsed. */
  readonly problem: AmountProblem | null;
}

/**
 * Grouped integer part: one or two leading digits, then pairs, then a final group of three.
 * `1,23,456` and `12,345` match; `123,456`, `1,2345` and `1,23,45` do not.
 */
const INDIAN_GROUPED = /^\d{1,2}(?:,\d{2})*,\d{3}$/;

/** Un-grouped integer part: any run of digits (`123456`). */
const PLAIN_DIGITS = /^\d+$/;

/** One or two decimals — `5`, `50`, `05`. Three or more is a value we cannot represent. */
const DECIMALS = /^\d{1,2}$/;

/**
 * The largest amount the wire can carry.
 *
 * `createExpenseSchema.amountPaise` is `.int().positive().max(Number.MAX_SAFE_INTEGER)`, so the
 * form must refuse the same ceiling locally — otherwise the field would look accepted and come
 * back as a `422` (₹90,071,992,547,409.91 and up).
 */
const MAX_PAISE = BigInt(Number.MAX_SAFE_INTEGER);

const refused = (problem: AmountProblem): ParsedAmount => ({ paise: null, problem });

/**
 * Read a rupee string into integer paise.
 *
 * Accepts an optional leading `₹` and surrounding whitespace (what a user pastes); refuses
 * negatives, zero, more than two decimals, malformed grouping and values above the safe ceiling.
 */
export function parseRupeeText(raw: string): ParsedAmount {
  // A pasted amount carries the symbol and often a space; both are presentation, not value.
  const text = raw.replace(/^₹/, '').trim();

  if (text.length === 0) return refused('empty');
  // `-500` and `(500)` are both how a negative is written; neither is a valid expense amount.
  if (text.startsWith('-') || text.startsWith('(')) return refused('negative');

  const parts = text.split('.');
  if (parts.length > 2) return refused('format');

  const [integerPart = '', decimalPart] = parts;
  if (integerPart.length === 0) return refused('format');

  const grouped = integerPart.includes(',');
  if (grouped) {
    if (!INDIAN_GROUPED.test(integerPart)) return refused('grouping');
  } else if (!PLAIN_DIGITS.test(integerPart)) {
    return refused('format');
  }

  // `1.` is a half-typed value, not a number; `1.234` is a precision we cannot store.
  if (decimalPart !== undefined && decimalPart.length === 0) return refused('format');
  if (decimalPart !== undefined && !DECIMALS.test(decimalPart)) return refused('decimals');

  const rupees = BigInt(integerPart.replace(/,/g, ''));
  const paise = BigInt(decimalPart === undefined ? '0' : decimalPart.padEnd(2, '0'));
  const total = rupees * 100n + paise;

  if (total === 0n) return refused('zero');
  // Strictly greater, so `MAX_SAFE_INTEGER` itself is accepted and the next paise is not.
  if (total > MAX_PAISE) return refused('range');

  // The one conversion, after the bound is proved: exact by construction.
  return { paise: Number(total), problem: null };
}

/** Integer paise → `1,23,456.78` (no symbol) — what the edit form prefills its field with. */
export function formatPaiseForInput(paise: number): string {
  const total = BigInt(paise);
  const rupees = total / 100n;
  const remainder = total % 100n;
  return `${groupIndianDigits(rupees.toString())}.${remainder.toString().padStart(2, '0')}`;
}

/**
 * `1234567` → `12,34,567`.
 *
 * The same Indian rule `expense.schemas.ts` applies for display and `groupIndian` there
 * implements, restated on digits because this module's callers hold digits — the shared
 * function is re-exported by `expense.schemas.ts` for the money *display* path, and this one
 * exists so the input and the display cannot disagree about where a comma goes.
 */
export function groupIndianDigits(digits: string): string {
  if (digits.length <= 3) return digits;
  const lastThree = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${lastThree}`;
}

/**
 * The sentence a refused amount renders, keyed by the refusal.
 *
 * Written here rather than in the screen because the resolver, the input and any future caller
 * must say the same thing; a second copy of these strings is how one screen ends up explaining
 * "grouping" while another says "invalid".
 */
export const AMOUNT_PROBLEM_MESSAGES: Record<AmountProblem, string> = {
  empty: 'Enter an amount',
  format: 'Enter an amount like 1,23,456.78',
  grouping: 'Check the comma grouping — for example 1,23,456.78',
  decimals: 'Use at most two decimal places',
  negative: 'An expense amount cannot be negative',
  zero: 'An expense amount must be more than zero',
  range: 'That amount is too large to record',
};

/** The message for a rupee string, or `null` when it parses. */
export function amountTextProblem(raw: string): string | null {
  const { problem } = parseRupeeText(raw);
  return problem === null ? null : AMOUNT_PROBLEM_MESSAGES[problem];
}
