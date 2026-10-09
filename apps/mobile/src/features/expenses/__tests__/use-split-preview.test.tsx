import { onlineManager } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react-native';
import { asSocietyId } from '@ses/domain';
import type { PreviewSplitResponseDto } from '@ses/contracts';

import { useAuthStore } from '@/stores/auth.store';
import { useSocietyStore } from '@/stores/society.store';

/**
 * The live preview hook (T075 §4, §5): debounce, out-of-order safety, offline honesty.
 *
 * The network is mocked (the loader and the error classifier) and time is faked; the
 * hook's own machinery — the monotonic request id, the `AbortController`, the kept last
 * good preview, the offline gate — is real production code.
 */
const mockLoadSplitPreview = jest.fn();
let mockErrorMessage = 'The server refused that split.';

jest.mock('../services/expense.service', () => ({
  loadSplitPreview: (...args: unknown[]) =>
    mockLoadSplitPreview(...args) as Promise<PreviewSplitResponseDto>,
  expenseErrorMessage: () => mockErrorMessage,
}));

jest.mock('@/lib/api/api-client', () => ({
  isNetworkError: (error: unknown) => (error as { reason?: string }).reason === 'network',
}));

import { SPLIT_PREVIEW_DEBOUNCE_MS, useSplitPreview } from '../hooks/use-split-preview';
import type { OfflinePlan } from '../split/offline-preview';
import { setOfflineSnapshot, resetOfflineSnapshot } from '../services/offline-snapshot.store';

const PLAN: OfflinePlan = { strategy: 'equal', basis: null };
const CONFIG = {};
const SELECTOR = {};

function response(totalPaise: number): PreviewSplitResponseDto {
  return {
    totalPaise,
    participantCount: 1,
    allocations: [
      {
        memberId: 'm1',
        apartmentId: 'ap1',
        apartmentNumber: 'A-101',
        weight: 1,
        amountPaise: totalPaise,
      },
    ],
    residualPaise: 0,
    warnings: [],
    unassigned: [],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function params(
  overrides: Partial<Parameters<typeof useSplitPreview>[0]> = {},
): Parameters<typeof useSplitPreview>[0] {
  return {
    amountPaise: 10_000,
    categoryId: 'cat-1',
    plan: PLAN,
    config: CONFIG,
    selector: SELECTOR,
    selectorKey: 'sel-1',
    enabled: true,
    ...overrides,
  };
}

/** Advance past the debounce and flush the resulting promise microtasks. */
async function settleDebounce(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(SPLIT_PREVIEW_DEBOUNCE_MS);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockLoadSplitPreview.mockReset();
  mockErrorMessage = 'The server refused that split.';
  resetOfflineSnapshot();
  onlineManager.setOnline(true);
  useAuthStore.setState({ user: { id: 'user-1', email: null } });
  useSocietyStore.setState({ memberships: [], activeSocietyId: asSocietyId('soc-1') });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useSplitPreview — debounce', () => {
  it('does not fire on the first render, and fires once the pause elapses', async () => {
    mockLoadSplitPreview.mockResolvedValue(response(10_000));
    const { result } = await renderHook(() => useSplitPreview(params()));

    expect(mockLoadSplitPreview).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(SPLIT_PREVIEW_DEBOUNCE_MS - 1);
    });
    expect(mockLoadSplitPreview).not.toHaveBeenCalled();

    await settleDebounce();
    expect(mockLoadSplitPreview).toHaveBeenCalledTimes(1);
    expect(result.current.preview?.totalPaise).toBe(10_000);
    expect(result.current.source).toBe('online');
  });

  it('collapses a burst of edits into one request', async () => {
    mockLoadSplitPreview.mockResolvedValue(response(10_000));
    const { rerender } = await renderHook(
      (props: { amountPaise: number }) =>
        useSplitPreview(params({ amountPaise: props.amountPaise })),
      {
        initialProps: { amountPaise: 10_000 },
      },
    );

    for (const amount of [11_000, 12_000, 13_000]) {
      await rerender({ amountPaise: amount });
      await act(async () => {
        jest.advanceTimersByTime(100);
      });
    }

    expect(mockLoadSplitPreview).not.toHaveBeenCalled();

    await settleDebounce();
    expect(mockLoadSplitPreview).toHaveBeenCalledTimes(1);
    const request = mockLoadSplitPreview.mock.calls[0]?.[2] as { amountPaise: number };
    expect(request.amountPaise).toBe(13_000);
  });

  it('makes no request while the form has no amount', async () => {
    const { result } = await renderHook(() => useSplitPreview(params({ amountPaise: null })));

    await settleDebounce();

    expect(mockLoadSplitPreview).not.toHaveBeenCalled();
    expect(result.current.preview).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });
});

