import { isValidJoinCode, normalizeJoinCode } from '@ses/domain';
import type { Society, SocietyJoinPreview, SocietyMembership, SocietySummary } from '@ses/domain';
import { useQuery } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import {
  selectActiveMembership,
  selectActiveSocietyId,
  useSocietyStore,
} from '@/stores/society.store';

import { loadSociety, loadSocietySummaries, previewJoin } from '../services/society.service';

import { societyKeys } from './society-keys';

/**
 * Society read hooks (React Query). Queries never write to the store — the
 * bootstrap hook owns that mirror, so there is exactly one writer per value.
 *
 * THREE READ PATHS, and picking the wrong one is the usual mistake here:
 *
 *  - `useSocieties()`      the user's societies as *presentation rows*
 *                          (`SocietySummary`): name, city, type, role, status,
 *                          member count. Use it for anything that lists
 *                          societies. It is backed by a query, so it is fresh,
 *                          paginatable and refetchable.
 *  - `useActiveSociety()`  the society the session is scoped to, plus the
 *                          caller's membership. Use it on a screen that acts on
 *                          "the current society" without a route param.
 *  - `useSociety(id)`      one society by id, for screens and modals that take a
 *                          route param.
 *
 * `useSocietyStore.memberships` is a *fourth* source and not a duplicate: it is
 * the synchronous snapshot the router reads before a screen can render (SAD §5.2),
 * fed by `useSocietyBootstrap`. Hooks never write it; the bootstrap owns it.
 */

export interface SocietiesResult {
  readonly societies: readonly SocietySummary[];
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly error: unknown;
  refetch: () => void;
}

/**
 * Every society the signed-in user belongs to (PRD §3.1: "Multiple → Society
 * Switcher"), as rows ready to render.
 *
 * Disabled until a user is known, so a signed-out render never fires a request
 * with an empty actor — the port is actor-scoped and would answer `not_found`
 * for every row anyway.
 */
export function useSocieties(): SocietiesResult {
  const user = useAuthStore(selectAuthUser);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: societyKeys.list(userId),
    queryFn: () => loadSocietySummaries(userId ?? ''),
    enabled: userId !== null,
  });

  return {
    societies: query.data ?? [],
    isLoading: query.isPending && userId !== null,
    isRefreshing: query.isFetching && !query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}

export interface ActiveSocietyResult {
  readonly society: Society | null;
  readonly membership: SocietyMembership | null;
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly error: unknown;
  refetch: () => void;
}

/** The society the session is currently scoped to (PRD §3.1). */
export function useActiveSociety(): ActiveSocietyResult {
  const user = useAuthStore(selectAuthUser);
  const activeSocietyId = useSocietyStore(selectActiveSocietyId);
  const membership = useSocietyStore(selectActiveMembership);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: societyKeys.detail(activeSocietyId, userId),
    queryFn: () => loadSociety(activeSocietyId ?? '', userId ?? ''),
    enabled: userId !== null && activeSocietyId !== null,
  });

  return {
    society: query.data ?? null,
    membership,
    isLoading: query.isPending && activeSocietyId !== null,
    isRefreshing: query.isFetching && !query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}

/** A specific society by id — used by screens that take a route param. */
export function useSociety(societyId: string | null): {
  readonly society: Society | null;
  readonly isLoading: boolean;
  readonly error: unknown;
  refetch: () => void;
} {
  const user = useAuthStore(selectAuthUser);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: societyKeys.detail(societyId, userId),
    queryFn: () => loadSociety(societyId ?? '', userId ?? ''),
    enabled: userId !== null && societyId !== null,
  });

  return {
    society: query.data ?? null,
    isLoading: query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * Society preview for a join code (PRD §3.2: enter code → preview name, city,
 * member count → then choose a flat). Disabled until the code is complete, so
 * typing never fires a request per keystroke.
 */
export function useJoinPreview(rawCode: string): {
  readonly code: string;
  readonly preview: SocietyJoinPreview | null;
  readonly isSearching: boolean;
  readonly notFound: boolean;
} {
  const code = normalizeJoinCode(rawCode);
  const enabled = isValidJoinCode(code);

  const query = useQuery({
    queryKey: societyKeys.joinPreview(code),
    queryFn: () => previewJoin(code),
    enabled,
  });

  return {
    code,
    preview: query.data ?? null,
    isSearching: enabled && query.isFetching,
    notFound: enabled && query.isSuccess && query.data === null,
  };
}
