import {
  asStructureError,
  err,
  evaluateStructureCapabilities,
  ok,
} from "@ses/domain";
import type {
  Apartment,
  BuildingId,
  Result,
  SocietyId,
  SocietyMembership,
  StructureCapabilities,
  UserId,
} from "@ses/domain";

import { loadBuildingContext, requireStructureCapability } from "./support";
import type { StructureDeps } from "./support";

/**
 * List the flats of one building (PRD §5; the structure step of onboarding, and the
 * Apartment Preview screen an Admin edits before inviting anyone).
 *
 * ## Why this is scoped to a building rather than to the society
 *
 * A society's flats number in the hundreds and are only ever *read* grouped — the
 * structure screen shows one building's floors, the join flow picks a flat inside a
 * building, and the Apartments Management screen (PRD §2, screen 73) filters by
 * building. A society-wide list would need pagination to be usable and would still
 * be filtered by building on every real screen, so the narrower endpoint is the one
 * that matches how the data is used.
 *
 * ## The building is loaded, and that is a rule rather than a detail
 *
 * `loadBuildingContext` — not just the caller's society membership — because a
 * building id from **another society** would otherwise answer `200 []`: the flats
 * query is scoped by `(building_id, society_id)`, so it would find nothing and
 * report "no flats yet" for a building the caller cannot see. That is not a leak of
 * data, but it *is* a distinguishable answer, and PRD T041 requires the opposite:
 * a building outside the caller's society must be indistinguishable from one that
 * does not exist. It also makes the empty list unambiguous — `[]` now means "this
 * building exists and has no flats", which is exactly what the screen needs in
 * order to offer "add your first flat".
 *
 * ## The empty list is a success, and `canManage` is what makes it actionable
 *
 * A building that was just created has no flats, so `[]` with `canManage: true` is
 * what lets the UI render "add your first flat" instead of an error state. A
 * *Guest*, whose role holds no `structure.view`, is refused with `forbidden` by the
 * capability guard below rather than being handed an empty list — "none yet" and
 * "not for you" must not be the same screen.
 */
export interface ApartmentList {
  readonly apartments: readonly Apartment[];
  readonly membership: SocietyMembership;
  readonly capabilities: StructureCapabilities;
}

export async function listApartments(
  deps: StructureDeps,
  actor: UserId,
  societyId: SocietyId,
  buildingId: BuildingId,
): Promise<Result<ApartmentList, ReturnType<typeof asStructureError>>> {
  const loaded = await loadBuildingContext(deps, actor, societyId, buildingId);
  if (!loaded.ok) return loaded;

  const guard = requireStructureCapability(
    loaded.value.capabilities,
    "canView",
    "Your role does not allow you to view the society structure.",
  );
  if (!guard.ok) return guard;

  try {
    const apartments = await deps.apartments.listApartments(
      buildingId,
      societyId,
      actor,
    );
    return ok({
      apartments,
      membership: loaded.value.membership,
      // Re-derived rather than carried over from `loadStructureContext`, so the
      // capabilities on the wire are evaluated from the same membership returned
      // beside them. `evaluateStructureCapabilities` is a pure function of the
      // membership, so this is the same answer — stated explicitly because a
      // response that ships `capabilities` and `membership` from two different
      // evaluations is a response that can contradict itself.
      capabilities: evaluateStructureCapabilities(loaded.value.membership),
    });
  } catch (error: unknown) {
    return err(asStructureError(error));
  }
}
