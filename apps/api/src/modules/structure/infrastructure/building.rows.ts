import { StructureError, asBuildingId, asSocietyId } from "@ses/domain";
import type { Building } from "@ses/domain";
import { z } from "zod";

import {
  asErrorLike,
  SQLSTATE,
} from "../../../common/database/postgres-errors";
import {
  nullableTimestampSchema,
  timestampSchema,
} from "../../../common/database/postgres-rows";

/**
 * The database ⇄ domain boundary for the building module.
 *
 * Every nullability difference and SQLSTATE the API can receive is decided here,
 * once, rather than across five repository methods. Rows are **validated, not
 * trusted**: a column rename or a new `NOT NULL` must fail loudly here rather
 * than reach a use case as `undefined`.
 *
 * The timestamp schemas and the driver-error unwrapping are imported from
 * `common/database/` rather than copied from the society module — see those files
 * for why, in particular that the unwrapping is a bug fix the API paid for once.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Row
// ─────────────────────────────────────────────────────────────────────────────

/** `coerce` on the numerics: `smallint` columns can arrive as strings. */
export const buildingRowSchema = z.object({
  id: z.string(),
  society_id: z.string(),
  name: z.string(),
  total_floors: z.coerce.number().int().nullable(),
  display_order: z.coerce.number().int(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  deleted_at: nullableTimestampSchema,
});
export type BuildingRow = z.infer<typeof buildingRowSchema>;

export const buildingRowListSchema = z.array(buildingRowSchema);

/**
 * One row → the domain entity.
 *
 * The `society_id` and the timestamps are taken from the row rather than from the
 * arguments that produced the query: the row is the authority, and echoing back
 * what the caller asked for would let a bug in the `WHERE` clause go unnoticed.
 */
export function buildingFromRow(row: BuildingRow): Building {
  return {
    id: asBuildingId(row.id),
    societyId: asSocietyId(row.society_id),
    name: row.name,
    totalFloors: row.total_floors,
    displayOrder: row.display_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export function buildingsFromRows(
  rows: readonly BuildingRow[],
): readonly Building[] {
  return rows.map((row) => buildingFromRow(row));
}

/**
 * A row that did not match its schema. Always a bug on one side of the boundary
 * (a renamed column, a new nullable field), never something the user did — so the
 * copy stays generic and the actionable part is a hint for the operator.
 */
export function unexpectedShapeError(what: string): StructureError {
  return new StructureError(
    "unknown",
    "Something went wrong. Please try again.",
    {
      hint: `Unexpected ${what} shape returned by the database.`,
    },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The named exceptions `building_soft_delete()` raises.
 *
 * The not-found one travels as `P0002` rather than `P0001`, so its code alone
 * classifies it — unlike the app's other `P0001` refusals, which have to be matched
 * by name. The second has to be matched by name, and it is the reason this is a
 * table rather than an inline check: two `P0001` exceptions with two different
 * meanings arrive on the same code.
 */
export const RAISED_EXCEPTION = {
  buildingNotFound: "BUILDING_NOT_FOUND",
  /** Raised when live flats still point at the building being removed. */
  buildingHasApartments: "BUILDING_HAS_APARTMENTS",
} as const;

/**
 * Postgres failure → the module's error vocabulary.
 *
 * `context` matters for exactly one case, and it is the same one the society
 * module documents: `42501` covers both "your role has no grant on this table"
 * and "RLS refused this row". On a **read** that must be `not_found` (PRD T041: a
 * non-member cannot tell a foreign society from a non-existent one). On a
 * **write** the caller has already passed `SocietyGuard`, so they are an active
 * member and the only thing RLS can be refusing is their *role* — `forbidden`,
 * which is a message the user can act on, rather than a 404 for a society they can
 * plainly see.
 *
 * What this deliberately does NOT copy is Postgres's `detail`: it can carry column
 * values, and these objects travel toward the UI.
 */
export function structureErrorFromPostgres(
  error: unknown,
  context: "read" | "write",
): StructureError {
  const candidate = asErrorLike(error);
  const code = candidate.code ?? "";
  const message = candidate.message ?? "";
  const hint = candidate.hint;
  // The constraint name is included because a check violation's most useful
  // discriminator lives there (and in the message), not always in `detail`.
  const haystack = [
    message,
    candidate.detail,
    candidate.constraint,
    candidate.constraint_name,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ");

  const withHint = (): Record<string, unknown> => ({
    code: candidate.code,
    ...(hint === undefined ? {} : { hint }),
  });

  switch (code) {
    case SQLSTATE.notFound:
      // `assert_society_admin`'s two refusals arrive as P0002/P0003, and
      // `building_soft_delete` uses P0002 itself for "not in that society". All
      // are one answer to the caller: there is nothing here for you.
      return new StructureError(
        "not_found",
        "That building is not available to you.",
        withHint(),
      );

    case SQLSTATE.forbidden:
      return new StructureError(
        "forbidden",
        hint ?? "Only a society Admin can change the society structure.",
        withHint(),
      );

    case SQLSTATE.raised:
      if (message.includes(RAISED_EXCEPTION.buildingHasApartments)) {
        // The database's half of the rule `deleteBuilding` states in the
        // application layer: a building with live flats is not removable. Reaching
        // this at all means the two disagreed — the use case counted zero and the
        // statement found one — and the answer is still the typed refusal rather
        // than a `500`, because the rule is the same rule.
        return new StructureError(
          "building_has_apartments",
          "This building still has flats. Remove them first.",
          withHint(),
        );
      }
      return message.includes(RAISED_EXCEPTION.buildingNotFound)
        ? new StructureError(
            "not_found",
            "That building is not available to you.",
            withHint(),
          )
        : new StructureError(
            "unknown",
            "Something went wrong. Please try again.",
            withHint(),
          );

    case SQLSTATE.insufficientPrivilege:
      if (/permission denied for table/i.test(message)) {
        // The role itself has no grant, which for this app means the request
        // arrived without a usable identity: nothing is granted to `anon`.
        return new StructureError(
          "forbidden",
          "Your session expired. Please sign in again.",
          withHint(),
        );
      }
      return context === "read"
        ? new StructureError(
            "not_found",
            "That building is not available to you.",
            withHint(),
          )
        : new StructureError(
            "forbidden",
            "Only a society Admin can change the society structure.",
            withHint(),
          );

    case SQLSTATE.uniqueViolation:
      if (/name|uq_buildings/i.test(haystack)) {
        return new StructureError(
          "conflict",
          "A building with that name already exists in this society.",
          withHint(),
        );
      }
      return new StructureError(
        "conflict",
        "That change conflicts with an existing record.",
        withHint(),
      );

    case SQLSTATE.checkViolation:
      return new StructureError(
        "validation",
        checkViolationMessage(haystack),
        withHint(),
      );

    case SQLSTATE.foreignKeyViolation:
      // The only FK a building has is its society, so this is a society that was
      // removed between the guard's read and this write.
      return new StructureError(
        "not_found",
        "That society is not available to you.",
        withHint(),
      );

    case SQLSTATE.undefinedTable:
      return new StructureError(
        "unknown",
        "This part of the app is not available yet. Please try again later.",
        {
          ...withHint(),
          hint: "The buildings table is missing. Apply supabase/migrations/20260924130000_structure_buildings.sql.",
        },
      );

    default:
      break;
  }

  if (/row-level security|permission denied/i.test(message)) {
    return context === "read"
      ? new StructureError(
          "not_found",
          "That building is not available to you.",
          withHint(),
        )
      : new StructureError(
          "forbidden",
          "Only a society Admin can change the society structure.",
          withHint(),
        );
  }

  return new StructureError(
    "unknown",
    "Something went wrong. Please try again.",
    {
      code,
      ...(hint === undefined ? {} : { hint }),
    },
  );
}

/** Names the offending field, so a form can highlight it rather than guess. */
function checkViolationMessage(haystack: string): string {
  if (/total_floors/i.test(haystack))
    return "Floors must be a whole number between 1 and 200.";
  if (/display_order/i.test(haystack))
    return "Display order cannot be negative.";
  return "Please check the details and try again.";
}
