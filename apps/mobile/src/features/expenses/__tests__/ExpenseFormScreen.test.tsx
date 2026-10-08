import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { asMemberId, asSocietyId } from '@ses/domain';

import { mmkvStorage } from '@/lib/storage/mmkv';
import { ApiError } from '@/lib/api/api-client';
import { useAuthStore } from '@/stores/auth.store';
import { useSocietyStore } from '@/stores/society.store';

import { makeExpense } from '../__fixtures__/expense-fixtures';
import { readExpenseDraft, writeExpenseDraft } from '../services/expense-draft.store';

/**
 * The expense form (Roadmap T074 §3, §5, §6, §7, §9).
 *
 * ## What is mocked, and what is not
 *
 * The *network* seams are mocked — the two mutation hooks and the option reads — because a
 * component test must not call an API. Everything that decides behaviour is real: the resolver and
 * payload builders, the RHF wiring, the draft store over the MMKV double from `jest.setup.ts`, and
 * the authorization gates (`canOnResource` against the real domain matrix). So "the amount is sent
 * as an integer paise value" and "the draft resumes" are assertions about production code rather
 * than about a stand-in for it.
 */
const mockReplace = jest.fn();
const mockPush = jest.fn();
const mockParams: { id?: string } = {};

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ replace: mockReplace, push: mockPush, back: () => undefined }),
}));

jest.mock('../hooks/use-expenses', () => ({
  useExpenseCategoryOptions: () => ({
    categories: [
      { id: 'cat-1', name: 'Maintenance' },
      { id: 'cat-2', name: 'Water' },
    ],
    isLoading: false,
  }),
  useExpensePayerOptions: () => ({
    payers: [{ id: 'mem-1', displayName: 'Owner A1' }],
    isLoading: false,
  }),
}));

jest.mock('../hooks/use-expense', () => ({
  useExpense: jest.fn(),
}));

const mockCreate = jest.fn();
const mockUpdate = jest.fn();
let mockPending = false;

jest.mock('../hooks/use-expense-actions', () => ({
  useCreateExpense: () => ({ mutateAsync: mockCreate, isPending: mockPending }),
  useUpdateExpense: () => ({ mutateAsync: mockUpdate, isPending: mockPending }),
}));

import ExpenseFormScreen from '../screens/ExpenseFormScreen';
import { useExpense } from '../hooks/use-expense';

const mockUseExpense = useExpense as jest.Mock;

beforeEach(() => {
  mockReplace.mockClear();
  mockPush.mockClear();
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockPending = false;
  delete mockParams.id;
  mmkvStorage.clearAll();
  setSession('admin');
});

afterEach(() => {
  jest.useRealTimers();
});

