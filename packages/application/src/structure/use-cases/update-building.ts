import {
  asStructureError,
  createBuildingName,
  createDisplayOrder,
  createTotalFloors,
  err,
  ok,
  structureError,
} from "@ses/domain";
import type {
  Building,
  BuildingId,
  Result,
  SocietyId,
  UpdateBuildingInput,
  UserId,
} from "@ses/domain";

import { loadBuildingContext, requireStructureCapability } from "./support";
import type { StructureDeps } from "./support";

/**
 * Edit a building (PRD §3.2 step 2, "edit buildings").
 *
 * Admin-only, and the guard is the domain's own capability rather than a role
 * string compared inline — one definition, shared with the RLS policy and the UI
 * affordance.
 *
 * ## Absent means unchanged, and there is no third state
 *
 * A field that is `undefined` is left alone; the repository ignores it. Unlike
 * the society's patch there is no "clear this field" spelling, because a building
 * has no nullable *text* field: `name` is required, and `totalFloors` is a number
 * whose absence is already the default. Adding an empty-string-means-null rule
 * here would create a way to say "unrecord the floor count" that nothing in the
 * product asks for and that no form would ever produce.
 *
 * ## The patch is validated as a whole, not field by field
 *
 * Every value is checked through the same value objects the create path uses, and
 * the resulting `UpdateBuildingInput` carries only the keys the caller actually
 * set. Sending the *merged* object instead would make an edit that changed only
 * the display order also rewrite the name — which is harmless for the name and
 * actively wrong the moment a second writer has changed it in between.
 */
export interface UpdateBuildingCommand {
  readonly name?: string | undefined;
  readonly totalFloors?: number | undefined;
  readonly displayOrder?: number | undefined;
}

export async function updateBuilding(
  deps: StructureDeps,
  actor: UserId,
  societyId: SocietyId,
  buildingId: BuildingId,
  command: UpdateBuildingCommand,
): Promise<Result<Building, ReturnType<typeof asStructureError>>> {
  const loaded = await loadBuildingContext(deps, actor, societyId, buildingId);
  if (!loaded.ok) return loaded;

  const guard = requireStructureCapability(
    loaded.value.capabilities,
    "canManage",
    "Only a society Admin can change the society structure.",
  );
  if (!guard.ok) return guard;

  if (!hasAnyField(command)) {
    // The wire contract refuses an empty patch too, so this is the second line:
    // a caller that reached the use case directly (a script, a test, the mobile
    // service) gets the same answer rather than a no-op write.
    return err(structureError("validation", "Nothing to update."));
  }

  const patch: {
    name?: string;
    totalFloors?: number;
    displayOrder?: number;
  } = {};

  if (command.name !== undefined) {
    const name = createBuildingName(command.name);
    if (!name.ok) return name;
    patch.name = name.value;
  }

  if (command.totalFloors !== undefined) {
    const floors = createTotalFloors(command.totalFloors);
    if (!floors.ok) return floors;
    // `createTotalFloors` answers `null` only for an absent value, which this
    // branch has already excluded — so the narrow is structural rather than a
    // fallback, and it is what keeps `totalFloors` out of the patch type.
    if (floors.value !== null) patch.totalFloors = floors.value;
  }

  if (command.displayOrder !== undefined) {
    const displayOrder = createDisplayOrder(command.displayOrder);
    if (!displayOrder.ok) return displayOrder;
    patch.displayOrder = displayOrder.value;
  }

  const input: UpdateBuildingInput = patch;

  try {
    return ok(await deps.buildings.update(buildingId, societyId, input, actor));
  } catch (error: unknown) {
    return err(asStructureError(error));
  }
}

function hasAnyField(command: UpdateBuildingCommand): boolean {
  return Object.values(command).some((value) => value !== undefined);
}
