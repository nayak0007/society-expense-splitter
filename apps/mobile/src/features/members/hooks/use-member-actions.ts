import type { MemberDetail, MemberDirectory } from '@ses/application';
import type { CreateMemberPayload, UpdateMemberPayload } from '@ses/contracts';
import { asApartmentId, MemberError } from '@ses/domain';
import type { MemberStatus, MemberView } from '@ses/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';

import {
  addMember,
  reactivateMember,
  removeMember,
  suspendMember,
  updateMember,
} from '../services/member.service';

import { memberKeys } from './member-keys';

/**
 * Member write hooks.
 *
 * ## The scope comes from the session, never from a screen argument
 *
 * Both the actor and the society are read from the stores here rather than passed in, matching
 * the read hooks. A screen that supplied them could be wrong; the session cannot, and the value
 * the repository puts in the `X-Society-Id` header is then by construction the value the query
 * keys are scoped by.
 *
 * ## Which mutations are optimistic, and why they differ
 *
 *  - **`update`** is optimistic on both the detail and the list. An edit replaces a row the
 *    client just read, so it already holds almost every value the server will return.
 *  - **`suspend` / `reactivate`** are optimistic for the same reason and one more: the status
 *    badge is the whole visible outcome, and a directory that still says "Active" for a second
 *    after the user tapped Suspend reads as a tap that missed.
 *  - **`remove`** is optimistic on the **list only** — the row leaving is what the user asked
 *    for and the list is where they return to. The detail query is left alone because the
 *    screen showing the confirmation is still mounted, and writing `null` there would blank it
 *    before the navigation.
 *  - **`add`** is deliberately **not** optimistic, for the reason building creation is not: the
 *    server mints the id, and every query key, the detail cache and the route are addressed by
 *    it — so an optimistic row would be a fabricated entity with an invented id. One round trip
 *    is the correct trade.
 *
 * ## What is invalidated
 *
 * The whole `member` namespace on settle, for one reason worth stating: the directory is a
 * **filtered, paginated** projection. A status edit changes which pages a row appears on, a
 * removal changes the `total` every screen is quoting, and a phone edit changes which page a
 * duplicate lookup would find. The optimistic branch is what the user sees immediately; the
 * refetch is what makes the list true again.
 *
 * No hook here touches the routing store: a membership is not a tenancy, and `activeSocietyId`
 * changes only when *this* user's own membership does — which is the society module's business,
 * not the directory's.
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

/**
 * Resolved at call time rather than during render — a hook must never throw while React is
 * rendering, and by the time a mutation runs the session is a fact.
 */
function requireScope(scope: Scope): { readonly actorId: string; readonly societyId: string } {
  if (scope.actorId === null) {
    throw new MemberError('forbidden', 'Your session expired. Please sign in again.');
  }
  if (scope.societyId === null) {
    throw new MemberError('not_found', 'Switch to a society to manage its members.');
  }
  return { actorId: scope.actorId, societyId: scope.societyId };
}

/**
 * The optimistic `MemberView`, mirroring the use case's semantics: an **absent** field is
 * unchanged and an explicit **`null`** clears.
 *
 * That second half is not decoration. `formValuesToUpdatePayload` sends `null` for an emptied
 * phone, email, lease date or flat, and a merge that treated `null` as "unchanged" would leave
 * the old value on screen until the refetch — which is exactly the value the user just
 * deleted.
 *
 * `contactVisible` is preserved rather than recomputed: it is a fact about the *viewer*, one
 * this hook does not have the rule for (the domain derives it inside the use cases), and a
 * guess here could tell somebody they may see a number that the server hands back as withheld.
 * Fields the server owns — `updatedAt`, `approvedBy`, `removedBy` — are left alone rather than
 * invented.
 */
function applyMemberPatch(member: MemberView, patch: UpdateMemberPayload): MemberView {
  // Three cases, not two: absent leaves the flat alone, `null` clears it, and a string moves
  // the member — which is the contract's own distinction, restated where the optimistic row is
  // assembled. The brand is applied last because `null` must stay `null` rather than become an
  // "empty id".
  const apartmentId =
    patch.apartmentId === undefined
      ? member.apartmentId
      : patch.apartmentId === null
        ? null
        : asApartmentId(patch.apartmentId);

  return {
    ...member,
    displayName: patch.displayName ?? member.displayName,
    phone: patch.phone === undefined ? member.phone : patch.phone,
    email: patch.email === undefined ? member.email : patch.email,
    occupancy: patch.occupancy ?? member.occupancy,
    isPrimary: patch.isPrimary ?? member.isPrimary,
    leaseStart: patch.leaseStart === undefined ? member.leaseStart : patch.leaseStart,
    leaseEnd: patch.leaseEnd === undefined ? member.leaseEnd : patch.leaseEnd,
    shareContact: patch.shareContact ?? member.shareContact,
    apartmentId,
    /*
      The label is only kept when the flat did not change.

      A flat's label — its building's name and its floor — is not on this row; it is joined
      server-side. So when the user moves a member to a different flat, the honest optimistic
      answer is *no label yet* rather than the old one: rendering "Tower A · A-101" for a
      member who was just moved to B-204 is a wrong address on a billing record, while an
      absent one is merely brief. The refetch fills it in.
    */
    apartment: apartmentId === member.apartmentId ? member.apartment : null,
  };
}