/** The session the screen gates against: an active membership in the active society. */
function setSession(role: 'admin' | 'treasurer' | 'committee_member' | 'resident'): void {
  useAuthStore.setState({ user: { id: 'user-1', email: null } });
  useSocietyStore.setState({
    memberships: [
      {
        id: asMemberId('mem-1'),
        societyId: asSocietyId('soc-1'),
        userId: 'user-1' as never,
        role,
        status: 'active',
        occupancyType: 'owner',
        joinedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    activeSocietyId: asSocietyId('soc-1'),
  });
}

/**
 * Edit mode: the row the loader reads, and — optionally — the row a *refetch* returns.
 *
 * The second argument is what makes the conflict flow testable the way it runs in production: the
 * conflict branch calls `refresh()`, the hook re-renders with the server's new row, and only then
 * does "Use server version" have something to load. Swapping the mock inside `refetch` mirrors that
 * ordering instead of assuming the test can mutate the row mid-assertion.
 */
function setExpenseRow(
  overrides: Parameters<typeof makeExpense>[0] = {},
  refreshed: Parameters<typeof makeExpense>[0] | null = null,
): void {
  const base = {
    id: 'exp-9',
    title: 'Lift AMC',
    amountPaise: 6_000_000,
    categoryId: 'cat-1',
    status: 'draft' as const,
    version: 5,
    createdBy: 'mem-1',
    ...overrides,
  };
  const refetch = (): void => {
    const next = refreshed === null ? base : { ...base, ...refreshed };
    mockUseExpense.mockReturnValue({
      expense: makeExpense(next),
      isLoading: false,
      error: null,
      refetch,
    });
  };
  mockParams.id = 'exp-9';
  mockUseExpense.mockReturnValue({
    expense: makeExpense(base),
    isLoading: false,
    error: null,
    refetch,
  });
}

const TITLE = () => screen.getByLabelText('Title');
const AMOUNT = () => screen.getByLabelText('Amount');

async function fillValidCreateForm(): Promise<void> {
  await fireEvent.changeText(TITLE(), 'Lift AMC — Q3');
  await fireEvent.changeText(AMOUNT(), '60,000.00');
  await fireEvent.press(screen.getByText('Maintenance'));
}

describe('create — submit', () => {
  it('sends integer paise, the default payment source, and the chosen category', async () => {
    mockCreate.mockResolvedValue(makeExpense({ id: 'exp-new', status: 'draft' }));
    await render(<ExpenseFormScreen />);
    await fillValidCreateForm();

    await fireEvent.press(screen.getByText('Save expense'));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledTimes(1));
    const payload = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.amountPaise).toBe(6_000_000);
    expect(Number.isInteger(payload.amountPaise)).toBe(true);
    expect(payload).toMatchObject({
      title: 'Lift AMC — Q3',
      categoryId: 'cat-1',
      paymentSource: 'society_account',
    });
    // An omitted strategy means "the category's defaults" — T075 owns the configurator.
    expect(payload).not.toHaveProperty('splitStrategy');
    expect(payload).not.toHaveProperty('status');
  });

  it('navigates to the expense the server created', async () => {
    mockCreate.mockResolvedValue(makeExpense({ id: 'exp-new' }));
    await render(<ExpenseFormScreen />);
    await fillValidCreateForm();

    await fireEvent.press(screen.getByText('Save expense'));

    await waitFor(() =>
      expect(mockReplace).toHaveBeenCalledWith({
        pathname: '/(app)/expenses/[id]',
        params: { id: 'exp-new' },
      }),
    );
  });

  it('refuses to submit an incomplete form, and no request is made', async () => {
    await render(<ExpenseFormScreen />);

    await fireEvent.press(screen.getByText('Save expense'));

    await waitFor(() => expect(screen.getByText('Enter a title')).toBeTruthy());
    expect(screen.getAllByText('Enter an amount like 1,23,456.78').length).toBeGreaterThan(0);
    expect(screen.getByText('Choose a category')).toBeTruthy();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('puts a server field error on the field it names', async () => {
    mockCreate.mockRejectedValue(
      new ApiError(
        422,
        'VALIDATION_ERROR',
        'That title is already used',
        undefined,
        undefined,
        undefined,
        'title',
      ),
    );
    await render(<ExpenseFormScreen />);
    await fillValidCreateForm();

    await fireEvent.press(screen.getByText('Save expense'));

    await waitFor(() => expect(screen.getByText('That title is already used')).toBeTruthy());
  });

  it('shows an unexpected failure as a form-level message', async () => {
    mockCreate.mockRejectedValue(new ApiError(500, 'INTERNAL_ERROR', 'Something broke'));
    await render(<ExpenseFormScreen />);
    await fillValidCreateForm();

    await fireEvent.press(screen.getByText('Save expense'));

    await waitFor(() => expect(screen.getByText('Something broke')).toBeTruthy());
  });
});

describe('create — duplicate taps and ambiguous failures', () => {
  it('sends one request for two taps in the same frame', async () => {
    let release: ((value: unknown) => void) | undefined;
    mockCreate.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await render(<ExpenseFormScreen />);
    await fillValidCreateForm();

    // Both presses happen before the first promise settles — the window `isPending` cannot cover.
    const button = screen.getByText('Save expense');
    await fireEvent.press(button);
    await fireEvent.press(button);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    await act(async () => {
      release?.(makeExpense({ id: 'exp-new' }));
    });
  });

  it('keeps the draft and warns about a possible duplicate when the network is unreachable', async () => {
    mockCreate.mockRejectedValue(new ApiError(0, 'NETWORK', 'Could not reach the server.'));
    const scope = { userId: 'user-1', societyId: 'soc-1', expenseId: null };
    // The autosave that has already happened — the state a real user would be in when the POST
    // fails. Nothing on the failure path may remove it.
    writeExpenseDraft(scope, { ...readOrEmpty(), title: 'Lift AMC — Q3' }, null);
    await render(<ExpenseFormScreen />);
    await fireEvent.changeText(AMOUNT(), '60,000.00');
    await fireEvent.press(screen.getByText('Maintenance'));

    await fireEvent.press(screen.getByText('Save expense'));

    await waitFor(() =>
      expect(screen.getByText(/check the ledger before saving again/i)).toBeTruthy(),
    );
    // The draft survives — and the user's own text is still on screen — so retrying is a decision
    // they make, not something the app does behind them.
    expect(readExpenseDraft(scope)).not.toBeNull();
    expect(AMOUNT().props.value).toBe('60,000.00');
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });
});

const DRAFT_SCOPE = { userId: 'user-1', societyId: 'soc-1', expenseId: null };

describe('autosave and resume', () => {
  it('writes the draft three seconds after a change, and not before', async () => {
    jest.useFakeTimers();
    await render(<ExpenseFormScreen />);
    await fireEvent.changeText(TITLE(), 'Half typed');

    await act(async () => {
      jest.advanceTimersByTime(2500);
    });
    expect(readExpenseDraft(DRAFT_SCOPE)).toBeNull();

    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(readExpenseDraft(DRAFT_SCOPE)?.values.title).toBe('Half typed');
  });

  it('does not overwrite a restored draft with empty defaults', async () => {
    jest.useFakeTimers();
    // What survived a kill: the stored draft, and nothing else.
    writeExpenseDraft(DRAFT_SCOPE, { ...readOrEmpty(), title: 'Half typed' }, null);

    await render(<ExpenseFormScreen />);
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });

    // The interval ran with the restored values, so the draft is still the user's text rather than
    // the blank form the screen would have defaulted to.
    expect(readExpenseDraft(DRAFT_SCOPE)?.values.title).toBe('Half typed');
  });

  it('restores a draft on a cold start, after the app was killed mid-form', async () => {
    writeExpenseDraft(DRAFT_SCOPE, { ...readOrEmpty(), title: 'Lift AMC — half typed' }, null);

    await render(<ExpenseFormScreen />);

    expect(TITLE().props.value).toBe('Lift AMC — half typed');
    expect(screen.getByText(/Restored the draft you had started/)).toBeTruthy();
  });

  it('clears the draft once the server confirms the create', async () => {
    mockCreate.mockResolvedValue(makeExpense({ id: 'exp-new' }));
    writeExpenseDraft(DRAFT_SCOPE, { ...readOrEmpty(), title: 'Lift AMC — Q3' }, null);
    await render(<ExpenseFormScreen />);
    await fireEvent.changeText(AMOUNT(), '60,000.00');
    await fireEvent.press(screen.getByText('Maintenance'));

    await fireEvent.press(screen.getByText('Save expense'));

    await waitFor(() => expect(readExpenseDraft(DRAFT_SCOPE)).toBeNull());
  });

  it('does not restore another user’s draft', async () => {
    // The draft belongs to a different session in the same society.
    writeExpenseDraft(
      { userId: 'user-2', societyId: 'soc-1', expenseId: null },
      { ...readOrEmpty(), title: 'Someone else’s work' },
      null,
    );

    await render(<ExpenseFormScreen />);

    expect(TITLE().props.value).toBe('');
    expect(screen.queryByText(/Restored the draft/)).toBeNull();
  });

  it('does not restore another society’s draft', async () => {
    writeExpenseDraft(
      { userId: 'user-1', societyId: 'soc-2', expenseId: null },
      { ...readOrEmpty(), title: 'Another society' },
      null,
    );

    await render(<ExpenseFormScreen />);

    expect(TITLE().props.value).toBe('');
  });

  it('discards the draft only when the user asks', async () => {
    writeExpenseDraft(DRAFT_SCOPE, { ...readOrEmpty(), title: 'Abandoned' }, null);
    await render(<ExpenseFormScreen />);
    expect(TITLE().props.value).toBe('Abandoned');

    await fireEvent.press(screen.getByText('Discard draft'));

    expect(readExpenseDraft(DRAFT_SCOPE)).toBeNull();
    expect(TITLE().props.value).toBe('');
  });
});

