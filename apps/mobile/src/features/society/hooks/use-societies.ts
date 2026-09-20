import { isValidJoinCode, normalizeJoinCode } from '@ses/domain';
import type { Society, SocietyJoinPreview, SocietyMembership } from '@ses/domain';
import { useQuery } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import {
  selectActiveMembership,
  selectActiveSocietyId,
  useSocietyStore,
} from '@/stores/society.store';

import { loadSociety, previewJoin } from '../services/society.service';

import { societyKeys } from './society-keys';

/**
 * Society read hooks (React Query). Queries never write to the store — the
 * bootstrap hook owns that mirror, so there is exactly one writer per value.
 */

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
