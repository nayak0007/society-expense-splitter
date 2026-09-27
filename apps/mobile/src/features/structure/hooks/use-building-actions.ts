import type { BuildingList } from '@ses/application';
import type { CreateBuildingPayload, UpdateBuildingPayload } from '@ses/contracts';
import { compareBuildings, StructureError } from '@ses/domain';
import type { Building } from '@ses/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';

import { createBuilding, deleteBuilding, updateBuilding } from '../services/building.service';

import { apartmentKeys } from './apartment-keys';
import { buildingKeys } from './building-keys';

/**
 * Building write hooks.
 *
 * ## The scope comes from the session, never from a screen argument
 *
 * Both the actor and the society are read from the stores here rather than passed
 * in, matching the read hooks. A screen that supplied them could be wrong; the
 * session cannot, and the value the repository puts in the `X-Society-Id` header
 * is then by construction the value the query keys are scoped by.
 *
 * ## Which mutations are optimistic, and why
 *
 * `update` is — on both the detail and the list. An edit replaces a row the client
 * just read, so it already holds every value the server will return and can show
 * the result before the round trip lands. The list is **re-sorted** with the
 * domain's own `compareBuildings` after patching: a building whose display order
 * the user just changed would otherwise sit at its old position until the refetch,
 * which reads as the edit not having worked.
 *
 * `delete` is optimistic on the **list only**. The row leaving is the outcome the
 * user asked for and the list is where they return to; the detail query is left
 * alone because the edit screen is still mounted showing the confirmation the user
 * just acted on, and writing `null` there would blank the screen in front of them
 * before the navigation.
 *
 * `delete` additionally invalidates the **apartment** namespace, which is the one
 * place the two features genuinely meet: a building's removal stales the flats that
 * belonged to it, and a *refused* removal ("this building still has 12 flats") is
 * precisely when a stale flat list would be most misleading — the user is being sent
 * to a list they have not refreshed since the count was read.
 *
 * `create` is deliberately **not** optimistic, for the same reason society creation
 * is not: the server mints the id, and every query key, the detail cache and the
 * edit route are addressed by that id — so an optimistic row would be a fabricated
 * entity with an invented id. One round trip is the correct trade.
 *
 * No hook here touches the routing store: a building is not a tenant, so nothing
 * about `activeSocietyId` or the memberships snapshot changes when one is written.
 * That is the whole difference from the society actions, and it is why a failed
 * building write has nothing to roll back outside the query cache.
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
 * Resolved at call time rather than during render — a hook must never throw while
 * React is rendering, and by the time a mutation runs the session is a fact.
 */
function requireScope(scope: Scope): { readonly actorId: string; readonly societyId: string } {
  if (scope.actorId === null) {
    throw new StructureError('forbidden', 'Your session expired. Please sign in again.');
  }
  if (scope.societyId === null) {
    throw new StructureError('not_found', 'Switch to a society to manage its buildings.');
  }
  return { actorId: scope.actorId, societyId: scope.societyId };
}

/**
 * The optimistic `Building`, mirroring the use case's semantics exactly: an
 * **absent** field is unchanged.
 *
 * There is no "cleared" case here, unlike the society patch — a floor count is
 * never cleared to unknown (the entity records that it can only be set at
 * creation), so absence has exactly one meaning on this entity. Fields the server
 * owns, `updatedAt` above all, are left alone rather than guessed at.
 */
function applyBuildingPatch(building: Building, patch: UpdateBuildingPayload): Building {
  return {
    ...building,
    name: patch.name ?? building.name,
    totalFloors: patch.totalFloors ?? building.totalFloors,
    displayOrder: patch.displayOrder ?? building.displayOrder,
  };
}

/**
 * The cache holds the use case's `BuildingList`, not a bare array.
 *
 * This is worth spelling out because nothing in the types catches getting it wrong:
 * `useQuery` caches whatever `queryFn` returned, and that is the list object —
 * buildings **and** capabilities **and** the membership they were evaluated from.
 * An optimistic branch that read `readonly Building[]` out of that key would be
 * handed an object and would throw on `.map`/`.filter` at the one moment the user is
 * waiting for a save, and the error would surface as "something went wrong" on a
 * write the server never rejected. Every branch below therefore reads and writes the
 * list object and preserves its capabilities, which a building's own fields cannot
 * change.
 */
