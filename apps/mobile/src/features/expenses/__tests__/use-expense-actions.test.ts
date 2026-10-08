import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import { asSocietyId } from '@ses/domain';
import type { ReactNode } from 'react';
import { createElement } from 'react';

import { useAuthStore } from '@/stores/auth.store';
import { useSocietyStore } from '@/stores/society.store';

import { makeExpense } from '../__fixtures__/expense-fixtures';
import { expenseKeys } from '../hooks/expense-keys';

/**
 * The write hooks (Roadmap T074 §5, §6, §12).
 *
 * What matters here is not that a request is made — the screen's tests cover the payload — but the
 * two things a screen cannot show: that the **scope** comes from the session rather than an
 * argument, and that a successful write invalidates the whole `expense` namespace so the ledger and
 * the detail refetch rather than showing a stale row.
 */
const mockCreateExpense = jest.fn();
const mockUpdateExpense = jest.fn();

jest.mock('../services/expense.service', () => ({
  createExpense: (...args: unknown[]) => mockCreateExpense(...args),
  updateExpense: (...args: unknown[]) => mockUpdateExpense(...args),
}));

import { useCreateExpense, useUpdateExpense } from '../hooks/use-expense-actions';

let queryClient: QueryClient;
let invalidate: jest.SpyInstance;

beforeEach(() => {
  mockCreateExpense.mockReset().mockResolvedValue(makeExpense({ id: 'exp-new' }));
  mockUpdateExpense.mockReset().mockResolvedValue(makeExpense({ id: 'exp-9', version: 6 }));
  queryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false, gcTime: 0 },
      queries: { retry: false, gcTime: 0 },
    },
  });
  invalidate = jest.spyOn(queryClient, 'invalidateQueries');

  useAuthStore.setState({ user: { id: 'user-1', email: null } });
  useSocietyStore.setState({
    memberships: [],
    activeSocietyId: asSocietyId('soc-1'),
  });
});

afterEach(() => {
  // The notify manager schedules a timer for each cache update; tearing the client down keeps the
  // worker from being left with an open handle (which would hang the suite rather than fail it).
  queryClient.clear();
  queryClient.unmount();
});

function wrapper({ children }: { readonly children: ReactNode }): ReactNode {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

describe('useCreateExpense', () => {
  it('writes through the session’s society and invalidates the expense namespace', async () => {
    const { result } = await renderHook(() => useCreateExpense(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        title: 'Lift AMC',
        amountPaise: 6_000_000,
        expenseDate: '2026-10-08',
        categoryId: 'cat-1',
      });
    });

    // The actor is the session's user and the tenant the active society — neither is an argument a
    // screen could get wrong.
    expect(mockCreateExpense).toHaveBeenCalledWith(
      'user-1',
      'soc-1',
      expect.objectContaining({ title: 'Lift AMC' }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: expenseKeys.all });
  });

  it('refuses to write with no session, without calling the API', async () => {
    useAuthStore.setState({ user: null });
    const { result } = await renderHook(() => useCreateExpense(), { wrapper });

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          title: 'x',
          amountPaise: 1,
          expenseDate: '2026-10-08',
          categoryId: 'cat-1',
        }),
      ).rejects.toThrow(/session expired/i);
    });
    expect(mockCreateExpense).not.toHaveBeenCalled();
  });
});

describe('useUpdateExpense', () => {
  it('carries the version the caller read and invalidates on success', async () => {
    const { result } = await renderHook(() => useUpdateExpense('exp-9'), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ title: 'Lift AMC — Q4', expectedVersion: 5 });
    });

    expect(mockUpdateExpense).toHaveBeenCalledWith('user-1', 'soc-1', 'exp-9', {
      title: 'Lift AMC — Q4',
      expectedVersion: 5,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: expenseKeys.all });
  });

  it('does not invalidate anything when the write fails', async () => {
    mockUpdateExpense.mockRejectedValue(new Error('stale'));
    const { result } = await renderHook(() => useUpdateExpense('exp-9'), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync({ title: 'x', expectedVersion: 1 })).rejects.toThrow(
        'stale',
      );
    });

    expect(invalidate).not.toHaveBeenCalled();
  });

  it('refuses to write with no expense id', async () => {
    const { result } = await renderHook(() => useUpdateExpense(null), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync({ title: 'x', expectedVersion: 1 })).rejects.toThrow(
        /not available/i,
      );
    });
    expect(mockUpdateExpense).not.toHaveBeenCalled();
  });
});
