import {
  ExpenseError,
  MEMBER_OCCUPANCIES,
  OCCUPANCY_STATUSES,
  asApartmentId,
  asBuildingId,
  asMemberId,
  asWingId,
} from "@ses/domain";
import type {
  BuildingId,
  ParticipantApartment,
  ParticipantMember,
  ParticipantWing,
} from "@ses/domain";
import { z } from "zod";

import {
  asErrorLike,
  SQLSTATE,
} from "../../../common/database/postgres-errors";

/**
 * The database ⇄ domain boundary for participant resolution's reads (Roadmap T063).
 *
 * Four tables, four schemas, one place. Rows are **validated, not trusted**: a column
 * rename, a widened nullability or a value outside an enum must fail here rather than
 * reach a resolution as `undefined` — a resolution that silently mis-read a fact would
 * bill the wrong flat, and the failure would be a wrong number on a resident's screen
 * rather than an error anybody can see.
 *
 * The two `z.enum`s are the load-bearing ones, and they are the *domain's* own unions
 * (`OCCUPANCY_STATUSES`, `MEMBER_OCCUPANCIES`) rather than string lists repeated here:
 * the selector is validated against the same two arrays, so a value this file accepted
 * but the selector refused — or the reverse — is not expressible.
 *
 * `coerce` on the numerics for the reason the structure module's own row schema gives:
 * `smallint`, `numeric(3,1)`, `numeric(8,2)` and `numeric(8,3)` can arrive as strings,
 * and `numeric` always does from some drivers. The apartment projection mirrors that
 * schema field for field, so a flat's `bhk` or `carpetAreaSqft` is the same number here
 * as it is in the structure module's reads — which matters because both feed the same
 * split engine.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────

export const participantApartmentRowSchema = z.object({
  id: z.string(),
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
  is_billable: z.boolean(),
});

export const participantMemberRowSchema = z.object({
  id: z.string(),
  apartment_id: z.string(),
  occupancy: z.enum(MEMBER_OCCUPANCIES),
  is_primary: z.boolean(),
});

/**
 * The one column T066's publish snapshot needs that resolution does not: the member's
 * name *now*, so the split row can record it as it was *then* (PRD §7.3).
 *
 * Non-nullable on purpose — `members.display_name` is `NOT NULL` with a non-blank
 * `CHECK`, so a null here is a schema drift worth failing on rather than a name
 * quietly missing from a snapshot.
 */
export const participantMemberNameRowSchema = z.object({
  id: z.string(),
  display_name: z.string(),
});

export const participantWingRowSchema = z.object({
  id: z.string(),
  building_id: z.string(),
  name: z.string(),
});

export const participantBuildingRowSchema = z.object({ id: z.string() });

export const participantApartmentRowListSchema = z.array(
  participantApartmentRowSchema,
);
export const participantMemberRowListSchema = z.array(
  participantMemberRowSchema,
);
export const participantMemberNameRowListSchema = z.array(
  participantMemberNameRowSchema,
);
export const participantWingRowListSchema = z.array(participantWingRowSchema);
export const participantBuildingRowListSchema = z.array(
  participantBuildingRowSchema,
);

export type ParticipantApartmentRow = z.infer<
  typeof participantApartmentRowSchema
>;
export type ParticipantMemberRow = z.infer<typeof participantMemberRowSchema>;
export type ParticipantWingRow = z.infer<typeof participantWingRowSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Mappers
// ─────────────────────────────────────────────────────────────────────────────

export function apartmentFromRow(
  row: ParticipantApartmentRow,
): ParticipantApartment {
  return {
    id: asApartmentId(row.id),
    buildingId: asBuildingId(row.building_id),
    // `null` is a building without wings, which the selector's wing filter treats as
    // "matches no wing" rather than as an error — see `resolveExpenseParticipants`.
    wingId: row.wing_id === null ? null : asWingId(row.wing_id),
    apartmentNumber: row.apartment_number,
    floor: row.floor,
    bhk: row.bhk,
    carpetAreaSqft: row.carpet_area_sqft,
    builtupAreaSqft: row.builtup_area_sqft,
    parkingSlots: row.parking_slots,
    shareUnits: row.share_units,
    occupancyStatus: row.occupancy_status,
    isBillable: row.is_billable,
  };
}

export function memberFromRow(row: ParticipantMemberRow): ParticipantMember {
  return {
    id: asMemberId(row.id),
    apartmentId: asApartmentId(row.apartment_id),
    occupancy: row.occupancy,
    isPrimary: row.is_primary,
  };
}

export function wingFromRow(row: ParticipantWingRow): ParticipantWing {
  return {
    id: asWingId(row.id),
    buildingId: asBuildingId(row.building_id),
    name: row.name,
  };
}

export function buildingIdFromRow(row: { readonly id: string }): BuildingId {
  return asBuildingId(row.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Failures
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A read that returned a shape this build does not understand.
 *
 * `unknown` rather than `not_found`: the caller's tenancy is not in question — the
 * database answered *something this code cannot read* — and reporting it as a missing
 * society would send a treasurer looking for a permissions problem that does not exist.
 * It is also the honest code for the one failure an operator can act on: the deployed
 * build and the deployed schema disagree.
 */
export function unexpectedShapeError(what: string): ExpenseError {
  return new ExpenseError(
    "unknown",
    "Something went wrong. Please try again.",
    { hint: `Unexpected ${what} shape returned by the database.` },
  );
}

/**
 * Classifies a failure raised by one of this adapter's four reads.
 *
 * Reads only, so the classifier is small and every branch is one of the two things a
 * read can legitimately fail for:
 *
 *  - **`42501`** — `permission denied`, which for a statement run as the caller with
 *    `SET ROLE authenticated` means the policies matched nothing for them. RLS does not
 *    raise for a read, so this arrives from the *column* grants or from a function
 *    guard, and its answer is `not_found` — the same answer a non-member gets
 *    everywhere else, because anything distinguishable would let a caller prove a
 *    society exists (PRD T041).
 *  - **`42P01`** — `undefined_table`, i.e. the schema does not have what this build
 *    expects. `unknown`, never `not_found`: nothing about the caller is wrong.
 *
 * Everything else is `unknown` deliberately. A read has no uniqueness or foreign-key
 * rule to violate, so a `23505` here would be a bug worth reporting as itself rather
 * than translating into a refusal that reads like the caller's fault.
 */
export function participantErrorFromPostgres(error: unknown): ExpenseError {
  const candidate = asErrorLike(error);
  const code = candidate.code ?? "";

  switch (code) {
    case SQLSTATE.insufficientPrivilege:
      return new ExpenseError(
        "not_found",
        "That society is not available to you.",
        {
          code: candidate.code,
        },
      );
    case SQLSTATE.undefinedTable:
      return new ExpenseError(
        "unknown",
        "The database is missing a table this read needs.",
        { code: candidate.code },
      );
    default:
      return new ExpenseError("unknown", "The participant read failed.", {
        code: candidate.code,
      });
  }
}
