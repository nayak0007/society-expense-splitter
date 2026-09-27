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
  StructureError,
  UserId,
} from "@ses/domain";

import { loadBuildingContext, requireStructureCapability } from "./support";
import type { StructureDeps } from "./support";

/**
 * Bulk-create apartments inside one building, with a per-row error report
 * (Roadmap T043: "Bulk create is transactional with a per-row error report ·
 * Duplicate numbers skipped and reported, not silently dropped").
 *
 * ## The two kinds of "duplicate", and why they get different answers
 *
 *  - **Inside the file** — the same label twice in one request. The first
 *    occurrence is the create that would land; later ones are reported as
 *    `duplicate` and dropped before storage. Refusing the whole batch for a
 *    copy-paste artefact would be the spreadsheet lecturing the treasurer.
 *  - **Against the building** — a label a live flat already carries. The row is
 *    reported as `existing` and skipped; the batch still creates the rest. This
 *    is the one rule `createMany` also enforces underneath, so a concurrent
 *    creator between the read and the write lands in the same report rather
 *    than failing the batch.
 *
 * Every created row and every reported row is in the response — nothing is
 * silently dropped, and the report is the caller's audit of their own paste.
 */

export interface BulkCreateApartmentRow {
  /** The flat's label. Required; validated through the single-flat value object. */
  readonly apartmentNumber: string;
  /**
   * Everything else the single-flat form can set, all optional. A field the row
   * omits takes the same default the single create resolves — the row is a flat
   * with fewer things said about it, not a lesser kind of flat (T043: area,
   * BHK, parking, share units and occupancy are all settable per row).
   */
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

export interface BulkCreateApartmentsCommand {
  /** The building the paste is addressed to. The use case is also called with
   * it as a parameter; both spellings exist so the command is self-describing
   * and the parameter order matches the other structure use cases. */
  readonly buildingId: BuildingId;
  readonly rows: readonly BulkCreateApartmentRow[];
}

/** The value objects carry `field` in a free-form record; narrow it to the wire's string. */
function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

/** One line of the per-row report, in input order. */
export interface BulkCreateApartmentOutcome {
  readonly apartmentNumber: string;
  readonly status: "created" | "existing" | "duplicate" | "invalid";
  /** Present when `invalid`: the field the value object refused. */
  readonly field?: string | undefined;
  /** Present when `invalid`: the user-readable reason. */
  readonly message?: string | undefined;
}

export interface BulkCreateApartmentsResult {
  readonly total: number;
  readonly createdCount: number;
  readonly existingCount: number;
  readonly duplicateCount: number;
  readonly invalidCount: number;
  readonly outcomes: readonly BulkCreateApartmentOutcome[];
  /**
   * The created flats as full entities — not a narrowed projection, because the
   * caller (the mobile adapter above the API) maps them straight onto its own
   * entity type, and a projection here would force the client to invent the
   * fields it dropped.
   */
  readonly created: readonly Apartment[];
}

export async function bulkCreateApartments(
  deps: StructureDeps,
  actor: UserId,
  societyId: SocietyId,
  buildingId: BuildingId,
  command: BulkCreateApartmentsCommand,
): Promise<Result<BulkCreateApartmentsResult, StructureError>> {
  const loaded = await loadBuildingContext(deps, actor, societyId, buildingId);
  if (!loaded.ok) return loaded;

  const guard = requireStructureCapability(
    loaded.value.capabilities,
    "canManage",
    "Only a society Admin can create apartments.",
  );
  if (!guard.ok) return guard;

  try {
    // ── validate every row first: one bad row never aborts the report ────────
    const valid: {
      readonly apartmentNumber: string;
      readonly wingId: string | null;
      readonly floor: number | null;
      readonly bhk: number | null;
      readonly carpetAreaSqft: number | null;
      readonly builtupAreaSqft: number | null;
      readonly parkingSlots: number;
      readonly shareUnits: number;
      readonly occupancyStatus: OccupancyStatus;
      readonly isCommercial?: boolean | undefined;
      readonly isBillable?: boolean | undefined;
      /** The row's position in the request, so the report can be input-ordered. */
      readonly order: number;
    }[] = [];
    /** Report lines remember their row's position; sorted into input order at the end. */
    const outcomes: (BulkCreateApartmentOutcome & { order: number })[] = [];

    /** A label's position in the request; first occurrence wins for duplicates. */
    const orderOf = new Map<string, number>();

    for (const [index, row] of command.rows.entries()) {
      if (!orderOf.has(row.apartmentNumber)) {
        orderOf.set(row.apartmentNumber, index);
      }
      const number = createApartmentNumber(row.apartmentNumber);
      if (!number.ok) {
        outcomes.push({
          order: index,
          apartmentNumber: row.apartmentNumber,
          status: "invalid",
          field: stringField(number.error.details?.field, "apartmentNumber"),
          message: number.error.message,
        });
        continue;
      }
      const floor = createFloor(row.floor);
      if (!floor.ok) {
        outcomes.push({
          order: index,
          apartmentNumber: number.value,
          status: "invalid",
          field: stringField(floor.error.details?.field, "floor"),
          message: floor.error.message,
        });
        continue;
      }
      // The remaining value objects, in the single-flat form's order — the same
      // sequence `createApartment` walks, so a row is refused for the topmost
      // thing wrong about it exactly as one flat would be, and each report line
      // names the field the user would have had to fix in the form.
      const bhk = createBhk(row.bhk);
      if (!bhk.ok) {
        outcomes.push({
          order: index,
          apartmentNumber: number.value,
          status: "invalid",
          field: stringField(bhk.error.details?.field, "bhk"),
          message: bhk.error.message,
        });
        continue;
      }
      const carpet = createArea(row.carpetAreaSqft, "carpetAreaSqft");
      if (!carpet.ok) {
        outcomes.push({
          order: index,
          apartmentNumber: number.value,
          status: "invalid",
          field: stringField(carpet.error.details?.field, "carpetAreaSqft"),
          message: carpet.error.message,
        });
        continue;
      }
      const builtup = createArea(row.builtupAreaSqft, "builtupAreaSqft");
      if (!builtup.ok) {
        outcomes.push({
          order: index,
          apartmentNumber: number.value,
          status: "invalid",
          field: stringField(builtup.error.details?.field, "builtupAreaSqft"),
          message: builtup.error.message,
        });
        continue;
      }
      const areas = createAreaPair(carpet.value, builtup.value);
      if (!areas.ok) {
        outcomes.push({
          order: index,
          apartmentNumber: number.value,
          status: "invalid",
          field: stringField(areas.error.details?.field, "builtupAreaSqft"),
          message: areas.error.message,
        });
        continue;
      }
      const parkingSlots = createParkingSlots(row.parkingSlots);
      if (!parkingSlots.ok) {
        outcomes.push({
          order: index,
          apartmentNumber: number.value,
          status: "invalid",
          field: stringField(parkingSlots.error.details?.field, "parkingSlots"),
          message: parkingSlots.error.message,
        });
        continue;
      }
      const shareUnits = createShareUnits(row.shareUnits);
      if (!shareUnits.ok) {
        outcomes.push({
          order: index,
          apartmentNumber: number.value,
          status: "invalid",
          field: stringField(shareUnits.error.details?.field, "shareUnits"),
          message: shareUnits.error.message,
        });
        continue;
      }
      const occupancyStatus = createOccupancyStatus(row.occupancyStatus);
      if (!occupancyStatus.ok) {
        outcomes.push({
          order: index,
          apartmentNumber: number.value,
          status: "invalid",
          field: stringField(
            occupancyStatus.error.details?.field,
            "occupancyStatus",
          ),
          message: occupancyStatus.error.message,
        });
        continue;
      }
      valid.push({
        order: index,
        apartmentNumber: number.value,
        wingId: row.wingId ?? null,
        floor: floor.value,
        bhk: bhk.value,
        carpetAreaSqft: carpet.value,
        builtupAreaSqft: builtup.value,
        parkingSlots: parkingSlots.value,
        shareUnits: shareUnits.value,
        occupancyStatus: occupancyStatus.value,
        // Absent is not "false": the repository omits them and the column default
        // applies — the same rule `createApartment` states and will not redefine.
        ...(row.isCommercial === undefined
          ? {}
          : { isCommercial: row.isCommercial }),
        ...(row.isBillable === undefined ? {} : { isBillable: row.isBillable }),
      });
    }

    // ── in-file duplicates: first wins, the rest are reported ────────────────
    const seen = new Set<string>();
    const pending: typeof valid = [];
    for (const row of valid) {
      if (seen.has(row.apartmentNumber)) {
        outcomes.push({
          order: orderOf.get(row.apartmentNumber) ?? Number.MAX_SAFE_INTEGER,
          apartmentNumber: row.apartmentNumber,
          status: "duplicate",
        });
        continue;
      }
      seen.add(row.apartmentNumber);
      pending.push(row);
    }

    // ── what the building already has: one read, not one per row ─────────────
    const existing = new Set(
      (await deps.apartments.listApartments(buildingId, societyId, actor)).map(
        (apartment) => apartment.apartmentNumber,
      ),
    );
    const toCreate = pending.filter((row) => {
      if (existing.has(row.apartmentNumber)) {
        outcomes.push({
          order: orderOf.get(row.apartmentNumber) ?? Number.MAX_SAFE_INTEGER,
          apartmentNumber: row.apartmentNumber,
          status: "existing",
        });
        return false;
      }
      return true;
    });

    const batch = await deps.apartments.createMany(
      buildingId,
      societyId,
      toCreate,
      actor,
    );
    for (const label of batch.duplicateLabelsSkipped) {
      outcomes.push({
        order: orderOf.get(label) ?? Number.MAX_SAFE_INTEGER,
        apartmentNumber: label,
        status: "existing",
      });
    }
    for (const apartment of batch.created) {
      outcomes.push({
        order:
          orderOf.get(apartment.apartmentNumber) ?? Number.MAX_SAFE_INTEGER,
        apartmentNumber: apartment.apartmentNumber,
        status: "created",
      });
    }

    // The promise the interface states — "in input order". The phases above run
    // validation before storage, so without this the report would come back in
    // *phase* order (invalid, duplicate, existing, created) and a caller rendering
    // it beside the paste would have rows shuffled against their lines.
    outcomes.sort((left, right) => left.order - right.order);

    return ok({
      total: command.rows.length,
      createdCount: batch.created.length,
      existingCount: outcomes.filter((row) => row.status === "existing").length,
      duplicateCount: outcomes.filter((row) => row.status === "duplicate")
        .length,
      invalidCount: outcomes.filter((row) => row.status === "invalid").length,
      outcomes: outcomes.map(({ order: _order, ...outcome }) => outcome),
      // Full entities, defaults included — the caller's audit of what the batch
      // actually applied, not of what it asked for.
      created: batch.created,
    });
  } catch (error: unknown) {
    return err(asStructureError(error));
  }
}
