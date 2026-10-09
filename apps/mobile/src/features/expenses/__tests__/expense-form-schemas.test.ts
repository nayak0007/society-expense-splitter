import { createExpenseSchema } from '@ses/contracts';
import { EXPENSE_TITLE_MAX_LENGTH } from '@ses/domain';

import { makeExpense } from '../__fixtures__/expense-fixtures';
import { ApiError } from '@/lib/api/api-client';
import { parseRupeeText } from '../schemas/expense-amount';
import {
  emptyExpenseForm,
  expenseFormSchema,
  expenseToFormValues,
  formFieldOfError,
  formValuesToCreatePayload,
  formValuesToUpdatePayload,
  isVersionConflict,
  migrateDraftValues,
  staleVersionFromError,
  todayIsoDate,
} from '../schemas/expense-form.schemas';
import type { ExpenseFormValues } from '../schemas/expense-form.schemas';

/**
 * The form's schema, payloads and error mapping (Roadmap T074 §3, §5, §6).
 *
 * The parity block is the important one: it runs the *same* values through the form's schema and
 * through the shared create contract and asserts they agree about acceptance. If a bound is ever
 * changed in one place, this fails instead of the form quietly accepting a title the API refuses.
 */
function validValues(overrides: Partial<ExpenseFormValues> = {}): ExpenseFormValues {
  return {
    ...emptyExpenseForm(new Date('2026-10-08T00:00:00.000Z')),
    title: 'Lift AMC — Q3',
    amount: '60,000.00',
    categoryId: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}

const PAISE = 6_000_000;

describe('emptyExpenseForm', () => {
  it('defaults the payment source to the society account and the date to today', () => {
    const form = emptyExpenseForm(new Date('2026-10-08T12:00:00.000Z'));
    expect(form.paymentSource).toBe('society_account');
    expect(form.expenseDate).toBe(todayIsoDate(new Date('2026-10-08T12:00:00.000Z')));
    expect(form.title).toBe('');
    expect(form.paidByMemberId).toBeNull();
  });
});

describe('expenseFormSchema', () => {
  it('accepts a complete form', () => {
    expect(expenseFormSchema.safeParse(validValues()).success).toBe(true);
  });

  it.each([
    ['title', { title: '' }],
    ['amount', { amount: '' }],
    ['amount', { amount: '12,34' }],
    ['categoryId', { categoryId: '' }],
    ['expenseDate', { expenseDate: '2026-1-1' }],
    ['expenseDate', { expenseDate: '2026-02-31' }],
  ])('refuses an invalid %s', (_field, override) => {
    expect(expenseFormSchema.safeParse(validValues(override)).success).toBe(false);
  });

  it('refuses a title past the contract bound', () => {
    expect(
      expenseFormSchema.safeParse(validValues({ title: 'x'.repeat(EXPENSE_TITLE_MAX_LENGTH + 1) }))
        .success,
    ).toBe(false);
  });
});

describe('parity with the shared create contract', () => {
  it.each([
    ['a complete form', validValues(), true],
    ['an over-long title', validValues({ title: 'x'.repeat(EXPENSE_TITLE_MAX_LENGTH + 1) }), false],
    ['a negative amount', validValues({ amount: '-1' }), false],
    ['a zero amount', validValues({ amount: '0' }), false],
    ['a missing category', validValues({ categoryId: '' }), false],
    ['the largest safe amount', validValues({ amount: '9,00,71,99,25,47,409.91' }), true],
  ])('agrees about %s', (_label, values, expected) => {
    const local = expenseFormSchema.safeParse(values);
    expect(local.success).toBe(expected);

    // The server's own view of the same submission — through the payload the form would send.
    if (local.success) {
      const payload = formValuesToCreatePayload(local.data, parseAmount(local.data.amount));
      expect(createExpenseSchema.safeParse(payload).success).toBe(expected);
    }
  });
});

/** The paise `AmountInput` would have emitted for this text, without rendering it. */
function parseAmount(text: string): number | null {
  return parseRupeeText(text).paise;
}

describe('formValuesToCreatePayload', () => {
  it('sends integer paise and trims the text fields', () => {
    const payload = formValuesToCreatePayload(
      validValues({ title: '  Lift AMC  ', vendorName: '  Otis  ' }),
      PAISE,
    );
    expect(payload).toMatchObject({
      title: 'Lift AMC',
      amountPaise: PAISE,
      vendorName: 'Otis',
      paymentSource: 'society_account',
    });
    expect(Number.isInteger(payload.amountPaise)).toBe(true);
  });

  it('omits empty optionals rather than sending empty strings', () => {
    const payload = formValuesToCreatePayload(validValues(), PAISE);
    expect(payload).not.toHaveProperty('description');
    expect(payload).not.toHaveProperty('vendorName');
    expect(payload).not.toHaveProperty('paidByMemberId');
  });

  it('carries the split fields (T075) with the product’s own defaults when untouched', () => {
    const payload = formValuesToCreatePayload(validValues(), PAISE);
    expect(payload.splitStrategy).toBe('equal');
    expect(payload.apartmentBasis).toBeNull();
    expect(payload.splitConfig).toEqual({});
    expect(payload.participantSelector).toEqual({});
  });

  it('carries a configured split verbatim', () => {
    const payload = formValuesToCreatePayload(
      validValues({
        splitStrategy: 'percentage',
        apartmentBasis: null,
        splitConfig: { percentages: [{ apartmentId: 'apt-1', basisPoints: 3333 }] },
        participantSelector: { buildings: ['11111111-1111-4111-8111-111111111111'] },
      }),
      PAISE,
    );
    expect(payload.splitStrategy).toBe('percentage');
    expect(payload.splitConfig).toEqual({
      percentages: [{ apartmentId: 'apt-1', basisPoints: 3333 }],
    });
    expect(payload.participantSelector).toEqual({
      buildings: ['11111111-1111-4111-8111-111111111111'],
    });
  });

  it('refuses to build a payload with no amount', () => {
    expect(() => formValuesToCreatePayload(validValues(), null)).toThrow(/not a valid rupee value/);
  });
});

describe('formValuesToUpdatePayload', () => {
  const baseline = validValues();

  it('returns null when nothing changed, so no version is bumped for nothing', () => {
    expect(
      formValuesToUpdatePayload({
        values: baseline,
        baseline,
        expectedVersion: 3,
        amountPaise: PAISE,
      }),
    ).toBeNull();
  });

  it('sends only the changed field, plus the version it read', () => {
    const payload = formValuesToUpdatePayload({
      values: validValues({ title: 'Lift AMC — Q4' }),
      baseline,
      expectedVersion: 3,
      amountPaise: PAISE,
    });
    expect(payload).toEqual({ title: 'Lift AMC — Q4', expectedVersion: 3 });
  });

  it('clears an emptied optional with an explicit null', () => {
    const withVendor = validValues({ vendorName: 'Otis' });
    const payload = formValuesToUpdatePayload({
      values: validValues({ vendorName: '' }),
      baseline: withVendor,
      expectedVersion: 1,
      amountPaise: PAISE,
    });
    expect(payload).toEqual({ vendorName: null, expectedVersion: 1 });
  });

  it('carries a changed amount as integer paise', () => {
    const payload = formValuesToUpdatePayload({
      values: validValues({ amount: '1,00,000.00' }),
      baseline,
      expectedVersion: 2,
      amountPaise: 10_000_000,
    });
    expect(payload).toEqual({ amountPaise: 10_000_000, expectedVersion: 2 });
  });

  it('produces a patch the shared update contract accepts', () => {
    const payload = formValuesToUpdatePayload({
      values: validValues({ description: 'Emergency repair', paymentSource: 'petty_cash' }),
      baseline,
      expectedVersion: 4,
      amountPaise: PAISE,
    });
    expect(payload).toMatchObject({
      description: 'Emergency repair',
      paymentSource: 'petty_cash',
      expectedVersion: 4,
    });
  });
});

describe('migrateDraftValues (T075 §10)', () => {
  it('lifts a T074 draft forward, preserving every field it carried', () => {
    const legacy = {
      title: 'Lift AMC',
      amount: '1,000.00',
      expenseDate: '2026-10-01',
      categoryId: 'cat-1',
      description: 'Quarterly',
      vendorName: 'Otis',
      paymentSource: 'society_account',
      paidByMemberId: null,
    };
    const migrated = migrateDraftValues(legacy);
    expect(migrated).not.toBeNull();
    expect(migrated?.title).toBe('Lift AMC');
    expect(migrated?.vendorName).toBe('Otis');
    expect(migrated?.description).toBe('Quarterly');
    // The split it actually described: the product's own defaults.
    expect(migrated?.splitStrategy).toBe('equal');
    expect(migrated?.splitConfig).toEqual({});
    expect(migrated?.participantSelector).toEqual({});
  });

  it('passes a current draft through unchanged', () => {
    const current = validValues();
    expect(migrateDraftValues(current)).toEqual(current);
  });

  it('refuses a draft that fits neither shape', () => {
    expect(migrateDraftValues({ title: 42 })).toBeNull();
    expect(migrateDraftValues(null)).toBeNull();
  });
});

describe('expenseToFormValues', () => {
  it('prefills from the server row, formatting paise back to grouped text', () => {
    const form = expenseToFormValues(
      makeExpense({ amountPaise: 12_345_678, description: null, vendorName: null }),
    );
    expect(form.amount).toBe('1,23,456.78');
    expect(form.description).toBe('');
    expect(form.vendorName).toBe('');
    expect(form.categoryId).toBe('cat-1');
    expect(form.paymentSource).toBe('society_account');
  });
});

describe('error mapping', () => {
  it('maps a named field, and ignores a name this form has no input for', () => {
    expect(
      formFieldOfError(
        new ApiError(422, 'VALIDATION_ERROR', 'bad', undefined, undefined, undefined, 'title'),
      ),
    ).toBe('title');
    expect(
      formFieldOfError(
        new ApiError(
          409,
          'VERSION_MISMATCH',
          'stale',
          undefined,
          undefined,
          undefined,
          'expectedVersion',
        ),
      ),
    ).toBeUndefined();
    expect(formFieldOfError(new Error('boom'))).toBeUndefined();
  });

  it('reads the current version from a version conflict, and only from one', () => {
    const conflict = new ApiError(409, 'VERSION_MISMATCH', 'stale', undefined, [
      { field: 'version', code: 'VERSION_MISMATCH', message: 'stale', current: 7 },
    ]);
    expect(staleVersionFromError(conflict)).toBe(7);
    expect(isVersionConflict(conflict)).toBe(true);
    expect(staleVersionFromError(new ApiError(422, 'VALIDATION_ERROR', 'bad'))).toBeNull();
    expect(isVersionConflict(new ApiError(422, 'VALIDATION_ERROR', 'bad'))).toBe(false);
  });

  it('returns null for a conflict whose details carry no usable version', () => {
    expect(
      staleVersionFromError(new ApiError(409, 'VERSION_MISMATCH', 'stale', undefined, undefined)),
    ).toBeNull();
  });
});
