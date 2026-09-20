import type {
  CreateSocietyPayload,
  JoinSocietyPayload,
  UpdateSocietyPayload,
} from '@ses/contracts';
import { SocietyError } from '@ses/domain';
import type { Society, SocietyMembership, SocietySummary } from '@ses/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';

import {
  createSociety,
  deleteSociety,
  joinSociety,
  leaveSociety,
  regenerateJoinCode,
  updateSociety,
} from '../services/society.service';

import { societyKeys } from './society-keys';

/**
 * Society write hooks.
 *
 * Every mutation resolves the actor from the auth store (never from a screen
 * argument, so scope cannot be spoofed by a caller) and surfaces `SocietyError`
 * unchanged, so a screen renders `error.message` directly.
 *
 * ## Which mutations are optimistic, and why
 *
 * `update` is, on both the detail and the list, because an edit replaces a row the
 * client just read — it already holds every value the server will return, so the
 * result can be shown before the round trip completes.
 *
 * `delete` is, on the **list only**. The row disappearing is the outcome the user
 * expects to see, and the list is what they return to. The detail query is
 * deliberately left alone: the only screen showing it during a delete is the
 * confirmation modal the user just acted in, and it stays mounted while the request
 * is in flight — writing `null` there would blank the `Type "<name>"` prompt in
 * front of them and then navigate away. It self-corrects on settle, because the
 * server is the authority on whether the society still exists.
 *
 * `create` is deliberately **not**, and that is not an oversight. The server mints
 * the id, the slug and the join code, and every query key and the session's
 * active-society pointer are scoped by that id — so an optimistic society would be
 * a fabricated entity with an invented id, and anything derived from it would chase
 * a row that can never exist. One round trip is the correct trade.
 *
 * `regenerateJoinCode`, `join` and `leave` are left non-optimistic for the same
 * reason in miniature: the code is minted server-side, a join's resulting *status*
 * is an approval the client cannot predict, and leaving is a state the router acts
 * on within a frame.
 *
 * ## Optimism never touches the routing store
 *
 * `useSocietyStore.memberships` is the synchronous snapshot the router reads
 * before a screen renders (SAD §5.2). It changes only when a write is confirmed —
 * the service drops the membership on success. So an optimistic rollback has
 * nothing to undo outside the query cache: one writer per value, and a failed
 * write can never leave routing disagreeing with the server.
 */

function useActorId(): string | null {
  return useAuthStore(selectAuthUser)?.id ?? null;
}

/** Resolved at call time — a hook must never throw during render. */
function requireActor(actorId: string | null): string {
  if (actorId === null) {
    throw new SocietyError('forbidden', 'Your session expired. Please sign in again.');
  }
  return actorId;
}

/**
 * An optimistic `Society` built from a patch, mirroring the use case's documented
 * semantics exactly: an *absent* field is unchanged, an *empty string* clears a
 * nullable field, anything else replaces it. Getting that backwards is how an
 * edit form that sends only the fields it touched wipes the others on screen.
 *
 * Fields the server owns — `slug`, `joinCode`, `updatedAt` — are deliberately left
 * alone rather than guessed. Inventing them would show the user a value the server
 * never agreed to; the refetch that follows every mutation corrects them a moment
 * later.
 */
function applySocietyPatch(society: Society, patch: UpdateSocietyPayload): Society {
  return {
    ...society,
    name: patch.name ?? society.name,
    type: patch.type ?? society.type,
    city: patch.city ?? society.city,
    state: patch.state ?? society.state,
    registrationNumber: clearedOr(patch.registrationNumber, society.registrationNumber),
    addressLine1: clearedOr(patch.addressLine1, society.addressLine1),
    addressLine2: clearedOr(patch.addressLine2, society.addressLine2),
    pincode: clearedOr(patch.pincode, society.pincode),
    settings: {
      ...society.settings,
      billingDay: patch.billingDay ?? society.settings.billingDay,
      dueDay: patch.dueDay ?? society.settings.dueDay,
      approvalThresholdPaise:
        patch.approvalThresholdPaise ?? society.settings.approvalThresholdPaise,
    },
  };
}

/** `undefined` leaves the field alone; `''` clears it; anything else replaces it. */
function clearedOr(value: string | undefined, current: string | null): string | null {
  if (value === undefined) return current;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** The list rows a rename touches — the list must not keep the old name. */
function applySummaryPatch(summary: SocietySummary, patch: UpdateSocietyPayload): SocietySummary {
  return {
    ...summary,
    name: patch.name ?? summary.name,
    city: patch.city ?? summary.city,
    type: patch.type ?? summary.type,
  };
}

/**
 * What an optimistic rollback needs. Carrying it through `onMutate` rather than
 * stashing it in a module variable is what makes two mutations in flight
 * independent of each other.
 */
interface UpdateOptimisticContext {
  readonly detailKey: readonly unknown[];
  readonly previousDetail: Society | null | undefined;
  readonly listKey: readonly unknown[];
  readonly previousList: readonly SocietySummary[] | undefined;
}

/** A delete touches the list, and only the list — see the note above. */
interface DeleteOptimisticContext {
  readonly listKey: readonly unknown[];
  readonly previousList: readonly SocietySummary[] | undefined;
}

/**
 * Create a society. The creator becomes its Admin (PRD §3.2), so the whole
 * namespace is invalidated on success. The screen can navigate the moment this
 * resolves because the service has already written the creator's membership into
 * the session store the router reads — the invalidated memberships refetch then
 * reconciles that optimistic entry with the server's own row.
 */
export function useCreateSociety() {
  const actorId = useActorId();
  const queryClient = useQueryClient();

  return useMutation<Society, unknown, CreateSocietyPayload>({
    mutationFn: (payload) => createSociety(requireActor(actorId), payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: societyKeys.all });
    },
  });
}

