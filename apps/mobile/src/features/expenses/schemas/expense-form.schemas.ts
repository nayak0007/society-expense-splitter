/**
 * The expense form's schema, values and payload builders — Roadmap T074.
 *
 * ## Where the validation rules come from
 *
 * The field rules are the **same bounds the contract itself applies**, imported from
 * `@ses/domain` — the module `packages/contracts/src/expenses.ts` also reads them from. That is
 * the established convention in this app (`member.schemas.ts` does exactly this with
 * `MEMBER_NAME_MAX_LENGTH`): one constant, two schemas, no drift. It is deliberately *not* a
 * re-declaration of literal numbers, which is how a form starts accepting a title the server
 * refuses.
 *
 * The money field cannot be expressed as a contract type at all: the contract carries
 * `amountPaise: number` (what the server wants) while a form holds what the user typed
 * (`"1,23,456.78"`). `expense-amount.ts` owns that conversion, this schema consumes it for
 * validation, and `AmountInput` emits the resulting integer paise to the payload builders — so
 * the form's own rule *is* the contract's rule, evaluated on the text.
 *
 * `expense-form-schemas.test.ts` pins the parity directly, running a matrix of values through
 * both this schema and `createExpenseSchema` and asserting they agree about acceptance.
 *
 * ## What the form does not carry, on purpose
 *
 * `splitStrategy`, `apartmentBasis`, `splitConfig` and `participantSelector` are absent: the
 * Roadmap builds the split configurator in T075, and an omitted key means the server applies
 * the category's own defaults (the resolution T064/T065 already implement). `status`,
 * `societyId` and `createdBy` are absent because they are not the client's to state — the
 * tenant comes from the active society and the actor from the token (SAD §1.1). GST fields are
 * absent because the create/update contracts do not have them (T072 owns that route), and
 * attachments are T076's.
 */

import type { CreateExpensePayload, UpdateExpensePayload } from '@ses/contracts';
import {
  EXPENSE_DESCRIPTION_MAX_LENGTH,
  EXPENSE_TITLE_MAX_LENGTH,
  EXPENSE_VENDOR_NAME_MAX_LENGTH,
  PAYMENT_SOURCES,
} from '@ses/domain';
import type { PaymentSource } from '@ses/domain';
import { z } from 'zod';

import { isApiError } from '@/lib/api/api-client';
import { sesResolver } from '@/lib/forms/resolver';

import type { ExpenseSummary } from '../repository/expense.repository';

import { amountTextProblem, formatPaiseForInput, parseRupeeText } from './expense-amount';

/** `YYYY-MM-DD`, and a real calendar date (a regex alone accepts `2026-02-31`). */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map((part) => Number(part));
  if (year === undefined || month === undefined || day === undefined) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

const dateField = z
  .string()
  .trim()
  .refine(isCalendarDate, { message: 'Use a real date, as YYYY-MM-DD' });

/**
 * The form's own field set.
 *
 * Everything is a string or a boolean — the shape an input can actually hold. `amount` is text
 * (so a half-typed value can be *explained* rather than silently dropped), and the conversion to
 * integer paise happens in `parseRupeeText` at the resolver and the payload boundary.
 */
export const expenseFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Enter a title')
    .max(EXPENSE_TITLE_MAX_LENGTH, `Title must be ${EXPENSE_TITLE_MAX_LENGTH} characters or fewer`),
  /** Rupee text; the paise value is derived, never stored as a float. */
  amount: z.string().refine((value) => amountTextProblem(value) === null, {
    message: 'Enter an amount like 1,23,456.78',
  }),
  expenseDate: dateField,
  categoryId: z.string().min(1, 'Choose a category'),
  description: z
    .string()
    .max(
      EXPENSE_DESCRIPTION_MAX_LENGTH,
      `Notes must be ${EXPENSE_DESCRIPTION_MAX_LENGTH} characters or fewer`,
    ),
  vendorName: z
    .string()
    .max(
      EXPENSE_VENDOR_NAME_MAX_LENGTH,
      `Vendor must be ${EXPENSE_VENDOR_NAME_MAX_LENGTH} characters or fewer`,
    ),
  paymentSource: z.enum(PAYMENT_SOURCES),
  paidByMemberId: z.string().nullable(),
});

export type ExpenseFormValues = z.infer<typeof expenseFormSchema>;

