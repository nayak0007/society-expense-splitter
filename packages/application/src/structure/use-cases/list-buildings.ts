import { asStructureError, err, ok } from "@ses/domain";
import type {
  Building,
  Result,
  SocietyId,
  SocietyMembership,
  StructureCapabilities,
  UserId,
} from "@ses/domain";

import { loadStructureContext, requireStructureCapability } from "./support";
import type { StructureDeps } from "./support";

/**
 * List a society's buildings (PRD §3.2 step 2 — the structure screen).
 *
 * ## Why the reading role is checked here and not only in SQL
 *
 * The repository's query runs under RLS, which already returns nothing to a
 * non-member — so this guard changes no outcome for a member. It changes the
 * *answer*: an empty list is indistinguishable from a society with no buildings
 * yet, and a Guest (who holds no `structure.view` grant) would see a plausible
 * empty state rather than being told their role cannot view the structure. "No
 * buildings yet" and "not for you" must not be the same screen.
 *
 * ## Why an empty list is not an error
 *
 * A society that has just been created genuinely has no buildings, and the
 * structure step is the screen that fixes that. Returning `[]` with
 * `canManage: true` is what lets the UI render "add your first building" instead
 * of an error state.
 */
export interface BuildingList {
  readonly buildings: readonly Building[];
  readonly membership: SocietyMembership;
  readonly capabilities: StructureCapabilities;
}

export async function listBuildings(
  deps: StructureDeps,
  actor: UserId,
  societyId: SocietyId,
): Promise<Result<BuildingList, ReturnType<typeof asStructureError>>> {
  const loaded = await loadStructureContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  const guard = requireStructureCapability(
    loaded.value.capabilities,
    "canView",
    "Your role in this society cannot view its structure.",
  );
  if (!guard.ok) return guard;

  try {
    // Ordering is the repository's: `display_order`, then `name`. Doing it here
    // instead would mean sorting an already-sorted page in memory, which is the
    // same answer for the first page and the wrong one for the second.
    const buildings = await deps.buildings.listBuildings(societyId, actor);

    return ok({
      buildings,
      membership: loaded.value.membership,
      capabilities: loaded.value.capabilities,
    });
  } catch (error: unknown) {
    return err(asStructureError(error));
  }
}
