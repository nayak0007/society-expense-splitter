import {
  asStructureError,
  createBuildingName,
  createDisplayOrder,
  createTotalFloors,
  err,
  ok,
} from "@ses/domain";
import type { Building, Result, SocietyId, UserId } from "@ses/domain";

import { loadStructureContext, requireStructureCapability } from "./support";
import type { StructureDeps } from "./support";

/**
 * Create a building (PRD §3.2 step 2, "create society → define structure").
 *
 * The command is raw, wire-shaped input — every field is unvalidated by the time
 * it arrives, which is the point: validation happens *here*, through the value
 * objects, so the API, a seed script and a test all get the same rules and the
 * same field-level errors. Nothing reaches the repository until the aggregate is
 * coherent.
 *
 * Admin-only, and the guard is the domain's `canManageStructure` capability rather
 * than a role literal compared inline — one definition, read by the API guard, the
 * RLS policy and the UI affordance alike (SAD §9.3).
 */
export interface CreateBuildingCommand {
  readonly name: string;
  readonly totalFloors?: number | undefined;
  readonly displayOrder?: number | undefined;
}

export async function createBuilding(
  deps: StructureDeps,
  actor: UserId,
  societyId: SocietyId,
  command: CreateBuildingCommand,
): Promise<Result<Building, ReturnType<typeof asStructureError>>> {
  const loaded = await loadStructureContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  const guard = requireStructureCapability(
    loaded.value.capabilities,
    "canManage",
    "Only a society Admin can change the society structure.",
  );
  if (!guard.ok) return guard;

  const name = createBuildingName(command.name);
  if (!name.ok) return name;

  const floors = createTotalFloors(command.totalFloors);
  if (!floors.ok) return floors;

  const displayOrder = createDisplayOrder(command.displayOrder);
  if (!displayOrder.ok) return displayOrder;

  // `?? undefined` and not `?? null`: the input type deliberately has no way to
  // spell "clear the floor count" on a create, so an absent value stays absent and
  // the column's nullable default does the rest.
  const input = {
    name: name.value,
    totalFloors: floors.value ?? undefined,
    displayOrder: displayOrder.value,
  };

  try {
    return ok(await deps.buildings.create(societyId, input, actor));
  } catch (error: unknown) {
    return err(asStructureError(error));
  }
}
