import type { Apartment, StructureCapabilities } from '@ses/domain';
import { useQuery } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';

import { loadApartment, loadApartments } from '../services/apartment.service';

import { apartmentKeys } from './apartment-keys';

/**
 * Flat read hooks (React Query).
 *
 * Scoped to the **active society** read from the store, not to a route parameter,
 * and to the building from the route — the same split `use-building-actions` uses
 * for writes. The society is a session fact (the repository sends the same value in
 * the `X-Society-Id` header), while the building is what the user navigated into.
 * Reading the society from one source and sending it from another is how a screen
 * ends up showing one society's flats while its edit button writes to another's.
 *
 * Capabilities travel with the list because the domain computes them once, from the
 * membership, against the same matrix the API's `PermissionGuard` evaluates. A
 * screen that re-derived "may I edit this" from a role string would be a second
 * implementation of that matrix, and the failure mode is a visible button over a
 * refused request.
 */

export interface ApartmentsResult {
  readonly apartments: readonly Apartment[];
  readonly capabilities: StructureCapabilities | null;
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly error: unknown;
  refetch: () => void;
}

/**
 * Every live flat of one building, in floor then flat-number order (PRD §2 screen
 * 73, §5).
 *
 * Disabled until a user, an active society and a building are all known: the list is
 * society-scoped, so firing it early would send a request with no tenant — which the
 * guard answers `400` by design.
 */
export function useApartments(buildingId: string | null): ApartmentsResult {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: apartmentKeys.list(buildingId, societyId, userId),
    queryFn: () => loadApartments(userId ?? '', societyId ?? '', buildingId ?? ''),
    enabled: userId !== null && societyId !== null && buildingId !== null,
  });

  return {
    apartments: query.data?.apartments ?? [],
    capabilities: query.data?.capabilities ?? null,
    isLoading: query.isPending && buildingId !== null,
    isRefreshing: query.isFetching && !query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}

export interface ApartmentResult {
  readonly apartment: Apartment | null;
  readonly capabilities: StructureCapabilities | null;
  readonly isLoading: boolean;
  readonly error: unknown;
  refetch: () => void;
}

/** One flat of the active society — the edit screen's read. */
export function useApartment(apartmentId: string | null): ApartmentResult {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: apartmentKeys.detail(apartmentId, societyId, userId),
    queryFn: () => loadApartment(userId ?? '', societyId ?? '', apartmentId ?? ''),
    enabled: userId !== null && societyId !== null && apartmentId !== null,
  });

  return {
    apartment: query.data?.apartment ?? null,
    capabilities: query.data?.capabilities ?? null,
    isLoading: query.isPending && apartmentId !== null,
    error: query.error,
    refetch: query.refetch,
  };
}