/** The current default values, for building a draft in a different scope. */
function readOrEmpty(): {
  title: string;
  amount: string;
  expenseDate: string;
  categoryId: string;
  description: string;
  vendorName: string;
  paymentSource: 'society_account';
  paidByMemberId: null;
} {
  return {
    title: '',
    amount: '',
    expenseDate: '2026-10-08',
    categoryId: '',
    description: '',
    vendorName: '',
    paymentSource: 'society_account',
    paidByMemberId: null,
  };
}

describe('edit — payload and lifecycle', () => {
  it('prefills from the server row', async () => {
    setExpenseRow();
    await render(<ExpenseFormScreen />);

    expect(TITLE().props.value).toBe('Lift AMC');
    expect(AMOUNT().props.value).toBe('60,000.00');
    expect(screen.getByText('₹60,000.00')).toBeTruthy();
  });

  it('sends only the changed field with the version it read', async () => {
    setExpenseRow();
    mockUpdate.mockResolvedValue(makeExpense({ id: 'exp-9', version: 6 }));
    await render(<ExpenseFormScreen />);

    await fireEvent.changeText(TITLE(), 'Lift AMC — Q4');
    await fireEvent.press(screen.getByText('Save changes'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate.mock.calls[0]?.[0]).toEqual({ title: 'Lift AMC — Q4', expectedVersion: 5 });
  });

  it('does not send a patch at all when nothing changed', async () => {
    setExpenseRow();
    await render(<ExpenseFormScreen />);

    await fireEvent.press(screen.getByText('Save changes'));

    await waitFor(() =>
      expect(screen.getByText('Nothing changed yet — edit a field before saving.')).toBeTruthy(),
    );
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('refuses to edit a published expense, and says why', async () => {
    setExpenseRow({ status: 'published' });
    await render(<ExpenseFormScreen />);

    expect(screen.getByText('This expense cannot be edited here')).toBeTruthy();
  });

  it('refuses to edit a void expense', async () => {
    setExpenseRow({ status: 'void' });
    await render(<ExpenseFormScreen />);

    expect(screen.getByText('This expense cannot be edited here')).toBeTruthy();
  });

  it('shows a conflict without overwriting either side, then writes against the server’s version', async () => {
    // The row moves on while the user is editing: version 5 is what they read, 6 is what the server
    // refuses them against, and 6 is also what a refetch returns.
    setExpenseRow({ version: 5 }, { version: 6, title: 'Theirs' });
    mockUpdate.mockRejectedValueOnce(
      new ApiError(409, 'VERSION_MISMATCH', 'The expense changed', undefined, [
        { field: 'version', code: 'VERSION_MISMATCH', message: 'stale', current: 6 },
      ]),
    );
    await render(<ExpenseFormScreen />);

    await fireEvent.changeText(TITLE(), 'Mine');
    await fireEvent.press(screen.getByText('Save changes'));

    await waitFor(() => expect(screen.getByText(/it is now version 6/)).toBeTruthy());
    // The user's text is still theirs — nothing was silently overwritten in either direction.
    expect(TITLE().props.value).toBe('Mine');

    // An explicit decision, then an explicit resubmission.
    await fireEvent.press(screen.getByText('Keep mine'));
    mockUpdate.mockResolvedValueOnce(makeExpense({ id: 'exp-9', version: 7 }));
    await fireEvent.press(screen.getByText('Save changes'));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(2));
    expect(mockUpdate.mock.calls[1]?.[0]).toEqual({ title: 'Mine', expectedVersion: 6 });
  });

  it('can load the server’s version instead, keeping no local edit', async () => {
    setExpenseRow({ version: 5 }, { version: 6, title: 'Theirs' });
    mockUpdate.mockRejectedValueOnce(
      new ApiError(409, 'VERSION_MISMATCH', 'The expense changed', undefined, [
        { field: 'version', code: 'VERSION_MISMATCH', message: 'stale', current: 6 },
      ]),
    );
    const view = await render(<ExpenseFormScreen />);
    await fireEvent.changeText(TITLE(), 'Mine');
    await fireEvent.press(screen.getByText('Save changes'));
    await waitFor(() => expect(screen.getByText(/it is now version 6/)).toBeTruthy());

    /*
      The refetch delivered the server's row. With a real React Query the query's data changes and
      the screen re-renders by itself; here `useExpense` is a mock, so the re-render that a data
      update would cause is made explicitly. Everything below is production code reading it.
    */
    await view.rerender(<ExpenseFormScreen />);
    await fireEvent.press(screen.getByText('Use server version'));

    await waitFor(() => expect(TITLE().props.value).toBe('Theirs'));
  });

  it('does not restore a draft written against a version the expense has left', async () => {
    setExpenseRow({ version: 5 });
    writeExpenseDraft(
      { userId: 'user-1', societyId: 'soc-1', expenseId: 'exp-9' },
      { ...readOrEmpty(), title: 'Drafted against version 4' },
      4,
    );

    await render(<ExpenseFormScreen />);

    expect(TITLE().props.value).toBe('Lift AMC');
    expect(screen.getByText(/the draft was not restored/)).toBeTruthy();
  });

  it('restores a draft written against the version the server still holds', async () => {
    setExpenseRow({ version: 5 });
    writeExpenseDraft(
      { userId: 'user-1', societyId: 'soc-1', expenseId: 'exp-9' },
      { ...readOrEmpty(), title: 'Mine, mid-edit' },
      5,
    );

    await render(<ExpenseFormScreen />);

    expect(TITLE().props.value).toBe('Mine, mid-edit');
  });
});

describe('authorization', () => {
  it('denies the create screen to a Resident', async () => {
    setSession('resident');
    await render(<ExpenseFormScreen />);

    expect(screen.getByText('Permission denied')).toBeTruthy();
    expect(screen.queryByText('Save expense')).toBeNull();
  });

  it('lets a Committee Member create a draft', async () => {
    setSession('committee_member');
    await render(<ExpenseFormScreen />);

    expect(screen.getByText('Save expense')).toBeTruthy();
  });

  it('denies editing another member’s draft to a Committee Member', async () => {
    setSession('committee_member');
    setExpenseRow({ createdBy: 'mem-9' });
    await render(<ExpenseFormScreen />);

    expect(screen.getByText('Permission denied')).toBeTruthy();
  });

  it('lets a Committee Member edit their own draft', async () => {
    setSession('committee_member');
    setExpenseRow({ createdBy: 'mem-1' });
    await render(<ExpenseFormScreen />);

    expect(screen.getByText('Save changes')).toBeTruthy();
  });
});

interface JsonNode {
  readonly type?: unknown;
  readonly props?: Record<string, unknown>;
  readonly children?: unknown;
}

/** Every host node, with the chain above it — the only way to assert *placement* in RNTL. */
function walkTree(
  node: unknown,
  ancestors: readonly JsonNode[] = [],
  out: { readonly node: JsonNode; readonly ancestors: readonly JsonNode[] }[] = [],
): { readonly node: JsonNode; readonly ancestors: readonly JsonNode[] }[] {
  if (node === null || typeof node !== 'object') return out;
  const current = node as JsonNode;
  out.push({ node: current, ancestors });
  const children = Array.isArray(current.children) ? current.children : [];
  for (const child of children) walkTree(child, [...ancestors, current], out);
  return out;
}

describe('layout and keyboard', () => {
  it('is one scrollable form, with the amount outside the scrolling region and taps handled', async () => {
    await render(<ExpenseFormScreen />);
    const nodes = walkTree(screen.toJSON());

    // Exactly one scrolling region: a single screen, not a wizard (PRD §3.4).
    const scrolls = nodes.filter(
      (entry) => entry.node.props?.keyboardShouldPersistTaps !== undefined,
    );
    expect(scrolls).toHaveLength(1);
    const scroll = scrolls[0];

    // A tap on Save while the keyboard is open saves; it does not merely dismiss the keyboard.
    expect(scroll?.node.props?.keyboardShouldPersistTaps).toBe('handled');
    expect(scroll?.node.props?.keyboardDismissMode).toBe('on-drag');

    // The amount field is in the sticky header — outside the scrolling region, so it cannot scroll
    // away — and the submit button is inside it, so it scrolls into view with the fields.
    const amount = nodes.find((entry) => entry.node.props?.accessibilityLabel === 'Amount');
    expect(amount).toBeDefined();
    expect(amount?.ancestors).not.toContain(scroll?.node);

    const submit = nodes.find(
      (entry) => Array.isArray(entry.node.children) && entry.node.children.includes('Save expense'),
    );
    expect(submit).toBeDefined();
    expect(submit?.ancestors).toContain(scroll?.node);
  });
});
