import { mmkvStorage } from '@/lib/storage/mmkv';

import { emptyExpenseForm } from '../schemas/expense-form.schemas';
import {
  clearExpenseDraft,
  expenseDraftKey,
  isDraftStale,
  readExpenseDraft,
  writeExpenseDraft,
} from '../services/expense-draft.store';
import type { ExpenseDraftScope } from '../services/expense-draft.store';

/**
 * The local draft (Roadmap T074 §7): where it lives, who can see it, and when it is refused.
 *
 * `react-native-mmkv` is replaced by an in-memory double in `jest.setup.ts`, and `mmkvStorage` is a
 * module singleton — so these tests exercise the real store against a real (in-memory) key-value
 * map, which is what makes the isolation assertions meaningful: they check *keys*, not a mock's
 * call log.
 */
const scope: ExpenseDraftScope = { userId: 'user-1', societyId: 'soc-1', expenseId: null };

beforeEach(() => {
  mmkvStorage.clearAll();
});

describe('expenseDraftKey', () => {
  it('addresses a draft by user, society and expense', () => {
    expect(expenseDraftKey(scope)).toBe('ses/expense-draft/soc-1/new/user-1');
    expect(expenseDraftKey({ ...scope, expenseId: 'exp-9' })).toBe(
      'ses/expense-draft/soc-1/exp-9/user-1',
    );
  });

  it('has no key without a session or a society', () => {
    expect(expenseDraftKey({ ...scope, userId: null })).toBeNull();
    expect(expenseDraftKey({ ...scope, societyId: null })).toBeNull();
  });
});

describe('write / read', () => {
  it('round-trips the values and the version they were based on', () => {
    const values = { ...emptyExpenseForm(), title: 'Lift AMC', amount: '1,000.00' };
    const written = writeExpenseDraft(scope, values, 4);

    expect(written).not.toBeNull();
    const read = readExpenseDraft(scope);
    expect(read?.values.title).toBe('Lift AMC');
    expect(read?.basedOnVersion).toBe(4);
    expect(read?.savedAt).not.toBe('');
  });

  it('refuses to write without a session or society, and reads nothing back', () => {
    const values = emptyExpenseForm();
    expect(writeExpenseDraft({ ...scope, userId: null }, values, null)).toBeNull();
    expect(readExpenseDraft({ ...scope, userId: null })).toBeNull();
  });

  it('returns null when nothing has been written', () => {
    expect(readExpenseDraft(scope)).toBeNull();
  });
});

describe('isolation between users, societies and expenses', () => {
  it('keeps four drafts apart', () => {
    const mine = { ...emptyExpenseForm(), title: 'Mine' };
    const otherUser = { ...emptyExpenseForm(), title: 'Other user' };
    const otherSociety = { ...emptyExpenseForm(), title: 'Other society' };
    const otherExpense = { ...emptyExpenseForm(), title: 'Other expense' };

    writeExpenseDraft(scope, mine, null);
    writeExpenseDraft({ ...scope, userId: 'user-2' }, otherUser, null);
    writeExpenseDraft({ ...scope, societyId: 'soc-2' }, otherSociety, null);
    writeExpenseDraft({ ...scope, expenseId: 'exp-9' }, otherExpense, 2);

    expect(readExpenseDraft(scope)?.values.title).toBe('Mine');
    expect(readExpenseDraft({ ...scope, userId: 'user-2' })?.values.title).toBe('Other user');
    expect(readExpenseDraft({ ...scope, societyId: 'soc-2' })?.values.title).toBe('Other society');
    expect(readExpenseDraft({ ...scope, expenseId: 'exp-9' })?.values.title).toBe('Other expense');
  });

  it('clears only the addressed draft', () => {
    writeExpenseDraft(scope, { ...emptyExpenseForm(), title: 'Mine' }, null);
    writeExpenseDraft(
      { ...scope, userId: 'user-2' },
      { ...emptyExpenseForm(), title: 'Theirs' },
      null,
    );

    clearExpenseDraft(scope);

    expect(readExpenseDraft(scope)).toBeNull();
    expect(readExpenseDraft({ ...scope, userId: 'user-2' })?.values.title).toBe('Theirs');
  });
});

