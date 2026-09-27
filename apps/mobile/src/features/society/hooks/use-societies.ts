import { isValidJoinCode, normalizeJoinCode } from '@ses/domain';
import type {
  Society,
  SocietyJoinFlat,
  SocietyJoinPreview,
  SocietyMembership,
  SocietySummary,
} from '@ses/domain';
import { useQuery } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import {
  selectActiveMembership,
  selectActiveSocietyId,
  useSocietyStore,
} from '@/stores/society.store';

import {
  loadJoinOptions,
  loadSociety,
  loadSocietySummaries,
  previewJoin,
} from '../services/society.service';

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

export interface JoinOptionsResult {
  readonly flats: readonly SocietyJoinFlat[];
  /** Flats matching the search — not flats returned. What "showing 50 of 312" is built from. */
  readonly total: number;
  /** True when the cap was reached, so the screen says "keep typing" rather than lying. */
  readonly truncated: boolean;
  readonly isLoading: boolean;
  readonly error: unknown;
}

/**
 * The flats a join code's society offers (T049) — the join screen's picker.
 *
 * Disabled until the code is complete **and** a session exists, for two different reasons: a
 * partial code is not a code (the `join-preview` hook makes the same judgement), and the route
 * is authenticated — the flat list is the building's layout, served to a holder of the code
 * rather than to the world.
 *
 * `search` narrows server-side (flat number or building name), so a 300-flat society is
 * searchable instead of scrollable. The caller debounces it; this hook does not, because only
 * the screen knows whether the user is still typing.
 */
export function useJoinOptions(rawCode: string, search = ''): JoinOptionsResult {
  const user = useAuthStore(selectAuthUser);
  const userId = user?.id ?? null;
  const code = normalizeJoinCode(rawCode);
  const term = search.trim();
  const enabled = isValidJoinCode(code) && userId !== null;

  const query = useQuery({
    queryKey: societyKeys.joinOptions(code, term),
    queryFn: () => loadJoinOptions(userId ?? '', code, term.length === 0 ? {} : { q: term }),
    enabled,
    /*
      Flats are edited rarely and the list is read on one screen, so a short stale window saves
      the request a user would otherwise pay for when they go back to fix their occupancy
      declaration. The picker is not a billing surface — an Admin who adds a flat while somebody
      is mid-form is a case the submission's own validation covers.
    */
    staleTime: 60_000,
  });

  return {
    flats: query.data?.flats ?? [],
    total: query.data?.total ?? 0,
    truncated: query.data?.truncated ?? false,
    isLoading: enabled && query.isPending,
    error: query.error,
  };
}
