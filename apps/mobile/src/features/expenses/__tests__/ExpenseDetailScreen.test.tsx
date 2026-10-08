import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';

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

import ExpenseDetailScreen from '../screens/ExpenseDetailScreen';
import {
  fetchAttachmentDownloadUrl,
  useExpense,
  useExpenseAttachments,
  useExpenseComments,
  useExpenseRevisions,
  useExpenseSplits,
} from '../hooks/use-expense';

const mockExpense = useExpense as jest.Mock;
const mockSplits = useExpenseSplits as jest.Mock;
const mockRevisions = useExpenseRevisions as jest.Mock;
const mockComments = useExpenseComments as jest.Mock;
const mockAttachments = useExpenseAttachments as jest.Mock;
const mockDownload = fetchAttachmentDownloadUrl as jest.Mock;

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
});