/**
 * The draft's shape — the field **types** only, none of the form's rules.
 *
 * A draft is by definition not submittable: it is the text captured mid-typing, so `title` may be
 * empty, the amount unparsed and the category unchosen. Validating a stored draft against
 * `expenseFormSchema` would therefore refuse exactly the drafts the feature exists to keep — which
 * is how this was found (the store's own test failed on a partially typed row). What the draft
 * store needs to know is narrower and strictly factual: *is this the shape this build writes?* A
 * renamed or removed field, or a type that changed, answers no; an unfinished value answers yes.
 */
export const expenseDraftValuesSchema = z.object({
  title: z.string(),
  amount: z.string(),
  expenseDate: z.string(),
  categoryId: z.string(),
  description: z.string(),
  vendorName: z.string(),
  paymentSource: z.enum(PAYMENT_SOURCES),
  paidByMemberId: z.string().nullable(),
});

/**
 * One resolver for both modes.
 *
 * Unlike the member form there is no create-only rule: the expense contract's create and update
 * schemas differ by `expectedVersion` and by partiality, not by which fields are required — a
 * draft is explicitly allowed to be incomplete (`createExpenseSchema`'s own comment), so the form
 * asks only for what a *usable* draft needs.
 */
export const expenseFormResolver = sesResolver(expenseFormSchema);

/** The payer options, as chips — the PRD's four sources, labelled for a treasurer. */
export const PAYMENT_SOURCE_LABELS: Record<PaymentSource, string> = {
  society_account: 'Society account',
  petty_cash: 'Petty cash',
  member_paid: 'Member paid',
  vendor_credit: 'Vendor credit',
};

export const PAYMENT_SOURCE_OPTIONS: readonly {
  readonly value: PaymentSource;
  readonly label: string;
}[] = PAYMENT_SOURCES.map((source) => ({
  value: source,
  label: PAYMENT_SOURCE_LABELS[source],
}));