/**
 * Edit a society. Optimistic: the detail cache is patched and the list row renamed
 * immediately, then both are refetched to take the server's version.
 */
export function useUpdateSociety(societyId: string) {
  const actorId = useActorId();
  const queryClient = useQueryClient();

  return useMutation<Society, unknown, UpdateSocietyPayload, UpdateOptimisticContext>({
    mutationFn: (patch) => updateSociety(requireActor(actorId), societyId, patch),

    onMutate: async (patch) => {
      const detailKey = societyKeys.detail(societyId, actorId);
      const listKey = societyKeys.list(actorId);

      // Cancel in-flight reads first. A response already on the wire would
      // otherwise land after the optimistic write and visibly revert it.
      await Promise.all([
        queryClient.cancelQueries({ queryKey: detailKey }),
        queryClient.cancelQueries({ queryKey: listKey }),
      ]);

      const previousDetail = queryClient.getQueryData<Society | null>(detailKey);
      const previousList = queryClient.getQueryData<readonly SocietySummary[]>(listKey);

      if (previousDetail !== undefined && previousDetail !== null) {
        queryClient.setQueryData(detailKey, applySocietyPatch(previousDetail, patch));
      }
      if (previousList !== undefined) {
        queryClient.setQueryData(
          listKey,
          previousList.map((summary) => applySummaryPatch(summary, patch)),
        );
      }

      return { detailKey, previousDetail, listKey, previousList };
    },

    onError: (_error, _patch, context) => {
      if (context === undefined) return;
      // `undefined` means "nothing was cached", which is not the same as `null`
      // ("cached as absent") — restoring it would create a cache entry that
      // claims the society does not exist.
      if (context.previousDetail !== undefined) {
        queryClient.setQueryData(context.detailKey, context.previousDetail);
      }
      if (context.previousList !== undefined) {
        queryClient.setQueryData(context.listKey, context.previousList);
      }
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: societyKeys.detail(societyId, actorId) });
      void queryClient.invalidateQueries({ queryKey: societyKeys.list(actorId) });
    },
  });
}

export function useRegenerateJoinCode(societyId: string) {
  const actorId = useActorId();
  const queryClient = useQueryClient();

  return useMutation<Society, unknown, void>({
    mutationFn: () => regenerateJoinCode(requireActor(actorId), societyId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: societyKeys.all });
    },
  });
}

/**
 * Delete a society. Optimistic on the list: the row leaves immediately, so the user
 * is not left staring at the society they just confirmed deleting.
 */
export function useDeleteSociety(societyId: string) {
  const actorId = useActorId();
  const queryClient = useQueryClient();

  return useMutation<void, unknown, void, DeleteOptimisticContext>({
    mutationFn: () => deleteSociety(requireActor(actorId), societyId),

    onMutate: async () => {
      const listKey = societyKeys.list(actorId);

      // Only this key is written below, so only this key needs its in-flight
      // response cancelled.
      await queryClient.cancelQueries({ queryKey: listKey });

      const previousList = queryClient.getQueryData<readonly SocietySummary[]>(listKey);

      if (previousList !== undefined) {
        queryClient.setQueryData(
          listKey,
          previousList.filter((summary) => summary.id !== societyId),
        );
      }

      return { listKey, previousList };
    },

    onError: (_error, _variables, context) => {
      if (context === undefined) return;
      if (context.previousList !== undefined) {
        queryClient.setQueryData(context.listKey, context.previousList);
      }
    },

    onSettled: () => {
      // Memberships included, and that is the point: a delete removes the actor's
      // own membership, and the bootstrap mirrors that query into the store the
      // router reads to decide whether `(app)` is still reachable. The detail query
      // is refreshed here rather than optimistically — the server decides whether
      // the society is really gone.
      void queryClient.invalidateQueries({ queryKey: societyKeys.all });
    },
  });
}

export function useJoinSociety() {
  const actorId = useActorId();
  const queryClient = useQueryClient();

  return useMutation<SocietyMembership, unknown, JoinSocietyPayload>({
    mutationFn: (payload) => joinSociety(requireActor(actorId), payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: societyKeys.all });
    },
  });
}

export function useLeaveSociety(societyId: string) {
  const actorId = useActorId();
  const queryClient = useQueryClient();

  return useMutation<void, unknown, void>({
    mutationFn: () => leaveSociety(requireActor(actorId), societyId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: societyKeys.all });
    },
  });
}
