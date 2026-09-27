import type { MemberPermissionsView } from '@ses/application';
import { MemberError } from '@ses/domain';
import type { MemberRole } from '@ses/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';

import { assignMemberRole, revokeMemberRole } from '../services/permission.service';

import { memberKeys, permissionKeys } from './member-keys';

/**
 * The role write (T046): assign, change or revoke one member's role.
 *
 * ## Not optimistic, and this is the interesting difference from the other writes
 *
 * Every write in `use-member-actions.ts` is optimistic on the row it touches, because the client
 * already holds almost every value the server will return. A role change is different in one way
 * that decides it: the *outcome* is a permission list only the server computes, from the stored
 * role — and an optimistic role badge sitting above a stale action list would describe a state
 * nobody is in. So the badge waits for the round trip, and the response (the role, its actions and
 * the caller's capabilities, all from the stored row) is written straight into the cache.
 *
 * ## Why the answer is cached under the member's permissions key
 *
 * Because it *is* that answer. `PATCH /members/:id/role` and `GET /permissions/members/:id` return
 * the same shape from the same evaluator, so seeding the query cache with the mutation's response
 * is not an optimistic guess — it is the server's own reply, and a permissions card that renders
 * it is rendering what a refetch would return a moment later.
 *
 * ## Invalidation
 *
 * `memberKeys.all` on settle, which reaches the directory pages, the detail row and every
 * permissions entry, because they share the `['member', …]` prefix. A role change moves a row
 * between the directory's role filters, changes what the row's badge says, and changes the action
 * list — one namespace, one invalidation. On *settle* rather than on success, deliberately: a
 * refusal (a cap, the last Admin, your own row) is exactly when another screen's cached copy is
 * most likely to be out of date.
 */

interface Scope {
  readonly actorId: string | null;
  readonly societyId: string | null;
}

function useScope(): Scope {
  return {
    actorId: useAuthStore(selectAuthUser)?.id ?? null,
    societyId: useSocietyStore(selectActiveSocietyId),
  };
}

/** Resolved at call time rather than during render, as in `use-member-actions.ts`. */
function requireScope(scope: Scope): { readonly actorId: string; readonly societyId: string } {
  if (scope.actorId === null) {
    throw new MemberError('forbidden', 'Your session expired. Please sign in again.');
  }
  if (scope.societyId === null) {
    throw new MemberError('not_found', 'Switch to a society to manage its members.');
  }
  return { actorId: scope.actorId, societyId: scope.societyId };
}

/** The server's answer, cached where the permissions views live. */
function seedPermissions(
  queryClient: QueryClient,
  memberId: string,
  scope: Scope,
  view: MemberPermissionsView,
): void {
  queryClient.setQueryData(
    permissionKeys.forMember(memberId, scope.societyId, scope.actorId),
    view,
  );
  void queryClient.invalidateQueries({ queryKey: memberKeys.all });
}

/** Assign or change one member's role. `mutate(role)`; resolves with the permissions it holds. */
export function useAssignRole(memberId: string | null) {
  const scope = useScope();
  const queryClient = useQueryClient();

  return useMutation<MemberPermissionsView, unknown, MemberRole>({
    mutationFn: (role) => {
      const { actorId, societyId } = requireScope(scope);
      if (memberId === null) {
        throw new MemberError('not_found', 'That member is not available to you.');
      }
      return assignMemberRole(actorId, societyId, memberId, role);
    },
    onSuccess: (view) => {
      if (memberId !== null) seedPermissions(queryClient, memberId, scope, view);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: memberKeys.all });
    },
  });
}

/** Revoke one member's role — the membership returns to the default (PRD §2.3). */
export function useRevokeRole(memberId: string | null) {
  const scope = useScope();
  const queryClient = useQueryClient();

  return useMutation<MemberPermissionsView, unknown, void>({
    mutationFn: () => {
      const { actorId, societyId } = requireScope(scope);
      if (memberId === null) {
        throw new MemberError('not_found', 'That member is not available to you.');
      }
      return revokeMemberRole(actorId, societyId, memberId);
    },
    onSuccess: (view) => {
      if (memberId !== null) seedPermissions(queryClient, memberId, scope, view);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: memberKeys.all });
    },
  });
}
