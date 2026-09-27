import { err, ok, type Result } from "../shared/result";

import {
  APARTMENT_NUMBER_MAX_LENGTH,
  AREA_MAX_SQFT,
  AREA_MIN_SQFT,
  BHK_MAX,
  BHK_MIN,
  DEFAULT_OCCUPANCY_STATUS,
  FLOOR_MAX,
  FLOOR_MIN,
  OCCUPANCY_STATUSES,
  PARKING_SLOTS_MAX,
  PARKING_SLOTS_MIN,
  SHARE_UNITS_MAX,
  SHARE_UNITS_MIN,
} from "./apartment";
import type { OccupancyStatus } from "./apartment";
import { structureError, type StructureError } from "./errors";

/**
 * Apartment value objects — the *invariants* of a flat, in one place.
 *
 * Total functions of their arguments, returning `Result` and never throwing, for
 * the reasons `value-objects.ts` records for buildings: a failure carries
 * `details.field`, which is what becomes a form error at the edge, and the rules
 * mirror the CHECK constraints in
 * `supabase/migrations/20260924140000_structure_apartments.sql` so a value the
 * client accepts is a value the database accepts.
 *
 * Every numeric field here is **nullable and clearing is a distinct state** from
 * absent, which is the one structural difference from the building value objects:
 * a floor count is set at creation and never unset, while a measured area is
 * something a society may discover was wrong and wants to stop claiming. So each
 * of these accepts `null` and returns `null`, and the use case decides whether that
 * means "unchanged" (create/update treat absent as unchanged, explicit null as
 * cleared).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Apartment number
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalises and validates the flat's label.
 *
 * Uniqueness is **not** checked here — it is a fact about the other rows in the
 * building, which a pure function cannot see. The database's partial unique index
 * decides it and the classifier turns the violation into a `conflict` carrying
 * `field: 'apartmentNumber'`, so the form still highlights the right input.
 *
 * Case and separators are preserved rather than normalised: societies print these
 * on bills, and `"A-101"` is not `"a-101"` to the person reading it. Whitespace is
 * collapsed, because that is pasted junk rather than meaning.
 */
