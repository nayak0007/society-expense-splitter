import {
  OCCUPANCY_STATUSES,
  StructureError,
  asApartmentId,
  asBuildingId,
  asSocietyId,
  asWingId,
} from "@ses/domain";
import type { Apartment, OccupancyStatus } from "@ses/domain";
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
 * The database ⇄ domain boundary for apartments.
 *
 * The same contract `building.rows.ts` documents, applied to a wider table: every
 * nullability difference and every SQLSTATE the API can receive is decided here,
 * once, rather than across six repository methods. Rows are **validated, not
 * trusted** — a column rename must fail loudly at the boundary instead of reaching
 * a use case as `undefined`.
 *
 * Two things are apartment-specific and are the reason this is a separate file
 * rather than a shared one:
 *
 *  - `occupancy_status` is an **enum**, so the row schema validates it against the
 *    domain's own union. A row with a label the enum does not have (a half-applied
 *    migration) becomes a shape error rather than a value the domain then has to
 *    guess at.
 *  - a flat has **three** foreign keys (society, building, wing) where a building
 *    has one, and they mean three different things to a user. The classifier can
 *    only tell them apart by constraint name, which is why it reads the name rather
 *    than the code alone.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `coerce` on the numerics: `smallint`, `numeric(3,1)` and `numeric(8,3)` can
 * arrive as strings, and `numeric` *always* does from some drivers. Coercing here
 * means the domain entity's `number` fields are numbers on every path.
 */
