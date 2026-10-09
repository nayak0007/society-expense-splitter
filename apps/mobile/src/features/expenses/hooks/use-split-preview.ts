import { onlineManager, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { isNetworkError } from '@/lib/api/api-client';
import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';
import type {
  ParticipantSelectorPayload,
  PreviewSplitResponseDto,
  SplitConfigPayload,
} from '@ses/contracts';

import { expenseKeys } from './expense-keys';
import { expenseErrorMessage, loadSplitPreview } from '../services/expense.service';
import { readOfflineSnapshot } from '../services/offline-snapshot.store';
import { computeOfflinePreview, offlineUnavailableReason } from '../split/offline-preview';
import type { OfflinePlan } from '../split/offline-preview';

/** PRD §3.5's debounce, in milliseconds (T075 acceptance). */
export const SPLIT_PREVIEW_DEBOUNCE_MS = 400;

/**
 * The amount the roster read is priced at.
 *
 * The roster is the *set* of resolved participants, which does not depend on the amount
 * — only on the selector and the category's owner-only routing. The endpoint requires a
 * positive amount, so this read passes a fixed one and never re-fetches when the
 * treasurer edits the amount, which is exactly the point: enumerating participants is
 * one question, pricing them another.
 */
const ROSTER_SENTINEL_PAISE = 100;

/** One resolved participant, from the roster read. */
export interface RosterEntry {
  readonly apartmentId: string;
  readonly apartmentNumber: string;
  readonly memberId: string;
}

interface RosterParams {
  readonly selector: ParticipantSelectorPayload;
  readonly selectorKey: string;
  readonly categoryId: string | null;
  readonly enabled: boolean;
}

export interface RosterResult {
  readonly roster: readonly RosterEntry[];
  readonly isLoading: boolean;
  readonly error: string | null;
}

/**
 * The resolved participant set for the current selector (T075 §7).
 *
 * Read through the **existing** preview endpoint with the `equal` strategy, which
 * charges every resolved participant, so its allocations *are* the roster. This is the
 * one way to enumerate participants without a new endpoint and without re-implementing
 * T063's resolution on the client — the flats, the member each is addressed to and the
 * owner-only routing are all the server's answer, not the client's guess. Cached by the
 * selector key, so editing a percentage does not re-read it.
 */
export function useParticipantRoster({
  selector,
  selectorKey,
  categoryId,
  enabled,
}: RosterParams): RosterResult {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: expenseKeys.splitPreview(societyId, userId, `roster:${selectorKey}`),
    queryFn: () =>
      loadSplitPreview(userId ?? '', societyId ?? '', {
        amountPaise: ROSTER_SENTINEL_PAISE,
        categoryId,
        splitStrategy: 'equal',
        participantSelector: selector,
      }),
    enabled: enabled && userId !== null && societyId !== null,
    staleTime: 30_000,
  });

  return {
    roster:
      query.data?.allocations.map((allocation) => ({
        apartmentId: allocation.apartmentId,
        apartmentNumber: allocation.apartmentNumber,
        memberId: allocation.memberId,
      })) ?? [],
    isLoading: query.isPending && enabled && userId !== null && societyId !== null,
    error:
      query.error === null || query.error === undefined ? null : expenseErrorMessage(query.error),
  };
}

interface PreviewParams {
  readonly amountPaise: number | null;
  readonly categoryId: string | null;
  readonly plan: OfflinePlan;
  readonly config: SplitConfigPayload;
  readonly selector: ParticipantSelectorPayload;
  readonly selectorKey: string;
  readonly enabled: boolean;
}

export interface SplitPreviewState {
  readonly preview: PreviewSplitResponseDto | null;
  readonly isLoading: boolean;
  /** True while a newer request is in flight over an older answer, or after an error. */
  readonly stale: boolean;
  readonly error: string | null;
  /** The explicit offline state's sentence, or `null` when a preview is shown. */
  readonly offlineNotice: string | null;
  readonly source: 'online' | 'offline' | null;
  retry: () => void;
}

interface InternalState {
  preview: PreviewSplitResponseDto | null;
  isLoading: boolean;
  stale: boolean;
  error: string | null;
  offlineNotice: string | null;
  source: 'online' | 'offline' | null;
}

const IDLE: InternalState = {
  preview: null,
  isLoading: false,
  stale: false,
  error: null,
  offlineNotice: null,
  source: null,
};