describe('useSplitPreview — ordering and cancellation', () => {
  it('drops a slow earlier answer instead of letting it overwrite a later one', async () => {
    const first = deferred<PreviewSplitResponseDto>();
    const second = deferred<PreviewSplitResponseDto>();
    mockLoadSplitPreview.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result, rerender } = await renderHook(
      (props: { amountPaise: number }) =>
        useSplitPreview(params({ amountPaise: props.amountPaise })),
      { initialProps: { amountPaise: 10_000 } },
    );

    await settleDebounce();
    expect(mockLoadSplitPreview).toHaveBeenCalledTimes(1);

    await rerender({ amountPaise: 20_000 });
    await settleDebounce();
    expect(mockLoadSplitPreview).toHaveBeenCalledTimes(2);

    // The later request has taken over: the earlier one's controller was aborted.
    const firstRequest = mockLoadSplitPreview.mock.calls[0]?.[2] as { signal: AbortSignal };
    expect(firstRequest.signal.aborted).toBe(true);

    await act(async () => {
      second.resolve(response(20_000));
    });
    expect(result.current.preview?.totalPaise).toBe(20_000);

    // The stale answer arrives last — and is discarded.
    await act(async () => {
      first.resolve(response(10_000));
    });
    expect(result.current.preview?.totalPaise).toBe(20_000);
    expect(result.current.stale).toBe(false);
  });

  it('keeps the last good preview and marks it stale while a newer one is in flight', async () => {
    const second = deferred<PreviewSplitResponseDto>();
    mockLoadSplitPreview
      .mockResolvedValueOnce(response(10_000))
      .mockReturnValueOnce(second.promise);

    const { result, rerender } = await renderHook(
      (props: { amountPaise: number }) =>
        useSplitPreview(params({ amountPaise: props.amountPaise })),
      { initialProps: { amountPaise: 10_000 } },
    );

    await settleDebounce();
    expect(result.current.preview?.totalPaise).toBe(10_000);

    await rerender({ amountPaise: 20_000 });
    expect(result.current.stale).toBe(true);
    expect(result.current.preview?.totalPaise).toBe(10_000);

    await settleDebounce();
    await act(async () => {
      second.resolve(response(20_000));
    });
    expect(result.current.stale).toBe(false);
    expect(result.current.preview?.totalPaise).toBe(20_000);
  });
});

describe('useSplitPreview — failure and offline', () => {
  it('shows the server sentence for a non-network failure, with no offline claim', async () => {
    mockLoadSplitPreview.mockRejectedValue({ reason: 'server' });
    const { result } = await renderHook(() => useSplitPreview(params()));

    await settleDebounce();

    expect(result.current.error).toBe('The server refused that split.');
    expect(result.current.offlineNotice).toBeNull();
    expect(result.current.preview).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('refuses to invent numbers when offline with no resolved snapshot', async () => {
    onlineManager.setOnline(false);
    const { result } = await renderHook(() => useSplitPreview(params()));

    await settleDebounce();

    expect(result.current.offlineNotice).toMatch(/Offline preview unavailable/);
    expect(result.current.preview).toBeNull();
    expect(mockLoadSplitPreview).not.toHaveBeenCalled();
  });

  it('refuses a snapshot that belongs to another society', async () => {
    onlineManager.setOnline(false);
    setOfflineSnapshot({
      societyId: asSocietyId('soc-other'),
      selectorKey: 'sel-1',
      capturedAt: new Date().toISOString(),
      participants: [
        {
          apartmentId: 'ap1',
          apartmentNumber: 'A-101',
          memberId: 'm1',
          shareUnits: 1,
          floor: 1,
          carpetAreaSqft: 1000,
          builtupAreaSqft: 1200,
          bhk: 2,
          parkingSlots: 1,
        },
      ],
      unassigned: [],
    });
    const { result } = await renderHook(() => useSplitPreview(params()));

    await settleDebounce();

    expect(result.current.offlineNotice).toMatch(/Offline preview unavailable/);
    expect(result.current.preview).toBeNull();
  });

  it('falls back to the engine when the request fails on the network', async () => {
    mockLoadSplitPreview.mockRejectedValue({ reason: 'network' });
    const { result } = await renderHook(() => useSplitPreview(params()));

    await settleDebounce();

    expect(result.current.offlineNotice).toMatch(/Offline preview unavailable/);
    expect(result.current.error).toBeNull();
  });

  it('re-runs an identical request on retry', async () => {
    mockLoadSplitPreview.mockResolvedValue(response(10_000));
    const { result } = await renderHook(() => useSplitPreview(params()));

    await settleDebounce();
    expect(mockLoadSplitPreview).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.retry();
    });
    await settleDebounce();

    expect(mockLoadSplitPreview).toHaveBeenCalledTimes(2);
  });
});
