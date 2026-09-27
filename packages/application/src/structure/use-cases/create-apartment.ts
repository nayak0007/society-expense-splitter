import {
  asStructureError,
  createApartmentNumber,
  createArea,
  createAreaPair,
  createBhk,
  createFloor,
  createOccupancyStatus,
  createParkingSlots,
  createShareUnits,
  err,
  ok,
} from "@ses/domain";
import type {
  Apartment,
  BuildingId,
  OccupancyStatus,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import { loadBuildingContext, requireStructureCapability } from "./support";
import type { StructureDeps } from "./support";

/**
 * Create a flat inside a building (PRD §5 structure setup, §3.2 step 2).
 *
 * Admin-only, and the guard is the domain's `canManageStructure` capability rather
 * than a role literal compared inline — one definition, read by the API guard, the
 * RLS policy and the UI affordance alike (SAD §9.3).
 *
 * ## The building is a parameter, and it is not optional
 *
 * A flat is created *inside* a building, so the building is part of the command
 * rather than something the use case discovers. Discovering the parent from the
 * input would mean accepting a `buildingId` the caller supplied and trusting it.
 *
 * ## The parent is loaded, and that is the tenancy check
 *
 * `loadBuildingContext` resolves the building by `(buildingId, societyId)` before a
 * single field is validated, so a building in another society — or one that has been
 * removed — answers `not_found` rather than being attempted and refused further
 * down. Relying on the database's foreign key instead would have been *nearly*
 * right and silently wrong in one case: the flat's own `society_id` comes from the
 * caller's header, not from the building, so an Admin of society B could point a
 * flat of B at a building of A and every constraint would still be satisfied. That
 * hole is now closed twice — here, and by the composite key that makes such a row
 * unrepresentable (see the migration).
 *
 * ## Uniqueness is not checked here
 *
 * \"No other live flat in this building has that number\" is a fact about rows this
 * layer cannot see, and a check-then-insert would leave a race that the unique index
 * turns into a failed create anyway. The database's partial unique index decides it
 * and the adapter classifies the violation as a `conflict` carrying
 * `field: 'apartmentNumber'`, which is the same answer a form needs — reached
 * without a read that would have to be repeated under contention.
 */
export interface CreateApartmentCommand {
  readonly apartmentNumber: string;
  readonly wingId?: string | null | undefined;
  readonly floor?: number | null | undefined;
  readonly bhk?: number | null | undefined;
  readonly carpetAreaSqft?: number | null | undefined;
  readonly builtupAreaSqft?: number | null | undefined;
  readonly parkingSlots?: number | undefined;
  readonly shareUnits?: number | undefined;
  readonly occupancyStatus?: OccupancyStatus | undefined;
  readonly isCommercial?: boolean | undefined;
  readonly isBillable?: boolean | undefined;
}

export async function createApartment(
  deps: StructureDeps,
  actor: UserId,
  societyId: SocietyId,
  buildingId: BuildingId,
  command: CreateApartmentCommand,
): Promise<Result<Apartment, ReturnType<typeof asStructureError>>> {
  const loaded = await loadBuildingContext(deps, actor, societyId, buildingId);
  if (!loaded.ok) return loaded;

  const guard = requireStructureCapability(
    loaded.value.capabilities,
    "canManage",
    "Only a society Admin can change the society structure.",
  );
  if (!guard.ok) return guard;

  // ── value objects, in the order a form shows them ──────────────────────────
  //
  // Sequenced rather than accumulated so the first problem is the one reported:
  // a batch of errors would need a shape the contract does not define, and the
  // user fixes one field at a time anyway. The order is the form's own order, so
  // the message that comes back is about the topmost thing that is wrong.
  const number = createApartmentNumber(command.apartmentNumber);
  if (!number.ok) return number;

  const floor = createFloor(command.floor);
  if (!floor.ok) return floor;

  const bhk = createBhk(command.bhk);
  if (!bhk.ok) return bhk;

  const carpet = createArea(command.carpetAreaSqft, "carpetAreaSqft");
  if (!carpet.ok) return carpet;

  const builtup = createArea(command.builtupAreaSqft, "builtupAreaSqft");
  if (!builtup.ok) return builtup;

  const areas = createAreaPair(carpet.value, builtup.value);
  if (!areas.ok) return areas;

  const parkingSlots = createParkingSlots(command.parkingSlots);
  if (!parkingSlots.ok) return parkingSlots;

  const shareUnits = createShareUnits(command.shareUnits);
  if (!shareUnits.ok) return shareUnits;

  const occupancyStatus = createOccupancyStatus(command.occupancyStatus);
  if (!occupancyStatus.ok) return occupancyStatus;

  try {
    const apartment = await deps.apartments.create(
      buildingId,
      societyId,
      {
        apartmentNumber: number.value,
        wingId: command.wingId ?? null,
        floor: floor.value,
        bhk: bhk.value,
        carpetAreaSqft: carpet.value,
        builtupAreaSqft: builtup.value,
        parkingSlots: parkingSlots.value,
        shareUnits: shareUnits.value,
        occupancyStatus: occupancyStatus.value,
        // Absent is not \"false\": `is_commercial` and `is_billable` default to
        // false/true in the column, and a use case that resolved them here would be
        // a second definition of those defaults. The repository omits them and the
        // database applies its own, which is the one a repair script would get too.
        ...(command.isCommercial === undefined
          ? {}
          : { isCommercial: command.isCommercial }),
        ...(command.isBillable === undefined
          ? {}
          : { isBillable: command.isBillable }),
      },
      actor,
    );
    return ok(apartment);
  } catch (error: unknown) {
    return err(asStructureError(error));
  }
}
