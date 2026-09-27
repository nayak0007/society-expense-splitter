import type { ApartmentList } from '@ses/application';
import type { CreateApartmentPayload, UpdateApartmentPayload } from '@ses/contracts';
import { asWingId, compareApartments, StructureError } from '@ses/domain';
import type { Apartment } from '@ses/domain';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';

import { createApartment, deleteApartment, updateApartment } from '../services/apartment.service';

import { apartmentKeys } from './apartment-keys';
import { buildingKeys } from './building-keys';

/**
 * Flat write hooks.
 *
 * ## The scope comes from the session, never from a screen argument
 *
 * Both the actor and the society are read from the stores here rather than passed
 * in, matching the read hooks; the building is passed in because it is what the
 * route knows and the user chose. The value the repository puts in the
 * `X-Society-Id` header is then by construction the value the query keys are scoped
 * by.
 *
 * ## The cache holds the whole `ApartmentList`, not the array
 *
 * This is the detail the building hooks got subtly wrong, and it is worth stating
 * because nothing about it is visible in the types: `useQuery` caches whatever
 * `queryFn` returned, and that is the use case's `ApartmentList` — flats **and**
 * capabilities **and** the membership they were evaluated from. An optimistic
 * branch that read `readonly Apartment[]` out of that key would be handed an object
 * and would throw on `.map` at the one moment the user is waiting for a save. So
 * every branch below reads and writes the list object and preserves its
 * capabilities, which are not affected by a flat's values.
 *
 * ## Which mutations are optimistic, and why
 *
 * `update` is — on both the detail and the list. An edit replaces a row the client
 * just read, so it already holds every value the server will return and can show the
 * result before the round trip lands. The list is **re-sorted** with the domain's
 * own `compareApartments` after patching: a flat whose floor the user just changed
 * would otherwise sit at its old position until the refetch, which reads as the edit
 * not having worked — and the comparator is the same byte-wise order the database's
 * index uses, so the optimistic position and the server's agree.
 *
 * `delete` is optimistic on the **list only**. The row leaving is the outcome the
 * user asked for and the list is where they return to; the detail query is left
 * alone because the edit screen is still mounted showing the confirmation the user
 * just acted on, and writing `null` there would blank the screen in front of them
 * before the navigation.
 *
 * `create` is deliberately **not** optimistic: the server mints the id, and every
 * query key, the detail cache and the edit route are addressed by that id — so an
 * optimistic row would be a fabricated entity with an invented id.
 *
 * ## Writes invalidate the parent building, and that is insurance stated as such
 *
 * Nothing in today's `Building` payload depends on its flats, so invalidating
 * `buildingKeys` on a flat write changes no value any screen reads. It is one line
 * that makes the two namespaces correct *by construction* rather than correct until
 * a building grows a flat count or a summary — and the obvious next change to this
 * feature is exactly that. A building's removal, by contrast, genuinely does stale
 * the flat list, and `useDeleteBuilding` invalidates this namespace too.
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
    throw new StructureError('not_found', 'Switch to a society to manage its flats.');
  }
  return { actorId: scope.actorId, societyId: scope.societyId };
}

/**
 * The optimistic `Apartment`, mirroring the use case's semantics exactly: an
 * **absent** field is unchanged, and an explicit `null` clears a nullable one.
 *
 * That second half is the difference from `applyBuildingPatch`, and it is not
 * cosmetic: a user who empties the carpet-area field is asking for the area to stop
 * being recorded, and an optimistic update that treated `null` as "no change" would
 * show the old number until the refetch — then remove it, with no explanation.
 * Fields the server owns, `updatedAt` above all, are left alone rather than guessed
 * at.
 */
function applyApartmentPatch(apartment: Apartment, patch: UpdateApartmentPayload): Apartment {
  const pick = <TValue>(sent: TValue | undefined, stored: TValue): TValue =>
    sent === undefined ? stored : sent;

  return {
    ...apartment,
    apartmentNumber: pick(patch.apartmentNumber, apartment.apartmentNumber),
    // Spelled out: the wire carries a plain string and the entity a branded
    // `WingId`, so this is the one field the helper cannot serve.
    wingId:
      patch.wingId === undefined
        ? apartment.wingId
        : patch.wingId === null
          ? null
          : asWingId(patch.wingId),
    floor: pick(patch.floor, apartment.floor),
    bhk: pick(patch.bhk, apartment.bhk),
    carpetAreaSqft: pick(patch.carpetAreaSqft, apartment.carpetAreaSqft),
    builtupAreaSqft: pick(patch.builtupAreaSqft, apartment.builtupAreaSqft),
    parkingSlots: pick(patch.parkingSlots, apartment.parkingSlots),
    shareUnits: pick(patch.shareUnits, apartment.shareUnits),
    occupancyStatus: pick(patch.occupancyStatus, apartment.occupancyStatus),
    isCommercial: pick(patch.isCommercial, apartment.isCommercial),
    isBillable: pick(patch.isBillable, apartment.isBillable),
  };
}

interface UpdateOptimisticContext {
  readonly detailKey: readonly unknown[];
  readonly previousDetail: Apartment | null | undefined;
  /** `null` when no cached detail told us which building's list to patch. */
  readonly listKey: readonly unknown[] | null;
  readonly previousList: ApartmentList | undefined;
}

