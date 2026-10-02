import { OCCUPANCY_STATUSES, isExpenseError } from "@ses/domain";

import { SQLSTATE } from "../../../../common/database/postgres-errors";
import {
  apartmentFromRow,
  buildingIdFromRow,
  memberFromRow,
  participantApartmentRowSchema,
  participantBuildingRowSchema,
  participantErrorFromPostgres,
  participantMemberRowSchema,
  participantWingRowSchema,
  unexpectedShapeError,
  wingFromRow,
} from "../participant.rows";

/**
 * The database ⇄ domain boundary for participant resolution — Roadmap T063.
 *
 * These are the assertions that make the adapter's "validate, never trust" claim true
 * rather than aspirational, and each one guards a failure that would be *silent*:
 *
 *  - a `smallint`/`numeric` that arrived as a string and reached the split engine as
 *    `"700"` instead of `700` would compute a wrong share rather than raise;
 *  - an `occupancy_status` or `occupancy` value this build does not know must fail here,
 *    because the selector was validated against the *same two unions* — a value accepted
 *    on one side and refused on the other is not expressible if both read the domain's
 *    array;
 *  - a `42501` on one of these reads is RLS saying the caller is not in this tenant, so
 *    it must answer `not_found` (PRD T041 — no existence leak), never `forbidden`;
 *  - a missing table is `unknown`: nothing about the caller is wrong, the deployed build
 *    and the deployed schema disagree.
 */

/** A row as Postgres returns it, overridable per test. */
function apartmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    building_id: "22222222-2222-4222-8222-222222222222",
    wing_id: null,
    apartment_number: "A-101",
    floor: 1,
    bhk: 2,
    carpet_area_sqft: 700,
    builtup_area_sqft: 875,
    parking_slots: 1,
    share_units: 1,
    occupancy_status: "owner_occupied",
    is_billable: true,
    ...overrides,
  };
}

describe("apartmentFromRow", () => {
  it("maps the columns the six bases read onto the port's shape", () => {
    const apartment = apartmentFromRow(
      participantApartmentRowSchema.parse(apartmentRow()),
    );

    expect(apartment).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      buildingId: "22222222-2222-4222-8222-222222222222",
      wingId: null,
      apartmentNumber: "A-101",
      floor: 1,
      bhk: 2,
      carpetAreaSqft: 700,
      builtupAreaSqft: 875,
      parkingSlots: 1,
      shareUnits: 1,
      occupancyStatus: "owner_occupied",
      isBillable: true,
    });
  });

  it("coerces the numeric columns, which the driver may return as strings", () => {
    // `numeric` always arrives as text from some drivers, and a weight that stayed a
    // string would not be a lossy float — it would be *no* number at all, and the
    // split engine's per-area bases would compute from `NaN`.
    const apartment = apartmentFromRow(
      participantApartmentRowSchema.parse(
        apartmentRow({
          floor: "3",
          bhk: "1.5",
          carpet_area_sqft: "700.00",
          builtup_area_sqft: "875.00",
          parking_slots: "2",
          share_units: "1.500",
        }),
      ),
    );

    expect(apartment).toMatchObject({
      floor: 3,
      bhk: 1.5,
      carpetAreaSqft: 700,
      builtupAreaSqft: 875,
      parkingSlots: 2,
      shareUnits: 1.5,
    });
    // Still numbers, and still exact for these values: `1.5` and `700` have exact
    // binary representations, which is why the columns are decimals and not money.
    expect(typeof apartment.shareUnits).toBe("number");
  });

  it("keeps an unrecorded area, BHK or floor as null rather than zero", () => {
    // `null` is "not recorded" and `0` is a value the database's checks refuse
    // (`carpet_area_sqft > 0`). Folding the two together would exempt a flat from a
    // per-area split instead of reporting it as missing — the warning the engine
    // exists to produce.
    const apartment = apartmentFromRow(
      participantApartmentRowSchema.parse(
        apartmentRow({
          floor: null,
          bhk: null,
          carpet_area_sqft: null,
          builtup_area_sqft: null,
        }),
      ),
    );

    expect(apartment).toMatchObject({
      floor: null,
      bhk: null,
      carpetAreaSqft: null,
      builtupAreaSqft: null,
    });
  });

  it("brands a wing id when the flat has one, and keeps null when it does not", () => {
    expect(
      apartmentFromRow(
        participantApartmentRowSchema.parse(
          apartmentRow({ wing_id: "33333333-3333-4333-8333-333333333333" }),
        ),
      ).wingId,
    ).toBe("33333333-3333-4333-8333-333333333333");
    expect(
      apartmentFromRow(participantApartmentRowSchema.parse(apartmentRow()))
        .wingId,
    ).toBeNull();
  });

  it("accepts every occupancy status the domain knows and refuses anything else", () => {
    for (const status of OCCUPANCY_STATUSES) {
      expect(
        participantApartmentRowSchema.safeParse(
          apartmentRow({ occupancy_status: status }),
        ).success,
      ).toBe(true);
    }

    // The same union the selector validates against, so a status the database's enum
    // gained but this build has no rule for fails here rather than resolving to a
    // filter that silently matches nothing.
    expect(
      participantApartmentRowSchema.safeParse(
        apartmentRow({ occupancy_status: "demolished" }),
      ).success,
    ).toBe(false);
  });

  it("refuses a row missing a column it needs rather than passing undefined on", () => {
    const broken: Record<string, unknown> = apartmentRow();
    delete broken.is_billable;

    expect(participantApartmentRowSchema.safeParse(broken).success).toBe(false);
  });
});