describe('a stored draft is read, never trusted', () => {
  it('drops a record that is not JSON', () => {
    mmkvStorage.set(expenseDraftKey(scope) ?? '', '{not json');
    expect(readExpenseDraft(scope)).toBeNull();
    // Dropped, not left to fail forever.
    expect(mmkvStorage.getString(expenseDraftKey(scope) ?? '')).toBeUndefined();
  });

  it('drops a record whose shape this build does not write', () => {
    // An older build's shape: a value of the wrong type, and a missing field.
    mmkvStorage.set(
      expenseDraftKey(scope) ?? '',
      JSON.stringify({ values: { title: 42 }, basedOnVersion: 1, savedAt: 'x' }),
    );
    expect(readExpenseDraft(scope)).toBeNull();
    expect(mmkvStorage.getString(expenseDraftKey(scope) ?? '')).toBeUndefined();
  });

  it('restores a half-typed draft, which is not a submittable form', () => {
    // The case the feature exists for: no title, an unparsed amount, no category yet.
    const partial = { ...emptyExpenseForm(), amount: '12,3' };
    writeExpenseDraft(scope, partial, null);

    const read = readExpenseDraft(scope);
    expect(read?.values.amount).toBe('12,3');
    expect(read?.values.title).toBe('');
    expect(read?.values.categoryId).toBe('');
  });

  it('treats a non-integer stored version as unknown rather than as staleness', () => {
    mmkvStorage.set(
      expenseDraftKey(scope) ?? '',
      JSON.stringify({ values: emptyExpenseForm(), basedOnVersion: 'four', savedAt: 'x' }),
    );
    expect(readExpenseDraft(scope)?.basedOnVersion).toBeNull();
  });
});

describe('T074 → T075 migration (T075 §10)', () => {
  it('lifts a T074 draft forward with the split defaults, keeping every field', () => {
    // Exactly what a T074 build wrote: schema version 1, no split fields.
    mmkvStorage.set(
      expenseDraftKey(scope) ?? '',
      JSON.stringify({
        values: {
          title: 'Lift AMC',
          amount: '1,000.00',
          expenseDate: '2026-10-01',
          categoryId: 'cat-1',
          description: 'Quarterly',
          vendorName: 'Otis',
          paymentSource: 'society_account',
          paidByMemberId: null,
        },
        basedOnVersion: null,
        savedAt: '2026-10-01T10:00:00.000Z',
        schemaVersion: 1,
      }),
    );

    const read = readExpenseDraft(scope);
    expect(read?.values.title).toBe('Lift AMC');
    expect(read?.values.vendorName).toBe('Otis');
    expect(read?.values.splitStrategy).toBe('equal');
    expect(read?.splitCustomized).toBe(false);
    expect(read?.schemaVersion).toBe(1);
  });

  it('round-trips the T075 version and the customized flag', () => {
    const written = writeExpenseDraft(scope, emptyExpenseForm(), null, true);
    expect(written?.schemaVersion).toBe(2);
    const read = readExpenseDraft(scope);
    expect(read?.schemaVersion).toBe(2);
    expect(read?.splitCustomized).toBe(true);
  });
});

describe('isDraftStale', () => {
  const draft = {
    values: emptyExpenseForm(),
    basedOnVersion: 3,
    savedAt: '',
    schemaVersion: 2,
    splitCustomized: false,
  };

  it('is stale only when both versions are known and differ', () => {
    expect(isDraftStale(draft, 3)).toBe(false);
    expect(isDraftStale(draft, 4)).toBe(true);
  });

  it('is not stale for a create draft or an unknown version', () => {
    expect(isDraftStale({ ...draft, basedOnVersion: null }, 9)).toBe(false);
    expect(isDraftStale(draft, null)).toBe(false);
  });
});
