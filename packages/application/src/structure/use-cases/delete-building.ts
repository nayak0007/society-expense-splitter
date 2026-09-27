import { asStructureError, err, ok, structureError } from "@ses/domain";
import type { BuildingId, Result, SocietyId, UserId } from "@ses/domain";

import { loadBuildingContext, requireStructureCapability } from "./support";
import type { StructureDeps } from "./support";

/**
 * Delete a building (PRD §3.2 step 2, "edit buildings" includes removing one).
 *
 * Soft delete, and it returns nothing. The port's contract is `deleted_at` rather
 * than a `DELETE`, and that is not the use case's decision to make or describe —
 * `BuildingRepository.remove` documents it as the adapter's obligation, so the
 * application layer makes no claim about physical deletion. Apartments, dues and
 * expenses will reference a building, and PRD §3.1/§3.3 keep financial history;
 * the row has to survive for those to keep their owner.
 *
 * ## A building with flats is refused, and the refusal is a rule
 *
 * Roadmap T042's acceptance requires deletion to be **blocked while the building
 * contains apartments**; it lands here, with the slice that creates the
 * dependency. Removing a building that still has live flats would take the flats'
 * parent with it — and, once `members.apartment_id` exists (T045+), orphan the
 * members attached to them. The database refuses it too
 * (`building_soft_delete()` raises `BUILDING_HAS_APARTMENTS`), because a rule that
 * only a use case checks is a rule a repair script does not have.
 *
 * The check runs **before** the delete and returns `building_has_apartments`, not
 * `conflict`: the two say different things to a user and need different copy
 * (see `STRUCTURE_ERROR_CODES`), and collapsing them would force the UI to match
 * on a message string to tell "rename it" from "empty it first".
 *
 * ## Why the count comes from the apartments port
 *
 * `deps.apartments.countForBuilding` — the port that owns the table being counted.
 * `BuildingRepository` could have grown a `hasApartments()`, but then the building
 * adapter would read a table it does not own, and the number would be unavailable
 * for the message. The count is scoped by `(buildingId, societyId, actor)` like
 * every other read, so it can only ever count flats the caller may see.
 *
 * The count is *advisory*: it is included in `details` so the message can say how
 * many, but nothing branches on it. Between this read and the delete another request
 * could add a flat — which is precisely why the database check exists as well, and
 * why the answer to a race is the same typed error rather than a 500.
 */
export async function deleteBuilding(
  deps: StructureDeps,
  actor: UserId,
  societyId: SocietyId,
  buildingId: BuildingId,
): Promise<Result<void, ReturnType<typeof asStructureError>>> {
  const loaded = await loadBuildingContext(deps, actor, societyId, buildingId);
  if (!loaded.ok) return loaded;

  const guard = requireStructureCapability(
    loaded.value.capabilities,
    "canManage",
    "Only a society Admin can change the society structure.",
  );
  if (!guard.ok) return guard;

  try {
    // The rule the database also enforces (`building_soft_delete`), stated here so
    // the caller gets a typed refusal with copy instead of a raw FK/raise the
    // adapter would have to guess the meaning of.
    const apartmentCount = await deps.apartments.countForBuilding(
      buildingId,
      societyId,
      actor,
    );

    if (apartmentCount > 0) {
      return err(
        structureError(
          "building_has_apartments",
          apartmentCount === 1
            ? "This building still has 1 flat. Remove it first."
            : `This building still has ${apartmentCount} flats. Remove them first.`,
          { count: apartmentCount },
        ),
      );
    }

    await deps.buildings.remove(buildingId, societyId, actor);
    return ok(undefined);
  } catch (error: unknown) {
    return err(asStructureError(error));
  }
}