interface UpdateOptimisticContext {
  readonly detailKey: readonly unknown[];
  readonly previousDetail: Building | null | undefined;
  readonly listKey: readonly unknown[];
  readonly previousList: BuildingList | undefined;
}

interface DeleteOptimisticContext {
  readonly listKey: readonly unknown[];
  readonly previousList: BuildingList | undefined;
}

/** Create a building. Nothing to patch — the id does not exist yet. */
export function useCreateBuilding() {
  const scope = useScope();
  const queryClient = useQueryClient();

  return useMutation<Building, unknown, CreateBuildingPayload>({
    mutationFn: (payload) => {
      const { actorId, societyId } = requireScope(scope);
      return createBuilding(actorId, societyId, payload);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: buildingKeys.all });
    },
  });
}

/** Edit a building. Optimistic on the detail and on the list, then refetched. */
export function useUpdateBuilding(buildingId: string | null) {
  const scope = useScope();
  const queryClient = useQueryClient();

  return useMutation<Building, unknown, UpdateBuildingPayload, UpdateOptimisticContext>({
    mutationFn: (patch) => {
      const { actorId, societyId } = requireScope(scope);
      if (buildingId === null) {
        throw new StructureError('not_found', 'That building is not available to you.');
      }
      return updateBuilding(actorId, societyId, buildingId, patch);
    },

    onMutate: async (patch) => {
      const detailKey = buildingKeys.detail(buildingId, scope.societyId, scope.actorId);
      const listKey = buildingKeys.list(scope.societyId, scope.actorId);

      // Cancel in-flight reads first: a response already on the wire would land
      // after the optimistic write and visibly revert it.
      await Promise.all([
        queryClient.cancelQueries({ queryKey: detailKey }),
        queryClient.cancelQueries({ queryKey: listKey }),
      ]);

      const previousDetail = queryClient.getQueryData<Building | null>(detailKey);
      const previousList = queryClient.getQueryData<BuildingList>(listKey);

      if (previousDetail !== undefined && previousDetail !== null) {
        queryClient.setQueryData(detailKey, applyBuildingPatch(previousDetail, patch));
      }
      if (previousList !== undefined) {
        queryClient.setQueryData(listKey, {
          ...previousList,
          buildings: previousList.buildings
            .map((building) =>
              building.id === buildingId ? applyBuildingPatch(building, patch) : building,
            )
            .sort(compareBuildings),
        });
      }

      return { detailKey, previousDetail, listKey, previousList };
    },

    onError: (_error, _patch, context) => {
      if (context === undefined) return;
      // `undefined` means "nothing was cached", which is not `null` ("cached as
      // absent") — restoring it would create an entry claiming the building does
      // not exist.
      if (context.previousDetail !== undefined) {
        queryClient.setQueryData(context.detailKey, context.previousDetail);
      }
      if (context.previousList !== undefined) {
        queryClient.setQueryData(context.listKey, context.previousList);
      }
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: buildingKeys.all });
    },
  });
}

/** Soft-delete a building. Optimistic on the list; the detail self-corrects. */
export function useDeleteBuilding(buildingId: string | null) {
  const scope = useScope();
  const queryClient = useQueryClient();

  return useMutation<void, unknown, void, DeleteOptimisticContext>({
    mutationFn: () => {
      const { actorId, societyId } = requireScope(scope);
      if (buildingId === null) {
        throw new StructureError('not_found', 'That building is not available to you.');
      }
      return deleteBuilding(actorId, societyId, buildingId);
    },

    onMutate: async () => {
      const listKey = buildingKeys.list(scope.societyId, scope.actorId);

      // Only this key is written below, so only this key needs its in-flight
      // response cancelled.
      await queryClient.cancelQueries({ queryKey: listKey });

      const previousList = queryClient.getQueryData<BuildingList>(listKey);

      if (previousList !== undefined) {
        queryClient.setQueryData(listKey, {
          ...previousList,
          buildings: previousList.buildings.filter((building) => building.id !== buildingId),
        });
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
      // The whole namespace, because a delete can change what a *list* read would
      // return in ways the optimistic filter cannot predict — a display order the
      // server renumbers, say. The server is the authority on what remains.
      void queryClient.invalidateQueries({ queryKey: buildingKeys.all });
      // And the flats that belonged to it, or that were the reason it was refused.
      void queryClient.invalidateQueries({ queryKey: apartmentKeys.all });
    },
  });
}