/** Today, as `YYYY-MM-DD`, in the device's own calendar — the default expense date. */
export function todayIsoDate(now: Date = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * The empty form.
 *
 * `paymentSource` defaults to `society_account` — the treasurer's own money, which is what the
 * PRD's list implies for a society-raised bill and what the API stores when the field is
 * omitted. `expenseDate` defaults to today (PRD §3.4: "Defaults to today").
 */
export function emptyExpenseForm(now: Date = new Date()): ExpenseFormValues {
  return {
    title: '',
    amount: '',
    expenseDate: todayIsoDate(now),
    categoryId: '',
    description: '',
    vendorName: '',
    paymentSource: 'society_account',
    paidByMemberId: null,
  };
}

/** Prefill the edit form from the server's row (`null`s become empty strings). */
export function expenseToFormValues(expense: ExpenseSummary): ExpenseFormValues {
  return {
    title: expense.title,
    amount: formatPaiseForInput(expense.amountPaise),
    expenseDate: expense.expenseDate,
    categoryId: expense.categoryId,
    description: expense.description ?? '',
    vendorName: expense.vendorName ?? '',
    paymentSource: expense.paymentSource,
    paidByMemberId: expense.paidByMemberId,
  };
}

/**
 * Form → create payload.
 *
 * Optional fields are **omitted** when empty rather than sent as `''`: the create contract
 * refuses `null` on a row that does not exist yet (there is nothing to clear), and an empty
 * string would be stored as a vendor literally named "".
 */
export function formValuesToCreatePayload(
  values: ExpenseFormValues,
  amountPaise: number | null,
): CreateExpensePayload {
  if (amountPaise === null) {
    // Unreachable through the resolver and through `AmountInput`'s own emission; a typed guard
    // rather than a non-null assertion, so a caller that bypasses either cannot send `undefined`
    // as money.
    throw new Error('The amount is not a valid rupee value.');
  }
  const paise = amountPaise;

  const description = values.description.trim();
  const vendorName = values.vendorName.trim();

  return {
    title: values.title.trim(),
    amountPaise: paise,
    expenseDate: values.expenseDate.trim(),
    categoryId: values.categoryId,
    paymentSource: values.paymentSource,
    ...(description.length === 0 ? {} : { description }),
    ...(vendorName.length === 0 ? {} : { vendorName }),
    ...(values.paidByMemberId === null ? {} : { paidByMemberId: values.paidByMemberId }),
  };
}

/**
 * Form → update payload, as a **diff** against what the server last returned.
 *
 * ## Why a diff, and why `null` on an emptied field
 *
 * The update contract's own rule is "an absent key means unchanged, an explicit `null` clears a
 * nullable column". Sending the whole form back would therefore mean that every edit rewrote
 * every column and bumped the version — and a concurrent edit would look like a conflict even
 * when the two writers touched different fields. Sending only what changed keeps the promise the
 * optimistic lock is making. A field the user **emptied** becomes an explicit `null` (that is the
 * clear the contract asks for), not an omission, which would leave the old vendor on the row.
 *
 * Returns `null` when nothing changed: the contract refuses a body carrying only
 * `expectedVersion` (`.refine`), and a no-op write that bumped the version would be a lie about
 * who changed what.
 *
 * `amountPaise` is the value `AmountInput` emitted for the current text rather than a second
 * parse of `values.amount` — the input is the one place that converts money, and the form passes
 * its answer through.
 */
export interface ExpenseUpdateDiffInput {
  readonly values: ExpenseFormValues;
  readonly baseline: ExpenseFormValues;
  readonly expectedVersion: number;
  /** The paise `AmountInput` emitted for the current text. */
  readonly amountPaise: number | null;
}

export function formValuesToUpdatePayload({
  values,
  baseline,
  expectedVersion,
  amountPaise,
}: ExpenseUpdateDiffInput): UpdateExpensePayload | null {
  if (amountPaise === null) throw new Error('The amount is not a valid rupee value.');

  const patch: Record<string, unknown> = {};
  const paise = amountPaise;
  // The baseline is the server's row, so its own paise is authoritative — reading it from the
  // integer rather than re-parsing the prefill text keeps the comparison exact.
  const baselineAmount = parseRupeeText(baseline.amount).paise;

  const title = values.title.trim();
  if (title !== baseline.title.trim()) patch.title = title;

  if (paise !== baselineAmount) patch.amountPaise = paise;

  const expenseDate = values.expenseDate.trim();
  if (expenseDate !== baseline.expenseDate.trim()) patch.expenseDate = expenseDate;

  if (values.categoryId !== baseline.categoryId) patch.categoryId = values.categoryId;
  if (values.paymentSource !== baseline.paymentSource) patch.paymentSource = values.paymentSource;

  const description = values.description.trim();
  const baselineDescription = baseline.description.trim();
  if (description !== baselineDescription) {
    patch.description = description.length === 0 ? null : description;
  }

  const vendorName = values.vendorName.trim();
  const baselineVendor = baseline.vendorName.trim();
  if (vendorName !== baselineVendor) {
    patch.vendorName = vendorName.length === 0 ? null : vendorName;
  }

  if (values.paidByMemberId !== baseline.paidByMemberId) {
    patch.paidByMemberId = values.paidByMemberId;
  }

  if (Object.keys(patch).length === 0) return null;
  return { ...patch, expectedVersion } as UpdateExpensePayload;
}

const FORM_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'amount',
  'expenseDate',
  'categoryId',
  'description',
  'vendorName',
  'paymentSource',
  'paidByMemberId',
] satisfies ReadonlyArray<keyof ExpenseFormValues>);

/**
 * The input a failed request belongs to, when the server named one.
 *
 * The name is checked against this form's own fields before being handed to `setError`: the
 * API's vocabulary is wider than one form's, and an unrecognised name would create an error key
 * no input renders — an invisible failure. A name that is *not* a form field (say
 * `expectedVersion`) falls through to the form-level error instead.
 */
export function formFieldOfError(error: unknown): keyof ExpenseFormValues | undefined {
  if (!isApiError(error)) return undefined;
  const field = error.field ?? error.details?.[0]?.field;
  return typeof field === 'string' && FORM_FIELDS.has(field)
    ? (field as keyof ExpenseFormValues)
    : undefined;
}

/**
 * The version the server currently holds, read from a `VERSION_MISMATCH` refusal.
 *
 * T065's update answers `409 VERSION_MISMATCH` with `details[0].current` carrying the row's
 * current version (SAD §7.11's shape). Reading it is what lets the screen say *what* changed
 * rather than only *that* something did.
 */
export function staleVersionFromError(error: unknown): number | null {
  if (!isApiError(error) || error.code !== 'VERSION_MISMATCH') return null;
  const current = error.details?.[0]?.current;
  return typeof current === 'number' && Number.isInteger(current) ? current : null;
}

/** True when the failure is the optimistic lock rather than a validation or network problem. */
export function isVersionConflict(error: unknown): boolean {
  return isApiError(error) && error.code === 'VERSION_MISMATCH';
}
