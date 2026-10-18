import { act, render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { asMemberId, asSocietyId } from '@ses/domain';
import type { MemberRole } from '@ses/domain';
import { Alert, Linking } from 'react-native';

import { useSocietyStore } from '@/stores/society.store';

import {
  makeAttachment,
  makeComment,
  makeExpense,
  makeRevision,
  makeSplit,
} from '../__fixtures__/expense-fixtures';

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: 'e1' }),
  // The screen offers an Edit action (T074) through `router.push`; the mock must supply the hook
  // the screen calls, even though the mocked `Stack.Screen` never renders the button itself.
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock('../hooks/use-expenses', () => ({
  useExpenseCategoryNames: () => ({
    names: new Map<string, string>([['cat-1', 'Maintenance']]),
  }),
}));

jest.mock('../hooks/use-expense', () => ({
  useExpense: jest.fn(),
  useExpenseSplits: jest.fn(),
  useExpenseRevisions: jest.fn(),
  useExpenseComments: jest.fn(),
  useExpenseAttachments: jest.fn(),
  fetchAttachmentDownloadUrl: jest.fn(),
}));

// The publish mutation is mocked at the hook seam, like every other write on this screen: the
// hook's own contract (the idempotency key, the scope) is `use-expense-actions.test.ts`'s.
jest.mock('../hooks/use-expense-actions', () => ({
  usePublishExpense: jest.fn(),
}));

import {
  fetchAttachmentDownloadUrl,
  useExpense,
  useExpenseAttachments,
  useExpenseComments,
  useExpenseRevisions,
  useExpenseSplits,
} from '../hooks/use-expense';
import { usePublishExpense } from '../hooks/use-expense-actions';
import ExpenseDetailScreen from '../screens/ExpenseDetailScreen';

const mockExpense = useExpense as jest.Mock;
const mockSplits = useExpenseSplits as jest.Mock;
const mockRevisions = useExpenseRevisions as jest.Mock;
const mockComments = useExpenseComments as jest.Mock;
const mockAttachments = useExpenseAttachments as jest.Mock;
const mockDownload = fetchAttachmentDownloadUrl as jest.Mock;
const mockPublish = usePublishExpense as jest.Mock;

/**
 * The session the screen gates against: an active membership in the active society.
 *
 * Awaited (`act(async …)`) because these tests change the session *after* a render: a Zustand
 * `setState` re-renders the subscribing screen, and the store's persisted `setState` answers a
 * thenable — so an un-awaited `act` would warn and the update would not be applied before the
 * next assertion.
 */