describe("memberFromRow", () => {
  it("maps the membership facts owner-only routing reads, and nothing else", () => {
    const member = memberFromRow(
      participantMemberRowSchema.parse({
        id: "44444444-4444-4444-8444-444444444444",
        apartment_id: "11111111-1111-4111-8111-111111111111",
        occupancy: "vacant_owner",
        is_primary: true,
      }),
    );

    expect(member).toEqual({
      id: "44444444-4444-4444-8444-444444444444",
      apartmentId: "11111111-1111-4111-8111-111111111111",
      occupancy: "vacant_owner",
      isPrimary: true,
    });
    // The projection carries no user id, so a shadow member — `user_id IS NULL` — is
    // indistinguishable from an account-holding one here, which is the point: owner
    // routing must not require an auth user.
    expect(member).not.toHaveProperty("userId");
  });

  it("refuses an occupancy the domain's membership union does not have", () => {
    for (const occupancy of [
      "owner_occupied",
      "tenant",
      "family_member",
      "vacant_owner",
    ]) {
      expect(
        participantMemberRowSchema.safeParse({
          id: "44444444-4444-4444-8444-444444444444",
          apartment_id: "11111111-1111-4111-8111-111111111111",
          occupancy,
          is_primary: false,
        }).success,
      ).toBe(true);
    }

    expect(
      participantMemberRowSchema.safeParse({
        id: "44444444-4444-4444-8444-444444444444",
        apartment_id: "11111111-1111-4111-8111-111111111111",
        // `rented` is the *flat's* vocabulary, not the member's — the pair the
        // selector's own docstring warns about.
        occupancy: "rented",
        is_primary: false,
      }).success,
    ).toBe(false);
  });
});

describe("wing and building rows", () => {
  it("maps a wing name and its building, and brands both ids", () => {
    const wing = wingFromRow(
      participantWingRowSchema.parse({
        id: "55555555-5555-4555-8555-555555555555",
        building_id: "22222222-2222-4222-8222-222222222222",
        name: "A",
      }),
    );

    expect(wing).toEqual({
      id: "55555555-5555-4555-8555-555555555555",
      buildingId: "22222222-2222-4222-8222-222222222222",
      name: "A",
    });
  });

  it("accepts an id-only building row — the shape the selector's strict check reads", () => {
    expect(
      buildingIdFromRow(
        participantBuildingRowSchema.parse({
          id: "22222222-2222-4222-8222-222222222222",
        }),
      ),
    ).toBe("22222222-2222-4222-8222-222222222222");
  });
});

describe("unexpectedShapeError", () => {
  it("stays generic and puts the actionable part in details", () => {
    const error = unexpectedShapeError("participant apartment");

    expect(error.code).toBe("unknown");
    expect(error.message).toBe("Something went wrong. Please try again.");
    // The hint can surface in a log; it names what was unreadable without naming a
    // column value.
    expect(String(error.details?.hint)).toContain("participant apartment");
    expect(isExpenseError(error)).toBe(true);
  });
});

describe("participantErrorFromPostgres", () => {
  const postgres = (code: string, message: string, extra = {}) => ({
    code,
    message,
    ...extra,
  });

  it("reads a permission denial as not_found — a read must not leak existence", () => {
    const error = participantErrorFromPostgres(
      postgres(SQLSTATE.insufficientPrivilege, "permission denied"),
    );

    expect(error.code).toBe("not_found");
    expect(error.message).toBe("That society is not available to you.");
  });

  it("reports a missing table as unknown rather than as the caller's fault", () => {
    const error = participantErrorFromPostgres(
      postgres(
        SQLSTATE.undefinedTable,
        'relation "public.apartments" does not exist',
      ),
    );

    expect(error.code).toBe("unknown");
    expect(error.message).toContain("missing a table");
  });

  it("falls back to unknown for a failure it cannot place", () => {
    expect(participantErrorFromPostgres(new Error("socket closed")).code).toBe(
      "unknown",
    );
    expect(participantErrorFromPostgres({ code: "40001" }).code).toBe(
      "unknown",
    );
  });

  it("does not hide the driver's SQLSTATE behind Drizzle's wrapper", () => {
    // `tx.execute()` throws a `DrizzleQueryError` whose own properties are `query`,
    // `params` and `cause` — a classifier that read `error.code` directly would send
    // every real failure to the default branch while this file stayed green.
    const wrapped = {
      name: "DrizzleQueryError",
      query: "select id from public.apartments",
      params: [],
      cause: postgres(SQLSTATE.insufficientPrivilege, "permission denied"),
    };

    expect(participantErrorFromPostgres(wrapped).code).toBe("not_found");
  });
});
