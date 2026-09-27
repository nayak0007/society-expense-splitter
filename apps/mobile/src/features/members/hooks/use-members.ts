import type { MemberCapabilities, MemberView } from '@ses/domain';
import { useQuery } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';

import { loadMember, loadMembers, loadViewer } from '../services/member.service';
import type { MemberDirectoryFilters } from '../services/member.service';

import { memberKeys } from './member-keys';

/**
 * Member read hooks (React Query).
 *
 * Scoped to the **active society** read from the store, never to a route parameter, and that
 * is deliberate rather than convenient: the API's `SocietyGuard` resolves the tenant from the
 * `X-Society-Id` header, which the repository sends from the same store. Reading the society
 * from one source and writing it from another is how a screen ends up showing one society's
 * people while its edit button writes to another's.
 *
 * Capabilities travel with every read — the list, one member, and the caller's own row —
 * because the domain computes them once, from the membership, against the same matrix the API's
 * `PermissionGuard` evaluates. A screen that re-derived "may I edit this" from a role string
 * would be a second implementation of that matrix, and the failure mode is a visible button
 * over a refused request.
 */

export interface MembersResult {
  readonly members: readonly MemberView[];
  /** Rows matching the filters — not rows returned. What "showing 50 of 340" is built from. */
  readonly total: number;
  readonly capabilities: MemberCapabilities | null;
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly error: unknown;
  refetch: () => void;
}

/**
 * One page of the society's directory (PRD §3.3: a searchable list with flat number, role
 * badge and occupancy).
 *
 * Disabled until both a user and an active society are known: the list is society-scoped, so
 * firing it early would send a request with no tenant — which the guard answers `400` by
 * design.
 *
 * `placeholderData` rather than a spinner on every keystroke: the search box updates the
 * filters, and keeping the previous page on screen while the next one lands is the difference
 * between a list that filters and one that blanks out as you type.
 *
 * ## `staleTime: 0` here, against the app's 30-second default
 *
 * A member row carries labels this feature does **not** own — its building's name and its flat
 * number are joined server-side from the structure tables. The structure feature cannot be
 * made to invalidate the member namespace without inverting the one-way dependency recorded in
 * `use-flat-options.ts`, so the other half of the fix is here: a directory that always refetches
 * when it is mounted cannot disagree with the structure the user just renamed. It costs one
 * request per mount, deduplicated by React Query, on a screen nobody sits on and re-renders.
 */
export function useMembers(filters: MemberDirectoryFilters = {}): MembersResult {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: memberKeys.list(societyId, userId, filters),
    queryFn: () => loadMembers(userId ?? '', societyId ?? '', filters),
    enabled: userId !== null && societyId !== null,
    placeholderData: (previous) => previous,
    staleTime: 0,
  });

  return {
    members: query.data?.members ?? [],
    total: query.data?.total ?? 0,
    capabilities: query.data?.capabilities ?? null,
    isLoading: query.isPending && societyId !== null,
    isRefreshing: query.isFetching && !query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}

export interface MemberResult {
  readonly member: MemberView | null;
  readonly capabilities: MemberCapabilities | null;
  readonly isLoading: boolean;
  readonly error: unknown;
  refetch: () => void;
}

/** One member — the details and edit screens' read. */
export function useMember(memberId: string | null): MemberResult {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: memberKeys.detail(memberId, societyId, userId),
    queryFn: () => loadMember(userId ?? '', societyId ?? '', memberId ?? ''),
    enabled: userId !== null && societyId !== null && memberId !== null,
    // Same reason as the list: the row's flat label is joined from the structure.
    staleTime: 0,
  });

  return {
    member: query.data?.member ?? null,
    capabilities: query.data?.capabilities ?? null,
    isLoading: query.isPending && memberId !== null,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * The caller's own membership.
 *
 * The one read a member **form** can make: a create screen has no member id, and the question
 * it needs answered — may I add somebody here — is the same capability evaluation the list
 * returns. Reading it from the caller's own row rather than from a cached list means it is
 * still correct when the form is reached by a deep link with no list behind it.
 */
export function useViewer(): MemberResult {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: memberKeys.viewer(societyId, userId),
    queryFn: () => loadViewer(userId ?? '', societyId ?? ''),
    enabled: userId !== null && societyId !== null,
  });

  return {
    member: query.data?.member ?? null,
    capabilities: query.data?.capabilities ?? null,
    isLoading: query.isPending && societyId !== null,
    error: query.error,
    refetch: query.refetch,
  };
}
