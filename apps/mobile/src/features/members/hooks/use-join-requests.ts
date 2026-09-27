import type { JoinQueue } from '@ses/application';
import { MemberError } from '@ses/domain';
import type { JoinApprovalInput, MemberView } from '@ses/domain';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';

import { approveJoinRequest, loadJoinQueue, rejectJoinRequest } from '../services/member.service';

import { memberKeys } from './member-keys';

/**
 * The join queue and its two decisions (T049).
 *
 * ## The read is `member.approve`, and the screen says so before the request does
 *
 * The queue is not the directory with a status filter: it is the decision screen, and its
 * permission is `member.approve` (Admin and Treasurer) where the directory is `member.view`
 * (everyone but a Guest). The hook is enabled for every signed-in member because the *server* is
 * what refuses — the screen's `RequirePermission` is what keeps a Resident from ever seeing a
 * decision UI, and the two answers cannot disagree because both read the same capability.
 *
 * ## Neither decision is optimistic, and that is the point
 *
 * The other member mutations patch the cache because an edit replaces a row the client just
 * read. A decision does not: approving settles the role, the occupancy, the flat and the
 * `joinedAt`/`approvedBy` stamps in the database's own function, and the row that comes back is
 * the only true one. A locally-flipped status would also hide the case the queue exists for —
 * a request somebody else decided a moment ago, answered `409 JOIN_REQUEST_NOT_PENDING` — behind
 * a row that briefly looked approved.
 *
 * ## What is invalidated
 *
 * The whole `member` namespace, for the same reason `useRemoveMember` does: a decision changes
 * which pages the row appears on (it leaves the queue, it enters the active directory) and the
 * `total` every screen quotes. The society summary's `memberCount` is a different namespace and
 * refetches on its own schedule; the directory is where the change has to be visible at once.
 */

const PAGE_SIZE = 50;

export interface JoinRequestsResult {
  readonly requests: JoinQueue['requests'];
  /** Rows the filter produced — not rows returned. What "showing 50 of 340" is built from. */
  readonly total: number;
  readonly capabilities: JoinQueue['capabilities'] | null;
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly error: unknown;
  refetch: () => void;
}

/** One page of the society's pending requests, with the claims the server resolved. */
export function useJoinRequests(page = 0): JoinRequestsResult {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: memberKeys.joinQueue(societyId, userId, page),
    queryFn: () =>
      loadJoinQueue(userId ?? '', societyId ?? '', {
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      }),
    enabled: userId !== null && societyId !== null,
  });

  return {
    requests: query.data?.requests ?? [],
    total: query.data?.total ?? 0,
    capabilities: query.data?.capabilities ?? null,
    isLoading: query.isPending && societyId !== null,
    isRefreshing: query.isFetching && !query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}

/** Resolved at call time rather than during render — a hook must never throw while rendering. */
function requireScope(
  actorId: string | null,
  societyId: string | null,
): { readonly actorId: string; readonly societyId: string } {
  if (actorId === null) {
    throw new MemberError('forbidden', 'Your session expired. Please sign in again.');
  }
  if (societyId === null) {
    throw new MemberError('not_found', 'Switch to a society to review its join requests.');
  }
  return { actorId, societyId };
}

/** Admit a pending member. The payload carries only what the approver actually set. */
export function useApproveJoinRequest(memberId: string) {
  const actorId = useAuthStore(selectAuthUser)?.id ?? null;
  const societyId = useSocietyStore(selectActiveSocietyId);
  const queryClient = useQueryClient();

  return useMutation<MemberView, unknown, JoinApprovalInput>({
    mutationFn: (input) => {
      const scope = requireScope(actorId, societyId);
      return approveJoinRequest(scope.actorId, scope.societyId, memberId, input);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: memberKeys.all });
    },
  });
}

/** Refuse a pending member, with the reason the requester is shown. */
export function useRejectJoinRequest(memberId: string) {
  const actorId = useAuthStore(selectAuthUser)?.id ?? null;
  const societyId = useSocietyStore(selectActiveSocietyId);
  const queryClient = useQueryClient();

  return useMutation<MemberView, unknown, string>({
    mutationFn: (reason) => {
      const scope = requireScope(actorId, societyId);
      return rejectJoinRequest(scope.actorId, scope.societyId, memberId, reason);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: memberKeys.all });
    },
  });
}