export function createApartmentNumber(
  raw: string,
): Result<string, StructureError> {
  const value = raw.trim().replace(/\s+/g, " ");

  if (value.length === 0) {
    return err(
      structureError("validation", "Enter a flat number.", {
        field: "apartmentNumber",
      }),
    );
  }
  if (value.length > APARTMENT_NUMBER_MAX_LENGTH) {
    return err(
      structureError(
        "validation",
        `Flat number must be at most ${APARTMENT_NUMBER_MAX_LENGTH} characters.`,
        { field: "apartmentNumber" },
      ),
    );
  }
  // Control characters mean pasted junk, not a label.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return err(
      structureError(
        "validation",
        "Flat number contains characters that are not allowed.",
        { field: "apartmentNumber" },
      ),
    );
  }

  return ok(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Floor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the optional floor, where `null` is a claim ("not recorded") and not
 * an omission.
 *
 * A zero floor is accepted and is not the same as absent: ground floor and
 * "nobody wrote it down" are different facts, and collapsing them would make a
 * ground-floor flat indistinguishable from an unlabelled one in every per-floor
 * rollup.
 */
export function createFloor(
  value: number | null | undefined,
): Result<number | null, StructureError> {
  if (value === undefined || value === null) return ok(null);

  if (!Number.isInteger(value) || value < FLOOR_MIN || value > FLOOR_MAX) {
    return err(
      structureError(
        "validation",
        `Floor must be a whole number between ${FLOOR_MIN} and ${FLOOR_MAX}.`,
        { field: "floor" },
      ),
    );
  }
  return ok(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// BHK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the configuration, one decimal place.
 *
 * `1.5` is real and common; `1.25` is not a configuration anyone sells. Rounding it
 * is rejected rather than applied, because silently turning 1.25 into 1.5 or 1 would
 * put a number on a bill that contradicts the form the user filled in.
 */
export function createBhk(
  value: number | null | undefined,
): Result<number | null, StructureError> {
  if (value === undefined || value === null) return ok(null);

  if (
    value < BHK_MIN ||
    value > BHK_MAX ||
    Math.round(value * 10) !== value * 10
  ) {
    return err(
      structureError(
        "validation",
        `Configuration must be between ${BHK_MIN} and ${BHK_MAX} BHK, in half steps.`,
        { field: "bhk" },
      ),
    );
  }
  return ok(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Areas
// ─────────────────────────────────────────────────────────────────────────────

/** The two area fields, so the error names the field the user actually typed in. */
export type AreaField = "carpetAreaSqft" | "builtupAreaSqft";

/**
 * Validates one measured area.
 *
 * `0` is rejected where the column allows it, and the reason is arithmetic rather
 * than aesthetic: every per-sqft split rule (PRD §4) divides by this number, so a
 * zero area stored here becomes a division by zero or an infinite share at billing
 * time — long after the form that could have caught it.
 */
export function createArea(
  value: number | null | undefined,
  field: AreaField,
): Result<number | null, StructureError> {
  if (value === undefined || value === null) return ok(null);

  const label = field === "carpetAreaSqft" ? "Carpet area" : "Built-up area";
  if (
    !Number.isFinite(value) ||
    value <= AREA_MIN_SQFT ||
    value > AREA_MAX_SQFT
  ) {
    return err(
      structureError(
        "validation",
        `${label} must be between ${AREA_MIN_SQFT} and ${AREA_MAX_SQFT} sq ft.`,
        { field },
      ),
    );
  }
  return ok(value);
}

/**
 * Cross-field rule: a built-up area smaller than the carpet area is impossible.
 *
 * Checked as a pair because neither field alone can see it, and because the failure
 * has to be attached to one input — the built-up area, the number that is wrong.
 * Both `null` is fine: two unmeasured fields are not inconsistent.
 */
export function createAreaPair(
  carpetAreaSqft: number | null | undefined,
  builtupAreaSqft: number | null | undefined,
): Result<true, StructureError> {
  if (carpetAreaSqft === null || carpetAreaSqft === undefined) return ok(true);
  if (builtupAreaSqft === null || builtupAreaSqft === undefined)
    return ok(true);
  if (builtupAreaSqft < carpetAreaSqft) {
    return err(
      structureError(
        "validation",
        "Built-up area cannot be smaller than the carpet area.",
        { field: "builtupAreaSqft" },
      ),
    );
  }
  return ok(true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Parking slots
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the allotted parking count.
 *
 * Absent resolves to the column's default (`0`) rather than to `undefined`, so the
 * use case produces the same entity whether it wrote to Postgres or to a fake — a
 * test asserting a flat's slots should not depend on which adapter ran. Same
 * reasoning as `createDisplayOrder`.
 */
export function createParkingSlots(
  value: number | null | undefined,
): Result<number, StructureError> {
  if (value === undefined || value === null) return ok(PARKING_SLOTS_MIN);

  if (
    !Number.isInteger(value) ||
    value < PARKING_SLOTS_MIN ||
    value > PARKING_SLOTS_MAX
  ) {
    return err(
      structureError(
        "validation",
        `Parking slots must be a whole number between ${PARKING_SLOTS_MIN} and ${PARKING_SLOTS_MAX}.`,
        { field: "parkingSlots" },
      ),
    );
  }
  return ok(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Share units
// ─────────────────────────────────────────────────────────────────────────────

/** The column's default, and the weight of an ordinary flat (PRD §7). */
export const DEFAULT_SHARE_UNITS = 1;

/** Validates the share-based split weight. Fractional weights are legitimate. */
export function createShareUnits(
  value: number | null | undefined,
): Result<number, StructureError> {
  if (value === undefined || value === null) return ok(DEFAULT_SHARE_UNITS);

  if (
    !Number.isFinite(value) ||
    value < SHARE_UNITS_MIN ||
    value > SHARE_UNITS_MAX
  ) {
    return err(
      structureError(
        "validation",
        `Share units must be between ${SHARE_UNITS_MIN} and ${SHARE_UNITS_MAX}.`,
        { field: "shareUnits" },
      ),
    );
  }
  return ok(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Occupancy status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the occupancy status against the enum, narrowing `string` to the union.
 *
 * Written as a membership test rather than as a cast so an unrecognised value from
 * the wire cannot reach the column as a `22P02` the classifier reports as
 * `unknown` — this is the one apartment field whose valid values are an enum rather
 * than a range, and naming the field is what lets a form fix it.
 */
export function createOccupancyStatus(
  value: string | null | undefined,
): Result<OccupancyStatus, StructureError> {
  if (value === undefined || value === null)
    return ok(DEFAULT_OCCUPANCY_STATUS);

  const match = OCCUPANCY_STATUSES.find((status) => status === value);
  if (match === undefined) {
    return err(
      structureError(
        "validation",
        `Occupancy status must be one of: ${OCCUPANCY_STATUSES.join(", ")}.`,
        { field: "occupancyStatus" },
      ),
    );
  }
  return ok(match);
}