async function setSession(role: MemberRole): Promise<void> {
  await act(async () => {
    await useSocietyStore.setState({
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
  });
}

function setDetail(overrides: {
  expense?: unknown;
  splits?: unknown[];
  revisions?: unknown[];
  comments?: unknown[];
  attachments?: unknown[];
  isLoading?: boolean;
  error?: unknown;
}): void {
  mockExpense.mockReturnValue({
    expense: 'expense' in overrides ? overrides.expense : makeExpense(),
    isLoading: overrides.isLoading ?? false,
    error: overrides.error ?? null,
    refetch: jest.fn(),
  });
  mockSplits.mockReturnValue({ splits: overrides.splits ?? [], isLoading: false, error: null });
  mockRevisions.mockReturnValue({
    revisions: overrides.revisions ?? [],
    isLoading: false,
    error: null,
  });
  mockComments.mockReturnValue({
    comments: overrides.comments ?? [],
    isLoading: false,
    error: null,
  });
  mockAttachments.mockReturnValue({
    attachments: overrides.attachments ?? [],
    isLoading: false,
    error: null,
  });
}

describe('ExpenseDetailScreen', () => {
  it('shows a loading state while the header loads', async () => {
    setDetail({ isLoading: true });
    await render(<ExpenseDetailScreen />);
    expect(screen.getByText('Loading expense…')).toBeTruthy();
  });

  it('shows a not-available state when the expense is absent', async () => {
    setDetail({ expense: null });
    await render(<ExpenseDetailScreen />);
    expect(screen.getByText('Expense not available')).toBeTruthy();
  });

  it('renders the amount, category and status', async () => {
    setDetail({});
    await render(<ExpenseDetailScreen />);

    expect(screen.getByText('Lift AMC')).toBeTruthy();
    expect(screen.getByText('₹45,000.00')).toBeTruthy();
    expect(screen.getByText('30 Sep 2026 · Maintenance')).toBeTruthy();
    expect(screen.getByText('Published')).toBeTruthy();
  });

  it('renders the split table and the comment stream', async () => {
    setDetail({
      splits: [
        makeSplit({ id: 's1', apartmentNumber: 'A1', amountPaise: 1_500_000 }),
        makeSplit({ id: 's2', apartmentNumber: 'A2', amountPaise: 1_500_000 }),
      ],
      comments: [makeComment({ id: 'c1', body: 'Paid by cheque' })],
      expense: makeExpense({ amountPaise: 3_000_000 }),
    });
    await render(<ExpenseDetailScreen />);

    expect(screen.getByText('A1')).toBeTruthy();
    expect(screen.getByText('Total · 2 flats')).toBeTruthy();
    expect(screen.getByText('Paid by cheque')).toBeTruthy();
  });

  it('lists bills with their scan status rather than implying they are verified', async () => {
    setDetail({ attachments: [makeAttachment({ id: 'att-1', scanStatus: 'pending' })] });
    await render(<ExpenseDetailScreen />);

    expect(screen.getByText('bill.jpg')).toBeTruthy();
    // A pending file is labelled as not yet scanned — never as verified-safe.
    expect(screen.getByText('2.0 KB · Not yet security-scanned')).toBeTruthy();
  });

  it('opens a short-lived URL when a bill is downloaded', async () => {
    const openSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    mockDownload.mockResolvedValue('https://storage.example/signed');
    setDetail({ attachments: [makeAttachment({ id: 'att-1' })] });
    await render(<ExpenseDetailScreen />);

    await fireEvent.press(screen.getByText('Download'));

    await waitFor(() => expect(mockDownload).toHaveBeenCalledWith('att-1'));
    expect(openSpy).toHaveBeenCalledWith('https://storage.example/signed');
    openSpy.mockRestore();
  });

  it('reveals the revision history when the chip is pressed', async () => {
    setDetail({
      revisions: [makeRevision({ id: 'r1', version: 1, changeNote: 'Corrected the amount' })],
    });
    await render(<ExpenseDetailScreen />);

    expect(screen.queryByText('Revision history')).toBeNull();
    await fireEvent.press(screen.getByText('Edited · 1 revision'));
    expect(screen.getByText('Revision history')).toBeTruthy();
    expect(screen.getByText('Version 1 → 2')).toBeTruthy();
  });

  /*
    Publishing (T077). The gate is the matrix's own `expense.publish` cell, evaluated
    through the real `can()`; the mutation itself is mocked, because what this screen owns
    is *when* it offers the action and what it does with the answer.
  */
  describe('publishing', () => {
    const summary = {
      participantCount: 2,
      totalPaise: 3_000_000,
      minPaise: 1_500_000,
      maxPaise: 1_500_000,
    };

    /** Accepts the confirmation for the caller, so a press reaches the mutation. */
    function confirmAlerts(): jest.SpyInstance {
      return jest.spyOn(Alert, 'alert').mockImplementation(((_title, _message, buttons) => {
        buttons?.find((button) => button.text === 'Publish')?.onPress?.();
      }) as typeof Alert.alert);
    }

    it('offers Publish to the two roles the matrix allows, and not on a published row', async () => {
      mockPublish.mockReturnValue({ isPending: false, mutateAsync: jest.fn() });

      await setSession('admin');
      setDetail({ expense: makeExpense({ status: 'draft', version: 3 }) });
      await render(<ExpenseDetailScreen />);
      expect(screen.getByText('Publish expense')).toBeTruthy();

      await setSession('treasurer');
      setDetail({ expense: makeExpense({ status: 'pending_approval', version: 2 }) });
      await render(<ExpenseDetailScreen />);
      expect(screen.getByText('Publish expense')).toBeTruthy();

      // A published row is not publishable again — the button is absent, not merely refused.
      await setSession('admin');
      setDetail({ expense: makeExpense({ status: 'published' }) });
      await render(<ExpenseDetailScreen />);
      expect(screen.queryByText('Publish expense')).toBeNull();
    });

    /*
      A `void` row is the other terminal state, and it is the one a careless gate gets wrong:
      `void` is neither `published` nor publishable, so a check written as `status !== 'published'`
      would offer the button on a bill that has already been reversed. The server refuses it (the
      definer re-checks the lifecycle under the row lock), but the screen must not offer it.
    */
    it('never offers Publish on a void row', async () => {
      mockPublish.mockReturnValue({ isPending: false, mutateAsync: jest.fn() });
      await setSession('admin');
      setDetail({ expense: makeExpense({ status: 'void' }) });
      await render(<ExpenseDetailScreen />);

      expect(screen.queryByText('Publish expense')).toBeNull();
    });

    // One test per role rather than a loop: each role is a separate claim, and a loop that
    // re-rendered under a moving session would be asserting four renders inside one case.
    it.each(['resident', 'committee_member', 'tenant', 'guest'] as const)(
      'hides Publish from a %s',
      async (role) => {
        mockPublish.mockReturnValue({ isPending: false, mutateAsync: jest.fn() });
        await setSession(role);
        setDetail({ expense: makeExpense({ status: 'draft' }) });
        await render(<ExpenseDetailScreen />);
        expect(screen.queryByText('Publish expense')).toBeNull();
      },
    );

    it('publishes the row\u2019s version and renders the summary the server measured', async () => {
      const mutateAsync = jest.fn().mockResolvedValue({
        expense: makeExpense({ status: 'published' }),
        splitSummary: summary,
      });
      mockPublish.mockReturnValue({ isPending: false, mutateAsync });
      const alert = confirmAlerts();
      await setSession('treasurer');
      setDetail({ expense: makeExpense({ status: 'draft', version: 7 }) });
      await render(<ExpenseDetailScreen />);

      await fireEvent.press(screen.getByText('Publish expense'));

      // The optimistic lock is the rendered row's version, never a default.
      await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ expectedVersion: 7 }));
      expect(alert).toHaveBeenCalled();
      expect(await screen.findByText('Published 2 shares totalling ₹30,000.00.')).toBeTruthy();
      alert.mockRestore();
    });

    it('renders the server\u2019s refusal instead of a success state', async () => {
      const mutateAsync = jest.fn().mockRejectedValue({
        message: 'This expense needs an Admin\u2019s approval before it can be published.',
      });
      mockPublish.mockReturnValue({ isPending: false, mutateAsync });
      const alert = confirmAlerts();
      await setSession('admin');
      setDetail({ expense: makeExpense({ status: 'pending_approval', version: 2 }) });
      await render(<ExpenseDetailScreen />);

      await fireEvent.press(screen.getByText('Publish expense'));

      expect(
        await screen.findByText(
          'This expense needs an Admin\u2019s approval before it can be published.',
        ),
      ).toBeTruthy();
      expect(screen.queryByText(/^Published /)).toBeNull();
      alert.mockRestore();
    });
  });
});