/** A stable string for an arbitrary JSON value — sorted keys, so equal requests collide. */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableKey(entryValue)}`);
  return `{${entries.join(',')}}`;
}

/** The canonical identity of one preview request, minus the amount's volatility. */
export function splitPreviewRequestKey(params: {
  readonly amountPaise: number | null;
  readonly categoryId: string | null;
  readonly plan: OfflinePlan;
  readonly config: SplitConfigPayload;
  readonly selector: ParticipantSelectorPayload;
}): string {
  return stableKey({
    amountPaise: params.amountPaise,
    categoryId: params.categoryId,
    strategy: params.plan.strategy,
    basis: params.plan.basis,
    config: params.config,
    selector: params.selector,
  });
}

/**
 * The live split preview (T075 §4, §5).
 *
 * ## Debounced, cancellable, and never out of order
 *
 * A keystroke in a percentage field must not fire a request; a pause of
 * {@link SPLIT_PREVIEW_DEBOUNCE_MS} does. Each committed request carries a monotonic id
 * and an `AbortController`: a response whose id is no longer current is **dropped**, and
 * the previous request is aborted, so a slow early answer can never overwrite a fast
 * later one. The most recent valid preview is **kept** while a newer one is in flight
 * (`stale: true`), which is what lets the editor show the last good numbers with a
 * "refreshing" cue instead of blanking.
 *
 * ## Offline, honestly
 *
 * When the device is offline (or the request fails on the network), the hook tries the
 * shared engine over the held snapshot. If no usable snapshot exists — its tenant,
 * selector or age fail the gate — it surfaces the **explicit** offline sentence and no
 * numbers at all. It never prices a split from guessed facts (§5), and it never retries
 * a mutation: the preview is a read, and the create/update path stays single-shot.
 */
export function useSplitPreview({
  amountPaise,
  categoryId,
  plan,
  config,
  selector,
  selectorKey,
  enabled,
}: PreviewParams): SplitPreviewState {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const [state, setState] = useState<InternalState>(IDLE);
  const [nonce, setNonce] = useState(0);

  // The latest request every render; the debounced effect snapshots it.
  const payloadRef = useRef({ amountPaise, categoryId, plan, config, selector, selectorKey });
  payloadRef.current = { amountPaise, categoryId, plan, config, selector, selectorKey };

  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const complete = amountPaise !== null && amountPaise > 0 && societyId !== null && enabled;

  const requestKey = splitPreviewRequestKey({ amountPaise, categoryId, plan, config, selector });

  useEffect(() => {
    if (!complete) {
      setState(IDLE);
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState((previous) => ({
      ...previous,
      isLoading: true,
      stale: previous.preview !== null,
      error: null,
      offlineNotice: null,
    }));

    const timer = setTimeout(() => {
      void runPreview(requestId);
    }, SPLIT_PREVIEW_DEBOUNCE_MS);

    async function runPreview(id: number): Promise<void> {
      const payload = payloadRef.current;
      const amount = payload.amountPaise;
      if (amount === null) return;

      const offlineReason = (): string | null =>
        offlineUnavailableReason({
          snapshot: readOfflineSnapshot(),
          societyId,
          selectorKey: payload.selectorKey,
          now: Date.now(),
        });

      const tryOffline = (): boolean => {
        const snapshot = readOfflineSnapshot();
        const reason = offlineReason();
        if (reason !== null || snapshot === null) {
          if (id === requestIdRef.current) {
            setState((previous) => ({
              ...previous,
              isLoading: false,
              stale: previous.preview !== null,
              offlineNotice: reason ?? 'Offline preview unavailable.',
              error: null,
            }));
          }
          return true;
        }
        const offline = computeOfflinePreview(snapshot, payload.plan, amount, payload.config);
        if (id !== requestIdRef.current) return true;
        if (!offline.ok) {
          setState((previous) => ({
            ...previous,
            isLoading: false,
            stale: previous.preview !== null,
            offlineNotice: offline.problem,
            error: null,
          }));
          return true;
        }
        setState({
          preview: offline.preview,
          isLoading: false,
          stale: false,
          error: null,
          offlineNotice: null,
          source: 'offline',
        });
        return true;
      };

      if (!onlineManager.isOnline()) {
        tryOffline();
        return;
      }

      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;

      try {
        const preview = await loadSplitPreview(userId ?? '', societyId ?? '', {
          amountPaise: amount,
          categoryId: payload.categoryId,
          splitStrategy: payload.plan.strategy,
          apartmentBasis: payload.plan.basis,
          splitConfig: payload.config,
          participantSelector: payload.selector,
          signal: controller.signal,
        });
        if (id !== requestIdRef.current) return;
        setState({
          preview,
          isLoading: false,
          stale: false,
          error: null,
          offlineNotice: null,
          source: 'online',
        });
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (id !== requestIdRef.current) return;
        if (isNetworkError(error)) {
          tryOffline();
          return;
        }
        setState((previous) => ({
          ...previous,
          isLoading: false,
          stale: previous.preview !== null,
          error: expenseErrorMessage(error),
          offlineNotice: null,
        }));
      }
    }

    return () => {
      clearTimeout(timer);
    };
    // `requestKey` is the request's identity — every input that can change the answer is folded
    // into it — while `nonce` re-runs an identical request on retry and the scope pair re-reads
    // the society's own snapshot. Nothing else the effect reads can move without one of them.
  }, [requestKey, complete, nonce, societyId, userId]);

  return {
    ...state,
    retry: () => setNonce((value) => value + 1),
  };
}
