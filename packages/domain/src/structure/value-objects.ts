import { err, ok, type Result } from "../shared/result";

import {
  BUILDING_NAME_MAX_LENGTH,
  DISPLAY_ORDER_MAX,
  DISPLAY_ORDER_MIN,
  TOTAL_FLOORS_MAX,
  TOTAL_FLOORS_MIN,
} from "./building";
import { structureError, type StructureError } from "./errors";

/**
 * Building value objects — the *invariants* of a building, in one place.
 *
 * Everything here is a total function of its arguments: no I/O, no clock, no
 * framework. Each returns a `Result`, never throws, so a use case hands the
 * failure straight back to the caller with the offending field named
 * (`details.field`), which is what becomes a form error at the edge.
 *
 * The rules deliberately mirror the database constraints in
 * `supabase/migrations/20260924130000_structure_buildings.sql`: the database is
 * the last line of defence, these are the first, and both must agree — a value
 * the client accepts and the database rejects surfaces as a crash at 2am rather
 * than as a field error.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Name
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum is 1: "A" and "Tower 4" are both legitimate building names. */
export const BUILDING_NAME_MIN_LENGTH = 1;

/**
 * Normalises and validates a building name.
 *
 * Names are almost always a single letter, a number or "Block A" (PRD §5:
 * "a 6-flat building should not be forced through" a deep hierarchy), so this
 * rejects only what is genuinely unrepresentable: an empty name, one over the
 * column's width, or one carrying control characters from a paste.
 *
 * It does **not** require letters, unlike `createSocietyName`. A building named
 * `"12"` is meaningful — it is the number on the gate — and rejecting it would
 * push the user toward inventing a word for it.
 */
export function createBuildingName(
  raw: string,
): Result<string, StructureError> {
  // Collapse runs of whitespace: "Block   A" and "Block\nA" are one name.
  const value = raw.trim().replace(/\s+/g, " ");

  if (value.length < BUILDING_NAME_MIN_LENGTH) {
    return err(
      structureError("validation", "Enter a building name.", {
        field: "name",
      }),
    );
  }
  if (value.length > BUILDING_NAME_MAX_LENGTH) {
    return err(
      structureError(
        "validation",
        `Building name must be at most ${BUILDING_NAME_MAX_LENGTH} characters.`,
        { field: "name" },
      ),
    );
  }
  // Control characters mean pasted junk, not a name.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return err(
      structureError(
        "validation",
        "Building name contains characters that are not allowed.",
        { field: "name" },
      ),
    );
  }

  return ok(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Floor count
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalises the optional floor count.
 *
 * `undefined` stays `undefined` — "not recorded" is a state the PRD models with a
 * nullable column and the schema preserves. `0` is **rejected** rather than
 * treated as absent: a building with zero floors is a data-entry mistake, and
 * silently converting it to "unknown" would hide the mistake behind a
 * plausible-looking result. `null` is accepted as the same thing as absent, so a
 * JSON body that spells "no value" explicitly is not a different case from one
 * that omits the key.
 */
export function createTotalFloors(
  value: number | null | undefined,
): Result<number | null, StructureError> {
  if (value === undefined || value === null) return ok(null);

  if (
    !Number.isInteger(value) ||
    value < TOTAL_FLOORS_MIN ||
    value > TOTAL_FLOORS_MAX
  ) {
    return err(
      structureError(
        "validation",
        `Floors must be a whole number between ${TOTAL_FLOORS_MIN} and ${TOTAL_FLOORS_MAX}.`,
        { field: "totalFloors" },
      ),
    );
  }
  return ok(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Display order
// ─────────────────────────────────────────────────────────────────────────────

/** Column default for `display_order` (PRD §7). */
export const DEFAULT_DISPLAY_ORDER = 0;

/**
 * Validates the manual sort key.
 *
 * Absent means "default", which the SQL also does — but resolving the default
 * here rather than letting the column do it keeps the use case's result
 * identical whether it was writing to Postgres or to the mobile mock, and a test
 * that asserts ordering should not depend on which adapter ran.
 */
export function createDisplayOrder(
  value: number | null | undefined,
): Result<number, StructureError> {
  if (value === undefined || value === null) return ok(DEFAULT_DISPLAY_ORDER);

  if (
    !Number.isInteger(value) ||
    value < DISPLAY_ORDER_MIN ||
    value > DISPLAY_ORDER_MAX
  ) {
    return err(
      structureError(
        "validation",
        `Display order must be a whole number between ${DISPLAY_ORDER_MIN} and ${DISPLAY_ORDER_MAX}.`,
        { field: "displayOrder" },
      ),
    );
  }
  return ok(value);
}