function withStatus(member: MemberView, status: MemberStatus): MemberView {
  return { ...member, status };
}

/**
 * The cache holds the use case's own objects, not bare arrays.
 *
 * Worth spelling out because nothing in the types catches getting it wrong: `useQuery` caches
 * whatever `queryFn` returned — for the list that is `{ members, total, limit, offset,
 * capabilities }` and for the detail `{ member, capabilities }`. An optimistic branch that read
 * a plain array out of either key would throw on `.map`/`.filter` at the one moment the user is
 * waiting for a save, and it would surface as "something went wrong" on a write the server never
 * rejected. Every branch below therefore reads and writes the whole object and preserves the
 * fields a member's own values cannot change.
 */
interface ListOptimisticContext {
  readonly listKeys: readonly (readonly unknown[])[];
  readonly previousLists: readonly (MemberDirectory | undefined)[];
}

interface DetailOptimisticContext extends ListOptimisticContext {
  readonly detailKey: readonly unknown[];
  readonly previousDetail: MemberDetail | undefined;
}

/**
 * Every cached page, not just the one in view.
 *
 * A member write does not know which filters the user came through, so a patch has to reach
 * every directory entry whose `members` contain this row. Only entries that already hold the
 * row are rewritten, and only their `total` is adjusted for a removal — an entry that has never
 * fetched it is left alone rather than becoming a fabricated page.
 */
function cachedListKeys(
  queryClient: ReturnType<typeof useQueryClient>,
): readonly (readonly unknown[])[] {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: memberKeys.all })
    .filter((query) => query.queryKey[1] === 'list')
    .map((query) => query.queryKey);
}

function patchListCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  update: (directory: MemberDirectory) => MemberDirectory,
): ListOptimisticContext {
  const listKeys = cachedListKeys(queryClient);
  const previousLists = listKeys.map((key) => queryClient.getQueryData<MemberDirectory>(key));

  listKeys.forEach((key, index) => {
    const previous = previousLists[index];
    if (previous === undefined) return;
    queryClient.setQueryData(key, update(previous));
  });

  return { listKeys, previousLists };
}

function restoreListCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  context: ListOptimisticContext | undefined,
): void {
  if (context === undefined) return;
  context.listKeys.forEach((key, index) => {
    const previous = context.previousLists[index];
    // `undefined` means "nothing was cached", which is not the same as an empty page: restoring
    // it would create an entry claiming the society has no members.
    if (previous !== undefined) queryClient.setQueryData(key, previous);
  });
}

/** Cancel every in-flight directory read, or a response already on the wire reverts the patch. */
async function cancelListReads(
  queryClient: ReturnType<typeof useQueryClient>,
  scope: Scope,
): Promise<void> {
  await queryClient.cancelQueries({
    queryKey: [...memberKeys.all, 'list', scope.societyId, scope.actorId],
  });
}

/** Create a member. Nothing to patch — the id does not exist yet. */
export function useAddMember() {
  const scope = useScope();
  const queryClient = useQueryClient();

  return useMutation<MemberView, unknown, CreateMemberPayload>({
    mutationFn: (payload) => {
      const { actorId, societyId } = requireScope(scope);
      return addMember(actorId, societyId, payload);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: memberKeys.all });
    },
  });
}

/** Edit a member. Optimistic on the detail and on every cached page, then refetched. */
export function useUpdateMember(memberId: string | null) {
  const scope = useScope();
  const queryClient = useQueryClient();

  return useMutation<MemberView, unknown, UpdateMemberPayload, DetailOptimisticContext>({
    mutationFn: (patch) => {
      const { actorId, societyId } = requireScope(scope);
      if (memberId === null) {
        throw new MemberError('not_found', 'That member is not available to you.');
      }
      return updateMember(actorId, societyId, memberId, patch);
    },

    onMutate: async (patch) => {
      const detailKey = memberKeys.detail(memberId, scope.societyId, scope.actorId);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: detailKey }),
        cancelListReads(queryClient, scope),
      ]);

      const previousDetail = queryClient.getQueryData<MemberDetail>(detailKey);
      if (previousDetail !== undefined) {
        queryClient.setQueryData(detailKey, {
          ...previousDetail,
          member: applyMemberPatch(previousDetail.member, patch),
        });
      }

      const lists = patchListCaches(queryClient, (directory) => ({
        ...directory,
        members: directory.members.map((member) =>
          member.id === memberId ? applyMemberPatch(member, patch) : member,
        ),
      }));

      return { detailKey, previousDetail, ...lists };
    },

    onError: (_error, _patch, context) => {
      if (context === undefined) return;
      if (context.previousDetail !== undefined) {
        queryClient.setQueryData(context.detailKey, context.previousDetail);
      }
      restoreListCaches(queryClient, context);
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: memberKeys.all });
    },
  });
}

