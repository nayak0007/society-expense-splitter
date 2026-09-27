import { asBuildingId } from '@ses/domain';

import { useApartments } from './use-apartments';
import { useBuildings } from './use-buildings';

/**
 * The flat lookup every picker needs: a society's buildings, and the flats inside one of them.
 *
 * ## Why it lives in this feature
 *
 * It is a **structure** read — buildings and flats are this feature's entities — and the
 * preset's own rule is that a feature may not import another feature's code
 * (`no-restricted-imports`: "Shared code belongs in src/lib or packages/*"). So a screen that
 * needs to *choose* a flat (the member form does) does not reach into this feature from inside
 * its own: the **route** composes the two, exactly as `app/` composes every feature, and hands
 * the result to the members feature's picker as a prop.
 *
 * The alternative — a second HTTP client for the same two endpoints inside the members feature —
 * would be two caches for one society's structure, and the version that goes stale is the one
 * the user is looking at.
 *
 * ## The reads are the structure screens' own queries
 *
 * Same hooks, so same cache entries: opening the member form after visiting a building costs no
 * request, and the society scoping stays where it is defined (the active society from the store)
 * rather than being restated here.
 */

export interface FlatOption {
  readonly id: string;
  /** `A-101 · Tower A` — the flat number first, because that is what people know. */
  readonly label: string;
}

export interface FlatOptionsResult {
  readonly buildings: readonly { readonly value: string; readonly label: string }[];
  readonly flats: readonly FlatOption[];
  readonly isLoadingFlats: boolean;
}

export function useFlatOptions(buildingId: string | null): FlatOptionsResult {
  const { buildings, isLoading: isLoadingBuildings } = useBuildings();
  // The id arrives from a form field, which holds a plain string; the brand is what the
  // apartment hook's port declares, so this is the boundary where a form value becomes a scope.
  const { apartments, isLoading: isLoadingApartments } = useApartments(
    buildingId === null ? null : asBuildingId(buildingId),
  );

  const nameOf = new Map<string, string>(
    buildings.map((building) => [String(building.id), building.name]),
  );

  return {
    buildings: buildings.map((building) => ({ value: building.id, label: building.name })),
    flats: apartments.map((apartment) => ({
      id: apartment.id,
      label:
        buildingId === null
          ? apartment.apartmentNumber
          : `${apartment.apartmentNumber} · ${nameOf.get(buildingId) ?? 'Building'}`,
    })),
    isLoadingFlats: buildingId !== null && (isLoadingApartments || isLoadingBuildings),
  };
}