interface DeleteOptimisticContext {
  readonly listKey: readonly unknown[];
  readonly previousList: ApartmentList | undefined;
}

/**
 * Create a flat in one building.
 *
 * Nothing to patch — the id does not exist yet — so the cache is invalidated rather
 * than written. The parent building is invalidated beside it; see the note above on
 * why that is insurance.
 */
export function useCreateApartment(buildingId: string | null) {
  const scope = useScope();
  const queryClient = useQueryClient();

  return useMutation<Apartment, unknown, CreateApartmentPayload>({
    mutationFn: (payload) => {
      const { actorId, societyId } = requireScope(scope);
      if (buildingId === null) {
        throw new StructureError('not_found', 'That building is not available to you.');
      }
      return createApartment(actorId, societyId, buildingId, payload);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: apartmentKeys.all });
      void queryClient.invalidateQueries({ queryKey: buildingKeys.all });
    },
  });
}

/** Edit a flat. Optimistic on the detail and on the list, then refetched. */
export function useUpdateApartment(apartmentId: string | null) {
  const scope = useScope();
  const queryClient = useQueryClient();

  return useMutation<Apartment, unknown, UpdateApartmentPayload, UpdateOptimisticContext>({
    mutationFn: (patch) => {
      const { actorId, societyId } = requireScope(scope);
      if (apartmentId === null) {
        throw new StructureError('not_found', 'That flat is not available to you.');
      }
      return updateApartment(actorId, societyId, apartmentId, patch);
    },

    onMutate: async (patch) => {
      const detailKey = apartmentKeys.detail(apartmentId, scope.societyId, scope.actorId);
      // The list key carries the building, which this hook is not told: the flat's
      // own `buildingId` is read from the cached detail, and when there is no cached
      // detail there is nothing to patch optimistically — the refetch on settle is
      // what fills both caches.
      const previousDetail = queryClient.getQueryData<Apartment>(detailKey);
      const listKey =
        previousDetail === undefined
          ? null
          : apartmentKeys.list(previousDetail.buildingId, scope.societyId, scope.actorId);

      // Cancel in-flight reads first: a response already on the wire would land
      // after the optimistic write and visibly revert it.
      await queryClient.cancelQueries({ queryKey: detailKey });
      if (listKey !== null) {
        await queryClient.cancelQueries({ queryKey: listKey });
      }

      const previousList =
        listKey === null ? undefined : queryClient.getQueryData<ApartmentList>(listKey);

      if (previousDetail !== undefined) {
        queryClient.setQueryData(detailKey, applyApartmentPatch(previousDetail, patch));
      }
      if (listKey !== null && previousList !== undefined) {
        queryClient.setQueryData(listKey, {
          ...previousList,
          apartments: previousList.apartments
            .map((apartment) =>
              apartment.id === apartmentId ? applyApartmentPatch(apartment, patch) : apartment,
            )
            .sort(compareApartments),
        });
      }

      return { detailKey, previousDetail, listKey, previousList };
    },

    onError: (_error, _patch, context) => {
      if (context === undefined) return;
      // `undefined` means "nothing was cached", which is not `null` ("cached as
      // absent") — restoring it would create an entry claiming the flat does not
      // exist.
      if (context.previousDetail !== undefined) {
        queryClient.setQueryData(context.detailKey, context.previousDetail);
      }
      if (context.listKey !== null && context.previousList !== undefined) {
        queryClient.setQueryData(context.listKey, context.previousList);
      }
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: apartmentKeys.all });
      void queryClient.invalidateQueries({ queryKey: buildingKeys.all });
    },
  });
}

/** Soft-delete a flat. Optimistic on the list; the detail self-corrects. */
export function useDeleteApartment(apartmentId: string | null) {
  const scope = useScope();
  const queryClient = useQueryClient();

  return useMutation<void, unknown, void, DeleteOptimisticContext>({
    mutationFn: () => {
      const { actorId, societyId } = requireScope(scope);
      if (apartmentId === null) {
        throw new StructureError('not_found', 'That flat is not available to you.');
      }
      return deleteApartment(actorId, societyId, apartmentId);
    },

    onMutate: async () => {
      // Which building's list to patch is discovered from the cache the same way the
      // update path does it: an id alone does not say which list holds the row.
      const societyId = scope.societyId;
      const matches = queryClient.getQueriesData<ApartmentList>({
        queryKey: ['apartment', 'list', societyId],
      });

      const target = matches.find(([, data]) =>
        data?.apartments.some((apartment) => apartment.id === apartmentId),
      );
      if (target === undefined) {
        return { listKey: apartmentKeys.all, previousList: undefined };
      }

      const [listKey, previousList] = target;
      // Only this key is written below, so only this key needs its in-flight
      // response cancelled.
      await queryClient.cancelQueries({ queryKey: listKey });

      if (previousList !== undefined) {
        queryClient.setQueryData(listKey, {
          ...previousList,
          apartments: previousList.apartments.filter((apartment) => apartment.id !== apartmentId),
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
      // return in ways the optimistic filter cannot predict — the server is the
      // authority on what remains. The parent building is invalidated too: its
      // delete affordance is a question about how many flats are left.
      void queryClient.invalidateQueries({ queryKey: apartmentKeys.all });
      void queryClient.invalidateQueries({ queryKey: buildingKeys.all });
    },
  });
}
