import type { MemberPermissionsView } from '@ses/application';
import type { Action, MemberCapabilities, RoleDefinition } from '@ses/domain';
import { useQuery } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';

import {
  loadMemberPermissions,
  loadMyPermissions,
  loadRoles,
} from '../services/permission.service';

import { permissionKeys } from './member-keys';

/**
 * Permission read hooks (T046) — React Query.
 *
 * ## Why they are disabled more aggressively than the directory's
 *
 * The member list can render an empty state while it loads; a permissions screen cannot, because
 * its "empty" is a *claim* ("your role allows nothing") that is indistinguishable from a failed
 * read. So every query here is enabled only when both the session and the active society are
 * known — the same condition the repository needs to build its `X-Society-Id` header — and the
 * screens render a spinner, never an empty list, before the answer arrives.
 *
 * ## The scope comes from the stores, never from a screen argument
 *
 * Reading the society from a route parameter and writing it from the store is how a screen ends up
 * showing one society's rules while its mutations write to another's. Both come from the store
 * here, so the value in the header is by construction the value the key is scoped by.
 */

export interface RolesResult {
  readonly roles: readonly RoleDefinition[];
  readonly capabilities: MemberCapabilities | null;
  readonly isLoading: boolean;
  readonly error: unknown;
  refetch: () => void;
}

/** The role catalogue — read by the permissions screen and by any role picker's copy. */
export function useRoles(): RolesResult {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: permissionKeys.catalogue(societyId, userId),
    queryFn: () => loadRoles(userId ?? '', societyId ?? ''),
    enabled: userId !== null && societyId !== null,
  });

  return {
    roles: query.data?.roles ?? [],
    capabilities: query.data?.capabilities ?? null,
    isLoading: query.isPending && societyId !== null && userId !== null,
    error: query.error,
    refetch: query.refetch,
  };
}

export interface PermissionsResult {
  readonly permissions: readonly Action[];
  /** The membership the answer is about — `null` until it arrives. */
  readonly view: MemberPermissionsView | null;
  readonly isLoading: boolean;
  readonly error: unknown;
  refetch: () => void;
}

/**
 * The caller's own effective permissions.
 *
 * No capability gate, on purpose and in both layers: a member whose role holds nothing is
 * entitled to see that, and it is the difference between "your role cannot do this" and a screen
 * that refuses to explain itself.
 */
export function useMyPermissions(): PermissionsResult {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: permissionKeys.mine(societyId, userId),
    queryFn: () => loadMyPermissions(userId ?? '', societyId ?? ''),
    enabled: userId !== null && societyId !== null,
  });

  return {
    permissions: query.data?.permissions ?? [],
    view: query.data ?? null,
    isLoading: query.isPending && societyId !== null && userId !== null,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * One member's effective permissions.
 *
 * `enabled` is the caller's decision, not this hook's: the read is allowed for the member
 * themselves and for an Admin, and a screen that asks for somebody else's without either grant
 * would be answered 403 — a request that only ever produces an error is one to not make. So the
 * `enabled` flag travels in, and the screen passes its own capability.
 */
export function useMemberPermissions(
  memberId: string | null,
  options: { readonly enabled?: boolean } = {},
): PermissionsResult {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;
  const enabled = (options.enabled ?? true) && userId !== null && societyId !== null;

  const query = useQuery({
    queryKey: permissionKeys.forMember(memberId, societyId, userId),
    queryFn: () => loadMemberPermissions(userId ?? '', societyId ?? '', memberId ?? ''),
    enabled: enabled && memberId !== null,
  });

  return {
    permissions: query.data?.permissions ?? [],
    view: query.data ?? null,
    isLoading: query.isPending && enabled && memberId !== null,
    error: query.error,
    refetch: query.refetch,
  };
}
