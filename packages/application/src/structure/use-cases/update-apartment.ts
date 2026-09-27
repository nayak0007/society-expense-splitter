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
  structureError,
} from "@ses/domain";
import type {
  Apartment,
  ApartmentId,
  OccupancyStatus,
  Result,
  SocietyId,
  UpdateApartmentInput,
  UserId,
} from "@ses/domain";

import { loadApartmentContext, requireStructureCapability } from "./support";
import type { StructureDeps } from "./support";

/**
 * Edit a flat (PRD §5; §3.2's "edit buildings/wings/apartments").
 *
 * Admin-only, enforced through the domain's capability for the same reason
 * `createApartment` is.
 *
 * ## `undefined` means unchanged, `null` means cleared — and both are needed
 *
 * This is the one place apartments differ from buildings.
 * `UpdateBuildingInput` has no way to unset a floor count; here, `floor: undefined`
 * leaves it alone while `floor: null` says "we no longer claim to know". The
 * distinction is in the database too (the columns are nullable), and a patch API
 * that collapsed the two would make a recorded area impossible to retract — the
 * only remedy would be to delete the flat and recreate it, which would take its
 * members and history with it.
 *
 * So each field is validated **only if the caller sent it**, and a sent `null` is
 * valid, produces `null`, and is carried to the adapter as an explicit `null`
 * rather than being dropped. The patch is assembled from validated locals rather
 * than from the raw command, so what reaches the repository is exactly what was
 * checked — normalised whitespace included, with no second pass that could
 * disagree with the first.
 *
 * ## The cross-field rule is checked against what will survive the patch
 *
 * `builtup >= carpet` is a fact about a pair, so a patch that changes only one of
 * them cannot be validated from the command alone. It is validated against the
 * **effective** values — the command's where present, the loaded row's otherwise —
 * which is why `loadApartmentContext` has already read the flat by this point. The
 * alternative would be to read the other field inside the repository and reject
 * there, which is where a rule stops being readable and stops being shared with the
 * mobile client.
 */
export interface UpdateApartmentCommand {
  readonly apartmentNumber?: string | undefined;
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

export async function updateApartment(
  deps: StructureDeps,
  actor: UserId,
  societyId: SocietyId,
  apartmentId: ApartmentId,
  command: UpdateApartmentCommand,
): Promise<Result<Apartment, ReturnType<typeof asStructureError>>> {
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

  // An empty patch is a caller mistake, not a no-op: the contract rejects it at the
  // edge, and this catches the same thing for the mobile path that calls the use
  // case directly. Saying so is better than performing an UPDATE that writes the
  // row's own values back and bumps `updated_at`.
  if (Object.values(command).every((value) => value === undefined)) {
    return err(
      structureError("validation", "Nothing to update.", {
        field: "apartmentNumber",
      }),
    );
  }

  const current = loaded.value.apartment;

  // ── validate only what was sent; `null` is a value, not an absence ─────────
  let apartmentNumber: string | undefined;
  if (command.apartmentNumber !== undefined) {
    const result = createApartmentNumber(command.apartmentNumber);
    if (!result.ok) return result;
    apartmentNumber = result.value;
  }

  let floor: number | null | undefined;
  if (command.floor !== undefined) {
    const result = createFloor(command.floor);
    if (!result.ok) return result;
    floor = result.value;
  }

  let bhk: number | null | undefined;
  if (command.bhk !== undefined) {
    const result = createBhk(command.bhk);
    if (!result.ok) return result;
    bhk = result.value;
  }

  let carpetAreaSqft: number | null | undefined;
  if (command.carpetAreaSqft !== undefined) {
    const result = createArea(command.carpetAreaSqft, "carpetAreaSqft");
    if (!result.ok) return result;
    carpetAreaSqft = result.value;
  }

  let builtupAreaSqft: number | null | undefined;
  if (command.builtupAreaSqft !== undefined) {
    const result = createArea(command.builtupAreaSqft, "builtupAreaSqft");
    if (!result.ok) return result;
    builtupAreaSqft = result.value;
  }

  // Effective values: what the caller sent, else what is already stored.
  const effectiveCarpet =
    carpetAreaSqft === undefined ? current.carpetAreaSqft : carpetAreaSqft;
  const effectiveBuiltup =
    builtupAreaSqft === undefined ? current.builtupAreaSqft : builtupAreaSqft;

  const areas = createAreaPair(effectiveCarpet, effectiveBuiltup);
  if (!areas.ok) return areas;

  let parkingSlots: number | undefined;
  if (command.parkingSlots !== undefined) {
    const result = createParkingSlots(command.parkingSlots);
    if (!result.ok) return result;
    parkingSlots = result.value;
  }

  let shareUnits: number | undefined;
  if (command.shareUnits !== undefined) {
    const result = createShareUnits(command.shareUnits);
    if (!result.ok) return result;
    shareUnits = result.value;
  }

  let occupancyStatus: OccupancyStatus | undefined;
  if (command.occupancyStatus !== undefined) {
    const result = createOccupancyStatus(command.occupancyStatus);
    if (!result.ok) return result;
    occupancyStatus = result.value;
  }

  // Built with conditional spreads so an absent field stays absent. Writing
  // `floor: undefined` explicitly would be the same thing to the adapter today,
  // but it is a different object, and the rule this method depends on is precisely
  // that "absent" and "present but null" are distinguishable.
  const patch: UpdateApartmentInput = {
    ...(apartmentNumber === undefined ? {} : { apartmentNumber }),
    ...(command.wingId === undefined ? {} : { wingId: command.wingId }),
    ...(floor === undefined ? {} : { floor }),
    ...(bhk === undefined ? {} : { bhk }),
    ...(carpetAreaSqft === undefined ? {} : { carpetAreaSqft }),
    ...(builtupAreaSqft === undefined ? {} : { builtupAreaSqft }),
    ...(parkingSlots === undefined ? {} : { parkingSlots }),
    ...(shareUnits === undefined ? {} : { shareUnits }),
    ...(occupancyStatus === undefined ? {} : { occupancyStatus }),
    ...(command.isCommercial === undefined
      ? {}
      : { isCommercial: command.isCommercial }),
    ...(command.isBillable === undefined
      ? {}
      : { isBillable: command.isBillable }),
  };

  try {
    const apartment = await deps.apartments.update(
      apartmentId,
      societyId,
      patch,
      actor,
    );
    return ok(apartment);
  } catch (error: unknown) {
    return err(asStructureError(error));
  }
}
