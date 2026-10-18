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
const mockPublishExpense = jest.fn();

jest.mock('../services/expense.service', () => ({
  createExpense: (...args: unknown[]) => mockCreateExpense(...args),
  updateExpense: (...args: unknown[]) => mockUpdateExpense(...args),
  publishExpense: (...args: unknown[]) => mockPublishExpense(...args),
}));

import {
  useCreateExpense,
  usePublishExpense,
  useUpdateExpense,
} from '../hooks/use-expense-actions';

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

/**
 * `usePublishExpense` (T077) — the one write whose **retry identity** the client owns.
 *
 * The screen's tests cover the button and the response rendering; what matters here is the
 * part a screen cannot show: that the key is minted per operation and **reused** while the
 * same operation is being retried, which is the whole reason SAD §7.7 puts a key on the wire.
 * The `expo-crypto` double in `jest.setup.ts` returns an incrementing uuid, so a test can tell
 * a replay from a new operation by the value itself.
 */
describe('usePublishExpense', () => {
  const publication = {
    expense: makeExpense({ id: 'exp-9', status: 'published' }),
    splitSummary: {
      participantCount: 2,
      totalPaise: 3_000_000,
      minPaise: 1_500_000,
      maxPaise: 1_500_000,
    },
  };

  it('publishes through the session\u2019s society and invalidates the expense namespace', async () => {
    mockPublishExpense.mockResolvedValue(publication);
    const { result } = await renderHook(() => usePublishExpense('exp-9'), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ expectedVersion: 4 });
    });

    expect(mockPublishExpense).toHaveBeenCalledWith(
      'user-1',
      'soc-1',
      'exp-9',
      { expectedVersion: 4 },
      expect.any(String),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: expenseKeys.all });
  });

  it('reuses the key for a retry of the same attempt, and mints a new one after it commits', async () => {
    mockPublishExpense
      .mockRejectedValueOnce(new Error('the response was lost'))
      .mockResolvedValue(publication);
    const { result } = await renderHook(() => usePublishExpense('exp-9'), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync({ expectedVersion: 1 })).rejects.toThrow(
        'the response was lost',
      );
    });
    await act(async () => {
      await result.current.mutateAsync({ expectedVersion: 1 });
    });
    await act(async () => {
      await result.current.mutateAsync({ expectedVersion: 1 });
    });

    const keys = mockPublishExpense.mock.calls.map((call) => call[4] as string);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('keeps the key after a refusal, so the next attempt is a replay of it', async () => {
    mockPublishExpense.mockRejectedValue(new Error('APPROVAL_REQUIRED'));
    const { result } = await renderHook(() => usePublishExpense('exp-9'), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync({ expectedVersion: 1 })).rejects.toThrow(
        'APPROVAL_REQUIRED',
      );
    });
    await act(async () => {
      await expect(result.current.mutateAsync({ expectedVersion: 1 })).rejects.toThrow(
        'APPROVAL_REQUIRED',
      );
    });

    const keys = mockPublishExpense.mock.calls.map((call) => call[4] as string);
    expect(keys[0]).toBe(keys[1]);
    expect(invalidate).not.toHaveBeenCalled();
  });

  /*
    Overlapping taps are one operation, not two.

    The confirmation dialog is the only thing between a double tap and two submissions, so this
    pins what happens when both get through: the second call must carry the **same** key, which
    makes it the API's replay (the stored publication) or its refusal — never a second publication.
    The key is only rotated in `onSuccess`, so it cannot move between two calls that have not
    committed yet; a rotation on *send* would turn the second tap into a fresh operation, which is
    exactly the duplicate bill SAD §7.7's mandatory key exists to prevent.
  */
  it('sends one key when two taps overlap', async () => {
    const keys: string[] = [];
    const pending: (() => void)[] = [];
    mockPublishExpense.mockImplementation(
      (_actor: string, _society: string, _id: string, _payload: unknown, key: string) => {
        keys.push(key);
        return new Promise((resolve) => {
          pending.push(() => resolve(publication));
        });
      },
    );
    const { result } = await renderHook(() => usePublishExpense('exp-9'), { wrapper });

    await act(async () => {
      const first = result.current.mutateAsync({ expectedVersion: 2 });
      const second = result.current.mutateAsync({ expectedVersion: 2 });
      // Bounded, so a call that never happens fails the assertion below instead of hanging.
      for (let tick = 0; tick < 20 && pending.length < 2; tick += 1) {
        await Promise.resolve();
      }
      for (const resolve of pending) resolve();
      await Promise.all([first, second]);
    });

    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('refuses to publish with no expense id, without calling the API', async () => {
    const { result } = await renderHook(() => usePublishExpense(null), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync({ expectedVersion: 1 })).rejects.toThrow(
        /not available/i,
      );
    });
    expect(mockPublishExpense).not.toHaveBeenCalled();
  });
});
