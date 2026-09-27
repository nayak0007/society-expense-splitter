import {
  apartmentErrorFromPostgres,
  apartmentFromRow,
  apartmentRowSchema,
  APARTMENT_RAISED_EXCEPTION,
} from "../apartment.rows";
import { RAISED_EXCEPTION } from "../building.rows";
import { SQLSTATE } from "../../../../common/database/postgres-errors";

/**
 * The database ⇄ domain boundary for the flat module.
 *
 * These are the assertions that make the repository's "validate, never trust"
 * claim true rather than aspirational: each one would fail if the translation
 * silently degraded — a cleared measurement read back as zero, an unrecorded floor
 * becoming `0` (ground floor), a `42501` read reported as 403 (leaking that a
 * foreign society exists).
 *
 * Two of them are specific to this table and are why this file is not a copy of the
 * building one:
 *
 *  - `occupancy_status` is an enum, so a row carrying a label the union does not
 *    have must be a shape error rather than a value the domain then guesses at;
 *  - a flat has **three** foreign keys, and `23503` means three different things
 *    depending on the constraint. The classifier reads the name; only a test that
 *    feeds it a named violation proves it does.
 */

/** A row as Postgres returns it, overridable per test. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    society_id: "22222222-2222-4222-8222-222222222222",
    building_id: "33333333-3333-4333-8333-333333333333",
    wing_id: null,
    apartment_number: "A-101",
    floor: 1,
    bhk: 2,
    carpet_area_sqft: 900,
    builtup_area_sqft: 1100,
    parking_slots: 1,
    share_units: 1,
    occupancy_status: "vacant",
    is_commercial: false,
    is_billable: true,
    created_at: "2026-09-24T10:00:00.000Z",
    updated_at: "2026-09-24T10:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

const postgres = (code: string, message: string, extra = {}) => ({
  code,
  message,
  ...extra,
});

describe("apartmentFromRow", () => {
  it("maps snake_case columns onto the entity and brands the ids", () => {
    const apartment = apartmentFromRow(apartmentRowSchema.parse(row()));

    expect(apartment).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      societyId: "22222222-2222-4222-8222-222222222222",
      buildingId: "33333333-3333-4333-8333-333333333333",
      wingId: null,
      apartmentNumber: "A-101",
      floor: 1,
      bhk: 2,
      carpetAreaSqft: 900,
      builtupAreaSqft: 1100,
      parkingSlots: 1,
      shareUnits: 1,
      occupancyStatus: "vacant",
      isCommercial: false,
      isBillable: true,
      createdAt: "2026-09-24T10:00:00.000Z",
      updatedAt: "2026-09-24T10:00:00.000Z",
      deletedAt: null,
    });
  });

  it("keeps 'not recorded' distinct from the ground floor and from zero", () => {
    // The three-way distinction this entity exists to preserve: a floor nobody
    // wrote down, a flat on the ground floor, and one nobody has counted a
    // measurement for.
    const unrecorded = apartmentFromRow(
      apartmentRowSchema.parse(row({ floor: null, carpet_area_sqft: null })),
    );
    const ground = apartmentFromRow(
      apartmentRowSchema.parse(row({ floor: 0 })),
    );

    expect(unrecorded.floor).toBeNull();
    expect(unrecorded.carpetAreaSqft).toBeNull();
    expect(ground.floor).toBe(0);
  });

  it("brands a wing reference when the column is set", () => {
    const apartment = apartmentFromRow(
      apartmentRowSchema.parse({
        ...row(),
        wing_id: "44444444-4444-4444-8444-444444444444",
      }),
    );

    expect(apartment.wingId).toBe("44444444-4444-4444-8444-444444444444");
  });

  it("coerces the numeric columns, which arrive as strings from `numeric`", () => {
    const apartment = apartmentFromRow(
      apartmentRowSchema.parse(
        row({
          bhk: "2.5",
          carpet_area_sqft: "900.50",
          builtup_area_sqft: "1100.00",
          share_units: "1.500",
        }),
      ),
    );

    expect(apartment.bhk).toBe(2.5);
    expect(apartment.carpetAreaSqft).toBe(900.5);
    expect(apartment.builtupAreaSqft).toBe(1100);
    expect(apartment.shareUnits).toBe(1.5);
  });

  it("normalises all three timestamp serialisations to one shape", () => {
    const asDate = apartmentFromRow(
      apartmentRowSchema.parse(
        row({ created_at: new Date("2026-09-24T10:00:00Z") }),
      ),
    );
    const asText = apartmentFromRow(
      apartmentRowSchema.parse(row({ created_at: "2026-09-24 10:00:00+00" })),
    );

    expect(asDate.createdAt).toBe("2026-09-24T10:00:00.000Z");
    expect(asText.createdAt).toBe("2026-09-24T10:00:00.000Z");
  });

  it("refuses a row whose occupancy label is not in the enum", () => {
    // A half-applied migration is the real case: the column exists, the label does
    // not. Reported as a shape error at the boundary rather than as a string the
    // domain's union pretends to have.
    expect(
      apartmentRowSchema.safeParse(row({ occupancy_status: "haunted" }))
        .success,
    ).toBe(false);
  });

  it("rejects a row missing a column it needs, rather than passing undefined on", () => {
    const broken: Record<string, unknown> = row();
    delete broken.apartment_number;

    expect(apartmentRowSchema.safeParse(broken).success).toBe(false);
  });
});

describe("apartmentErrorFromPostgres", () => {
  it("reads a not-found condition as not_found for both contexts", () => {
    // `apartment_soft_delete` reports both "no such flat" and "not in that society"
    // this way, and the two must stay indistinguishable (PRD T041).
    expect(
      apartmentErrorFromPostgres(
        postgres(SQLSTATE.notFound, "APARTMENT_NOT_FOUND"),
        "write",
      ).code,
    ).toBe("not_found");
    expect(
      apartmentErrorFromPostgres(
        postgres(SQLSTATE.notFound, "APARTMENT_NOT_FOUND"),
        "read",
      ).code,
    ).toBe("not_found");
  });

  it("recognises the soft-delete function's own exception by name", () => {
    const error = apartmentErrorFromPostgres(
      postgres(SQLSTATE.raised, APARTMENT_RAISED_EXCEPTION.apartmentNotFound),
      "write",
    );

    expect(error.code).toBe("not_found");
  });

  it("tells a read and a write apart for the same SQLSTATE", () => {
    const denial = postgres(SQLSTATE.insufficientPrivilege, "denied");

    expect(apartmentErrorFromPostgres(denial, "read").code).toBe("not_found");
    expect(apartmentErrorFromPostgres(denial, "write").code).toBe("forbidden");
  });

  it("turns a duplicate flat number into a conflict carrying the field", () => {
    const error = apartmentErrorFromPostgres(
      postgres(SQLSTATE.uniqueViolation, "duplicate key value", {
        constraint_name: "uq_apartments_building_number",
      }),
      "write",
    );

    expect(error.code).toBe("conflict");
    // The field is what lets the flat form highlight the number input instead of
    // showing a banner.
    expect(error.details?.field).toBe("apartmentNumber");
  });

  it("names the field for each check violation", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["chk_apartments_number_not_blank", "apartmentNumber"],
      ["chk_apartments_floor", "floor"],
      ["chk_apartments_bhk", "bhk"],
      ["chk_apartments_carpet_area", "carpetAreaSqft"],
      ["chk_apartments_builtup_area", "builtupAreaSqft"],
      ["chk_apartments_area_ordering", "builtupAreaSqft"],
      ["chk_apartments_parking_slots", "parkingSlots"],
      ["chk_apartments_share_units", "shareUnits"],
    ];

    for (const [constraint, field] of cases) {
      const error = apartmentErrorFromPostgres(
        postgres(SQLSTATE.checkViolation, "violates check constraint", {
          constraint_name: constraint,
        }),
        "write",
      );

      expect(error.code).toBe("validation");
      expect(error.details?.field).toBe(field);
    }
  });

  it("reads a wing that is not in this building as a field error, not a 404", () => {
    // The composite FK `(wing_id, building_id)` is what makes a wing from another
    // building unrepresentable; the caller can fix it by choosing a different wing,
    // so it is a validation failure and not a missing resource.
    const error = apartmentErrorFromPostgres(
      postgres(
        SQLSTATE.foreignKeyViolation,
        "violates foreign key constraint",
        {
          constraint_name: "fk_apartments_wing",
        },
      ),
      "write",
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("wingId");
  });

  it("reads a broken building FK as a not-found building", () => {
    const error = apartmentErrorFromPostgres(
      postgres(
        SQLSTATE.foreignKeyViolation,
        "violates foreign key constraint",
        {
          constraint_name: "apartments_building_id_fkey",
        },
      ),
      "write",
    );

    expect(error.code).toBe("not_found");
    expect(error.message).toContain("building");
  });

  it("reads a broken society FK as a not-found society", () => {
    const error = apartmentErrorFromPostgres(
      postgres(
        SQLSTATE.foreignKeyViolation,
        "violates foreign key constraint",
        {
          constraint_name: "apartments_society_id_fkey",
        },
      ),
      "write",
    );

    expect(error.code).toBe("not_found");
    expect(error.message).toContain("society");
  });

  it("names the migration to apply when the table is missing", () => {
    const error = apartmentErrorFromPostgres(
      postgres(
        SQLSTATE.undefinedTable,
        'relation "public.apartments" does not exist',
      ),
      "read",
    );

    expect(error.code).toBe("unknown");
    expect(String(error.details?.hint)).toContain("20260924140000");
  });

  it("classifies an RLS message that arrived without a SQLSTATE", () => {
    const denial = postgres(
      "00000",
      'new row violates row-level security policy for table "apartments"',
    );

    expect(apartmentErrorFromPostgres(denial, "read").code).toBe("not_found");
    expect(apartmentErrorFromPostgres(denial, "write").code).toBe("forbidden");
  });

  it("falls back to unknown for a failure it cannot place", () => {
    expect(
      apartmentErrorFromPostgres(new Error("socket closed"), "read").code,
    ).toBe("unknown");
  });

  it("never copies Postgres's detail into a message the UI could render", () => {
    const error = apartmentErrorFromPostgres(
      postgres(SQLSTATE.checkViolation, "violates check constraint", {
        detail: "Failing row contains (A-101, -900).",
      }),
      "write",
    );

    expect(error.message).not.toContain("Failing row");
  });

  /**
   * The wrapper Drizzle actually throws — see `postgres-errors.ts` for why every
   * hand-built error above is not enough on its own.
   */
  it("does not hide the driver's SQLSTATE behind `cause`", () => {
    const wrapped = {
      name: "DrizzleQueryError",
      query: "insert into public.apartments …",
      params: [],
      cause: {
        code: SQLSTATE.uniqueViolation,
        message: "duplicate key value violates unique constraint",
        constraint_name: "uq_apartments_building_number",
      },
    };

    const error = apartmentErrorFromPostgres(wrapped, "write");
    expect(error.code).toBe("conflict");
    expect(error.details?.field).toBe("apartmentNumber");
  });

  it("does not mistake the building's refusal for a flat failure", () => {
    // `building_soft_delete` raises `BUILDING_HAS_APARTMENTS` as a `P0001`, and the
    // *building* repository's classifier owns it. This classifier seeing it means a
    // statement it does not own raised it, so the honest answer is `unknown` — and
    // asserting that keeps the two vocabularies from quietly merging.
    const error = apartmentErrorFromPostgres(
      postgres(SQLSTATE.raised, RAISED_EXCEPTION.buildingHasApartments),
      "write",
    );

    expect(error.code).toBe("unknown");
  });
});
