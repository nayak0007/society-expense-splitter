import { render, screen, fireEvent } from '@testing-library/react-native';

import { makeExpense, makeGroup } from '../__fixtures__/expense-fixtures';

/**
 * `FlashList` is replaced with a renderer that mounts every row, so a test asserts what the
 * screen *builds* (the grouped rows) rather than what the list would virtualise. The props of
 * the last render are stashed on the mock so the pagination callback can be invoked directly.
 *
 * The prop shape is written inline rather than as a named interface: Jest hoists `jest.mock`
 * above the module, and its guard rejects a factory that references any out-of-scope binding —
 * including a type alias it cannot see is a type.
 */
jest.mock('@shopify/flash-list', () => {
  const React = require('react') as typeof import('react');
  const { View } = require('react-native') as typeof import('react-native');

  const FlashList = (props: {
    readonly data?: readonly unknown[];
    readonly renderItem?: (info: { item: unknown; index: number }) => unknown;
    readonly keyExtractor?: (item: unknown, index: number) => string;
    readonly ListEmptyComponent?: unknown;
    readonly ListFooterComponent?: unknown;
  }) => {
    (FlashList as unknown as { props: unknown }).props = props;
    const children = (props.data ?? []).map((item, index) =>
      React.createElement(
        View,
        {
          key: props.keyExtractor === undefined ? String(index) : props.keyExtractor(item, index),
        },
        (props.renderItem === undefined ? null : props.renderItem({ item, index })) as never,
      ),
    );
    const empty = (props.data ?? []).length === 0 ? props.ListEmptyComponent : null;
    return React.createElement(
      View,
      null,
      ...children,
      empty as never,
      props.ListFooterComponent as never,
    );
  };
  (FlashList as unknown as { props: unknown }).props = null;

  return { FlashList };
});

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ push: mockPush }),
}));

jest.mock('../hooks/use-expenses', () => ({
  useExpenses: jest.fn(),
  useExpenseCategoryNames: jest.fn(() => ({
    names: new Map<string, string>([['cat-1', 'Maintenance']]),
  })),
  useExpenseBuildingOptions: jest.fn(() => ({
    buildings: [{ id: 'bld-1', name: 'North Block' }],
  })),
}));

import ExpenseListScreen from '../screens/ExpenseListScreen';
import { useExpenses } from '../hooks/use-expenses';
import { makePerfExpenses, makePerfPages } from '../__fixtures__/expense-perf-fixture';

/**
 * The real month grouping, which the module mock above replaces along with the hook. The mock is
 * `use-expenses`'s *hook* surface; the pure projection beside it is this screen's actual work, so
 * the scale test must run the real one.
 */
const { groupExpensesByMonth } =
  jest.requireActual<typeof import('../hooks/use-expenses')>('../hooks/use-expenses');

const mockUseExpenses = useExpenses as jest.Mock;

function setListState(overrides: Record<string, unknown>): void {
  mockUseExpenses.mockReturnValue({
    expenses: [],
    groups: [],
    isLoading: false,
    isRefreshing: false,
    isLoadingMore: false,
    hasMore: false,
    error: null,
    refetch: jest.fn(),
    loadMore: jest.fn(),
    ...overrides,
  });
}

describe('ExpenseListScreen', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('shows a loading state on first load', async () => {
    setListState({ isLoading: true });
    await render(<ExpenseListScreen />);
    expect(screen.getByText('Loading expenses…')).toBeTruthy();
  });

  it('shows an error state when the first page fails', async () => {
    setListState({ error: new Error('Network down') });
    await render(<ExpenseListScreen />);
    expect(screen.getByText('Could not load expenses')).toBeTruthy();
    expect(screen.getByText('Network down')).toBeTruthy();
  });

  it('shows an empty state when there are no expenses', async () => {
    setListState({});
    await render(<ExpenseListScreen />);
    expect(screen.getByText('No expenses yet')).toBeTruthy();
  });

  it('renders month headers and rows, with the category name resolved', async () => {
    setListState({
      groups: [
        makeGroup({
          key: '2026-09',
          label: 'September 2026',
          totalPaise: 4_500_000,
          expenses: [makeExpense({ id: 'e1', title: 'Lift AMC', categoryId: 'cat-1' })],
        }),
      ],
    });
    await render(<ExpenseListScreen />);

    expect(screen.getByText('September 2026')).toBeTruthy();
    expect(screen.getByText('Lift AMC')).toBeTruthy();
    expect(screen.getByText('1 · ₹45,000.00')).toBeTruthy();
    expect(screen.getByText('30 Sep 2026 · Maintenance')).toBeTruthy();
  });

  it('pushes the detail route when a row is tapped', async () => {
    setListState({
      groups: [makeGroup({ expenses: [makeExpense({ id: 'e1' })] })],
    });
    await render(<ExpenseListScreen />);

    await fireEvent.press(screen.getByText('Lift AMC'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/(app)/expenses/[id]',
      params: { id: 'e1' },
    });
  });

  it('asks for the next page when the list end is reached', async () => {
    const loadMore = jest.fn();
    setListState({ groups: [makeGroup()], hasMore: true, loadMore });
    await render(<ExpenseListScreen />);

    const list = jest.requireMock('@shopify/flash-list') as {
      FlashList: { props: { onEndReached?: () => void } | null };
    };
    list.FlashList.props?.onEndReached?.();
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('reveals the filter panel on demand', async () => {
    setListState({});
    await render(<ExpenseListScreen />);

    expect(screen.queryByText('Status')).toBeNull();
    await fireEvent.press(screen.getByText('Filter expenses'));
    expect(screen.getByText('Status')).toBeTruthy();
  });

  /**
   * The **1 000-expense scale render**, timed.
   *
   * The `FlashList` double above mounts every row instead of virtualising, so this is a genuine
   * end-to-end mount of all 1 000 `ExpenseCard`s plus 24 month headers through the real screen —
   * the strongest statement available without a device. It is still **not** the Roadmap's fps
   * criterion (this renderer is not a UI thread, and it mounts everything at once where FlashList
   * would recycle a screenful); the fps claim stays UNVERIFIED per the feature `README.md`.
   *
   * `process.hrtime.bigint()` because the React Native Jest preset mocks the global `performance`
   * with a constant `now()`. The budget is a coarse tripwire, not a frame budget: the purpose is
   * to catch an accidental O(n²) in grouping or projection, which would push this into the minutes.
   */
  it('mounts the whole 1,000-expense projection within a coarse regression budget', async () => {
    const groups = groupExpensesByMonth(makePerfPages(1_000, 25));
    setListState({ groups });

    const startedAt = process.hrtime.bigint();
    await render(<ExpenseListScreen />);
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

    // The text search proves the work was real: the newest fixture row's title is on screen.
    expect(screen.getByText(makePerfExpenses(1)[0]?.title ?? '')).toBeTruthy();
    const list = jest.requireMock('@shopify/flash-list') as {
      FlashList: { props: { data?: readonly unknown[] } | null };
    };
    expect(list.FlashList.props?.data).toHaveLength(1_000 + groups.length);
    // eslint-disable-next-line no-console -- the measurement IS the output of this test.
    console.log(`[perf] ExpenseListScreen mount over 1,000 expenses: ${elapsedMs.toFixed(1)} ms`);
    expect(elapsedMs).toBeLessThan(60_000);
  });
});
