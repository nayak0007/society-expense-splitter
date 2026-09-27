import { asStructureError, err, ok } from "@ses/domain";
import type { ApartmentId, Result, SocietyId, UserId } from "@ses/domain";

import { loadApartmentContext, requireStructureCapability } from "./support";
import type { StructureDeps } from "./support";

/**
 * Remove a flat (PRD §5; a flat that was never built, or a data-entry mistake).
 *
 * Soft delete, and it returns nothing. The port's contract is `deleted_at` rather
 * than a `DELETE`, and that is the adapter's obligation to describe rather than
 * this layer's to claim — `ApartmentRepository.remove` documents it. Members, dues
 * and meter readings will reference a flat, and PRD §3.1/§3.3 keep financial
 * history, so the row has to survive for those to keep their subject.
 *
 * ## Why this is simpler than deleting a *building*
 *
 * Nothing references an apartment yet, so there is no "still contains children"
 * rule to check — the check that exists is the opposite direction, and it lives in
 * `deleteBuilding`: a building cannot be removed while live flats point at it. When
 * `members.apartment_id` and `dues.apartment_id` land (T045+), this is the file that
 * grows the equivalent guard, and the shape to copy is `deleteBuilding`'s.
 */
export async function deleteApartment(
  deps: StructureDeps,
  actor: UserId,
  societyId: SocietyId,
  apartmentId: ApartmentId,
): Promise<Result<void, ReturnType<typeof asStructureError>>> {
  const loaded = await loadApartmentContext(
    deps,
    actor,
    societyId,
    apartmentId,
  );
  if (!loaded.ok) return loaded;

  const guard = requireStructureCapability(
    loaded.value.capabilities,
    "canManage",
    "Only a society Admin can change the society structure.",
  );
  if (!guard.ok) return guard;

  try {
    await deps.apartments.remove(apartmentId, societyId, actor);
    return ok(undefined);
  } catch (error: unknown) {
    return err(asStructureError(error));
  }
}
