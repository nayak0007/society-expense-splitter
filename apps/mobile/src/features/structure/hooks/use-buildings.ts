import type { Building, StructureCapabilities } from '@ses/domain';
import { useQuery } from '@tanstack/react-query';

import { selectAuthUser, useAuthStore } from '@/stores/auth.store';
import { selectActiveSocietyId, useSocietyStore } from '@/stores/society.store';

import { loadBuilding, loadBuildings } from '../services/building.service';

import { buildingKeys } from './building-keys';

/**
 * Building read hooks (React Query).
 *
 * Every read is scoped to the **active society** (`useSocietyStore`), not to a
 * route parameter, and that is deliberate rather than convenient: the API's
 * `SocietyGuard` resolves the tenant from the `X-Society-Id` header, which the
 * repository sends from the same store. Reading the society from one source and
 * writing it from another is how a screen ends up showing one society's buildings
 * while its edit button writes to another's.
 *
 * A screen that needs a different society's structure — a deep link, a switcher —
 * switches `activeSocietyId` first and lets the query swap, which is the flow SAD
 * §5.4 already prescribes for every entity in the app.
 *
 * Capabilities travel with the list because the domain computes them once, from the
 * membership, against the same matrix the API's `PermissionGuard` evaluates. A
 * screen that re-derived "may I edit this" from a role string would be a second
 * implementation of that matrix, and the failure mode is a visible button over a
 * refused request.
 */

export interface BuildingsResult {
  readonly buildings: readonly Building[];
  readonly capabilities: StructureCapabilities | null;
  readonly isLoading: boolean;
  readonly isRefreshing: boolean;
  readonly error: unknown;
  refetch: () => void;
}

/**
 * Every live building of the active society (PRD §5).
 *
 * Disabled until both a user and an active society are known: the list is
 * society-scoped, so firing it early would send a request with no tenant — which
 * the guard answers `400` by design.
 */
export function useBuildings(): BuildingsResult {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: buildingKeys.list(societyId, userId),
    queryFn: () => loadBuildings(userId ?? '', societyId ?? ''),
    enabled: userId !== null && societyId !== null,
  });

  return {
    buildings: query.data?.buildings ?? [],
    capabilities: query.data?.capabilities ?? null,
    isLoading: query.isPending && societyId !== null,
    isRefreshing: query.isFetching && !query.isPending,
    error: query.error,
    refetch: query.refetch,
  };
}

export interface BuildingResult {
  readonly building: Building | null;
  readonly capabilities: StructureCapabilities | null;
  readonly isLoading: boolean;
  readonly error: unknown;
  refetch: () => void;
}

/** One building of the active society — the edit screen's read. */
export function useBuilding(buildingId: string | null): BuildingResult {
  const user = useAuthStore(selectAuthUser);
  const societyId = useSocietyStore(selectActiveSocietyId);
  const userId = user?.id ?? null;

  const query = useQuery({
    queryKey: buildingKeys.detail(buildingId, societyId, userId),
    queryFn: () => loadBuilding(userId ?? '', societyId ?? '', buildingId ?? ''),
    enabled: userId !== null && societyId !== null && buildingId !== null,
  });

  return {
    building: query.data?.building ?? null,
    capabilities: query.data?.capabilities ?? null,
    isLoading: query.isPending && buildingId !== null,
    error: query.error,
    refetch: query.refetch,
  };
}