/**
 * Suspend or reactivate, from one implementation.
 *
 * Two mutations rather than one parameterised by status, because two screens name them
 * ("Suspend" and "Reactivate") and one function taking a union would have to be given the right
 * member of it by every call site — which is how a screen ends up posting `suspend` twice.
 */
function useStatusChange(memberId: string | null, status: 'active' | 'inactive') {
  const scope = useScope();
  const queryClient = useQueryClient();

  return useMutation<MemberView, unknown, void, DetailOptimisticContext>({
    mutationFn: () => {
      const { actorId, societyId } = requireScope(scope);
      if (memberId === null) {
        throw new MemberError('not_found', 'That member is not available to you.');
      }
      return status === 'active'
        ? reactivateMember(actorId, societyId, memberId)
        : suspendMember(actorId, societyId, memberId);
    },

    onMutate: async () => {
      const detailKey = memberKeys.detail(memberId, scope.societyId, scope.actorId);
      await Promise.all([
        queryClient.cancelQueries({ queryKey: detailKey }),
        cancelListReads(queryClient, scope),
      ]);

      const previousDetail = queryClient.getQueryData<MemberDetail>(detailKey);
      if (previousDetail !== undefined) {
        queryClient.setQueryData(detailKey, {
          ...previousDetail,
          member: withStatus(previousDetail.member, status),
        });
      }

      const lists = patchListCaches(queryClient, (directory) => ({
        ...directory,
        members: directory.members.map((member) =>
          member.id === memberId ? withStatus(member, status) : member,
        ),
      }));

      return { detailKey, previousDetail, ...lists };
    },

    onError: (_error, _variables, context) => {
      if (context === undefined) return;
      if (context.previousDetail !== undefined) {
        queryClient.setQueryData(context.detailKey, context.previousDetail);
      }
      restoreListCaches(queryClient, context);
    },

    /*
      The detail key is dropped rather than refetched: suspension is refused for the last admin
      and for a caller's own row, and a refetch of a row the server *did* change reports the
      authoritative status either way. Invalidation is enough — the screens that care are
      subscribed to it.
    */
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: memberKeys.all });
    },
  });
}

export function useSuspendMember(memberId: string | null) {
  return useStatusChange(memberId, 'inactive');
}

export function useReactivateMember(memberId: string | null) {
  return useStatusChange(memberId, 'active');
}

/** Soft-remove a member. Optimistic on every cached page; the detail self-corrects. */
export function useRemoveMember(memberId: string | null) {
  const scope = useScope();
  const queryClient = useQueryClient();

  return useMutation<void, unknown, void, ListOptimisticContext>({
    mutationFn: () => {
      const { actorId, societyId } = requireScope(scope);
      if (memberId === null) {
        throw new MemberError('not_found', 'That member is not available to you.');
      }
      return removeMember(actorId, societyId, memberId);
    },

    onMutate: async () => {
      // Only the list keys are written below, so only they need their in-flight responses
      // cancelled.
      await cancelListReads(queryClient, scope);

      return patchListCaches(queryClient, (directory) => {
        const remaining = directory.members.filter((member) => member.id !== memberId);
        /*
          The total moves with the row.

          It is the count the *filters* produced, which is why it cannot simply be copied: a
          director's screen showing "showing 50 of 340" has to say 339 after a removal, or the
          number contradicts the list beside it. A row that was not in the cached page is not
          removed, so the total is only adjusted when something was actually taken out.
        */
        const removed = directory.members.length - remaining.length;
        return {
          ...directory,
          members: remaining,
          total: Math.max(0, directory.total - removed),
        };
      });
    },

    onError: (_error, _variables, context) => {
      restoreListCaches(queryClient, context);
    },

    onSettled: () => {
      // The whole namespace, because a removal changes what *every* filtered page would
      // return — the count above all. The server is the authority on what remains.
      void queryClient.invalidateQueries({ queryKey: memberKeys.all });
    },
  });
}
