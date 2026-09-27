import { asStructureError, ok } from "@ses/domain";
import type {
  Building,
  BuildingId,
  Result,
  SocietyId,
  SocietyMembership,
  StructureCapabilities,
  UserId,
} from "@ses/domain";

import { loadBuildingContext } from "./support";
import type { StructureDeps } from "./support";

/**
 * View one building (PRD §3.2 step 2).
 *
 * Returns the building, the caller's membership and the capabilities derived from
 * it, in one object — the same shape `getSocietyProfile` returns and for the same
 * reason: the screen needs all three to render (the details, the caller's role
 * badge, and which actions to offer), and computing the capabilities in the domain
 * is what stops a screen from inventing its own permission logic.
 */
export interface BuildingView {
  readonly building: Building;
  readonly membership: SocietyMembership;
  readonly capabilities: StructureCapabilities;
}

export async function getBuilding(
  deps: StructureDeps,
  actor: UserId,
  societyId: SocietyId,
  buildingId: BuildingId,
): Promise<Result<BuildingView, ReturnType<typeof asStructureError>>> {
  const loaded = await loadBuildingContext(deps, actor, societyId, buildingId);
  if (!loaded.ok) return loaded;

  return ok({
    building: loaded.value.building,
    membership: loaded.value.membership,
    capabilities: loaded.value.capabilities,
  });
}