export const apartmentRowSchema = z.object({
  id: z.string(),
  society_id: z.string(),
  building_id: z.string(),
  wing_id: z.string().nullable(),
  apartment_number: z.string(),
  floor: z.coerce.number().int().nullable(),
  bhk: z.coerce.number().nullable(),
  carpet_area_sqft: z.coerce.number().nullable(),
  builtup_area_sqft: z.coerce.number().nullable(),
  parking_slots: z.coerce.number().int(),
  share_units: z.coerce.number(),
  occupancy_status: z.enum(OCCUPANCY_STATUSES),
  is_commercial: z.boolean(),
  is_billable: z.boolean(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  deleted_at: nullableTimestampSchema,
});
export type ApartmentRow = z.infer<typeof apartmentRowSchema>;

export const apartmentRowListSchema = z.array(apartmentRowSchema);

/** One row → the domain entity, with the row as the authority for every value. */
export function apartmentFromRow(row: ApartmentRow): Apartment {
  return {
    id: asApartmentId(row.id),
    societyId: asSocietyId(row.society_id),
    buildingId: asBuildingId(row.building_id),
    wingId: row.wing_id === null ? null : asWingId(row.wing_id),
    apartmentNumber: row.apartment_number,
    floor: row.floor,
    bhk: row.bhk,
    carpetAreaSqft: row.carpet_area_sqft,
    builtupAreaSqft: row.builtup_area_sqft,
    parkingSlots: row.parking_slots,
    shareUnits: row.share_units,
    // The schema narrowed this to the union, so the cast is a widening the
    // compiler already proved.
    occupancyStatus: row.occupancy_status as OccupancyStatus,
    isCommercial: row.is_commercial,
    isBillable: row.is_billable,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export function apartmentsFromRows(
  rows: readonly ApartmentRow[],
): readonly Apartment[] {
  return rows.map((row) => apartmentFromRow(row));
}

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The named exception `apartment_soft_delete()` raises.
 *
 * It travels as `P0002` rather than `P0001`, so the code alone is enough to
 * classify it — unlike the app's other `P0001` refusals, which have to be matched
 * by name. `BUILDING_HAS_APARTMENTS`, the one refusal that couples the two tables,
 * is in `building.rows.ts`'s vocabulary because `building_soft_delete()` is what
 * raises it and the building repository is what catches it.
 */
export const APARTMENT_RAISED_EXCEPTION = {
  apartmentNotFound: "APARTMENT_NOT_FOUND",
} as const;

/**
 * Whether a raw database failure is `uq_apartments_building_number` deciding a
 * duplicate — the one refusal the bulk create absorbs; everything else is an error.
 *
 * It reads the **raw** error, and that is a fix rather than a preference. The
 * predicate this replaces asked `apartmentErrorFromPostgres` and then looked for the
 * column or the index in its *answer* — but the classified answer for this violation
 * is `field: "apartmentNumber"` and a sentence of prose, so neither `apartment_number`
 * nor `uq_apartments` appeared in what was searched and the predicate could not
 * recognise the constraint it was written for. Every duplicate therefore escaped the
 * absorption and failed the whole batch with a `409`: measured against the hosted
 * project, where a label claimed by a concurrent writer mid-batch answered `409`.
 *
 * The constraint's own name is what identifies a unique violation, and it lives on
 * the driver's error in whichever property the driver happened to fill — the same set
 * (`message`, `detail`, `constraint`, `constraint_name`) `isJoinCodeCollision` and
 * `isSlugCollision` in `society.rows.ts` read, and for the same reason.
 */
export function isApartmentNumberCollision(error: unknown): boolean {
  const candidate = asErrorLike(error);
  if (candidate.code !== SQLSTATE.uniqueViolation) {
    return false;
  }
  return /uq_apartments_building_number|apartment_number/i.test(
    [
      candidate.message,
      candidate.detail,
      candidate.constraint,
      candidate.constraint_name,
    ]
      .filter((part): part is string => typeof part === "string")
      .join(" "),
  );
}

/**
 * Postgres failure → the module's error vocabulary, for apartment statements.
 *
 * `context` is the same lever `structureErrorFromPostgres` documents: on a **read**,
 * a `42501` must be `not_found` (PRD T041 — a non-member cannot tell a foreign
 * society from a non-existent one); on a **write**, the caller has already passed
 * `SocietyGuard`, so the only thing RLS can be refusing is their *role*, which is a
 * `forbidden` the user can act on.
 *
 * ## Why the constraint name is load-bearing here
 *
 * A flat has three foreign keys and one unique index, and Postgres reports all of
 * them as codes that are otherwise identical. `23503` could mean "the building
 * vanished", "the society vanished" or "that wing is not in this building" — three
 * different answers, of which only one is a field error the user can fix. The name
 * is the only thing that distinguishes them, so it is read rather than guessed at.
 */
export function apartmentErrorFromPostgres(
  error: unknown,
  context: "read" | "write",
): StructureError {
  const candidate = asErrorLike(error);
  const code = candidate.code ?? "";
  const message = candidate.message ?? "";
  const hint = candidate.hint;
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
      // `apartment_soft_delete` uses P0002 both for "no such flat" and for "not in
      // that society" — one answer to the caller either way.
      return new StructureError(
        "not_found",
        "That flat is not available to you.",
        withHint(),
      );

    case SQLSTATE.forbidden:
      return new StructureError(
        "forbidden",
        hint ?? "Only a society Admin can change the society structure.",
        withHint(),
      );

    case SQLSTATE.raised:
      return message.includes(APARTMENT_RAISED_EXCEPTION.apartmentNotFound)
        ? new StructureError(
            "not_found",
            "That flat is not available to you.",
            withHint(),
          )
        : new StructureError(
            "unknown",
            "Something went wrong. Please try again.",
            withHint(),
          );

    case SQLSTATE.insufficientPrivilege:
      if (/permission denied for table/i.test(message)) {
        return new StructureError(
          "forbidden",
          "Your session expired. Please sign in again.",
          withHint(),
        );
      }
      return context === "read"
        ? new StructureError(
            "not_found",
            "That flat is not available to you.",
            withHint(),
          )
        : new StructureError(
            "forbidden",
            "Only a society Admin can change the society structure.",
            withHint(),
          );

    case SQLSTATE.uniqueViolation:
      // `uq_apartments_building_number`: uniqueness among **live** flats of one
      // building, so a number that was used and then removed is free again.
      if (/apartment_number|uq_apartments/i.test(haystack)) {
        return new StructureError(
          "conflict",
          "A flat with that number already exists in this building.",
          { ...withHint(), field: "apartmentNumber" },
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
        apartmentCheckViolationMessage(haystack),
        { ...withHint(), field: apartmentCheckViolationField(haystack) },
      );

    case SQLSTATE.foreignKeyViolation:
      if (/fk_apartments_wing|wing_id/i.test(haystack)) {
        // The composite key ties the wing to its *building*, so a wing from another
        // building — or another society — fails here rather than being accepted as
        // a plain reference.
        return new StructureError(
          "validation",
          "That wing is not part of this building.",
          { ...withHint(), field: "wingId" },
        );
      }
      if (/building/i.test(haystack)) {
        return new StructureError(
          "not_found",
          "That building is not available to you.",
          withHint(),
        );
      }
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
          hint: "The apartments table is missing. Apply supabase/migrations/20260924140000_structure_apartments.sql.",
        },
      );

    default:
      break;
  }

  if (/row-level security|permission denied/i.test(message)) {
    return context === "read"
      ? new StructureError(
          "not_found",
          "That flat is not available to you.",
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

/**
 * Maps a CHECK constraint name to the field the form has to highlight.
 *
 * The pairs are the constraints in
 * `supabase/migrations/20260924140000_structure_apartments.sql`, and the mapping
 * exists because a check violation's code is the same for all of them: without
 * this, "floor out of range" and "built-up smaller than carpet" arrive as one
 * message with no field, and a form can only show a banner.
 */
function apartmentCheckViolationField(haystack: string): string {
  if (/number_not_blank/i.test(haystack)) return "apartmentNumber";
  if (/floor/i.test(haystack)) return "floor";
  if (/bhk/i.test(haystack)) return "bhk";
  if (/carpet_area/i.test(haystack)) return "carpetAreaSqft";
  if (/builtup_area/i.test(haystack)) return "builtupAreaSqft";
  if (/area_ordering/i.test(haystack)) return "builtupAreaSqft";
  if (/parking_slots/i.test(haystack)) return "parkingSlots";
  if (/share_units/i.test(haystack)) return "shareUnits";
  return "apartmentNumber";
}

function apartmentCheckViolationMessage(haystack: string): string {
  if (/number_not_blank/i.test(haystack)) return "Enter a flat number.";
  if (/floor/i.test(haystack)) return "Floor is out of range.";
  if (/bhk/i.test(haystack)) return "Configuration is out of range.";
  if (/carpet_area/i.test(haystack)) return "Carpet area is out of range.";
  if (/builtup_area/i.test(haystack)) return "Built-up area is out of range.";
  if (/area_ordering/i.test(haystack))
    return "Built-up area cannot be smaller than the carpet area.";
  if (/parking_slots/i.test(haystack)) return "Parking slots are out of range.";
  if (/share_units/i.test(haystack)) return "Share units are out of range.";
  return "Please check the details and try again.";
}
