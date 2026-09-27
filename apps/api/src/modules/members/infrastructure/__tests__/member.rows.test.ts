import {
  memberErrorFromPostgres,
  memberFromRow,
  memberRowSchema,
  roleToDatabase,
} from "../member.rows";
import type { MemberRow } from "../member.rows";

/**
 * The database boundary: a row becomes a `Member`, and a driver failure becomes one of five
 * codes.
 *
 * Two things are worth covering here that no other layer can:
 *
 *  - **nullability and enums.** A shadow member's `user_id`, an unrecorded floor, a `date`
 *    column arriving as a `Date` at UTC midnight, and the four occupancy labels. If this file
 *    is wrong, every screen is wrong, and the layer above it is a `Result` that cannot tell.
 *  - **the classifier.** `P0001/SOCIETY_ADMIN_REQUIRED` → `sole_admin`, `23505` on
 *    `uq_members_shadow_phone` → a conflict *on the phone field*, `23503` on the apartment key →
 *    a validation failure rather than a 404, and `42501` reading as `not_found` on a read and
 *    `forbidden` on a write. Those are the mappings that turn a database refusal into an answer
 *    a user can act on.
 *
 * The driver errors are hand-built, and that is deliberate but incomplete by construction: the
 * real driver wraps its errors (`DrizzleQueryError`), which is the bug
 * `common/database/postgres-errors.ts` documents, so the *unwrapping* is asserted separately
 * with a wrapped `cause` chain.
 */

/**
 * A driver row, **parsed** — because that is what the repository hands `memberFromRow`.
 *
 * Going through `memberRowSchema` is not ceremony: the schema is where a `Date` becomes
 * `YYYY-MM-DD` and where an ISO string is normalised, so a test that passed a raw object
 * straight to the mapper would assert the API's behaviour against a shape the API never sees.
 */
function row(overrides: Record<string, unknown> = {}): MemberRow {
  return memberRowSchema.parse(rawRow(overrides));
}

function rawRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    society_id: "b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12",
    user_id: null,
    apartment_id: null,
    display_name: "Suresh Menon",
    phone: "+919800000009",
    email: null,
    role: "resident",
    status: "active",
    occupancy: "owner_occupied",
    is_primary: false,
    lease_start: null,
    lease_end: null,
    share_contact: false,
    joined_at: new Date("2026-09-25T10:00:00.000Z"),
    approved_by: null,
    removed_at: null,
    removed_by: null,
    // T049 — the request's own fields, on every row the adapter reads.
    request_note: null,
    rejection_reason: null,
    rejected_at: null,
    rejected_by: null,
    created_at: new Date("2026-09-25T10:00:00.000Z"),
    updated_at: new Date("2026-09-25T10:00:00.000Z"),
    ...overrides,
  };
}

describe("memberFromRow", () => {
  it("maps a shadow member, keeping the null that makes it one", () => {
    const member = memberFromRow(row());

    expect(member.userId).toBeNull();
    expect(member.apartmentId).toBeNull();
    expect(member.apartment).toBeNull();
    expect(member.joinedAt).toBe("2026-09-25T10:00:00.000Z");
  });

  it("maps an account holder and a lease window", () => {
    const member = memberFromRow(
      row({
        user_id: "33333333-3333-4333-8333-333333333333",
        lease_start: new Date("2026-01-01T00:00:00.000Z"),
        lease_end: new Date("2026-12-31T00:00:00.000Z"),
      }),
    );

    expect(member.userId).toBe("33333333-3333-4333-8333-333333333333");
    // The date columns arrive as `Date` at UTC midnight; the entity carries a plain
    // `YYYY-MM-DD`, which is what a date input and the wire contract both want.
    expect(member.leaseStart).toBe("2026-01-01");
    expect(member.leaseEnd).toBe("2026-12-31");
  });

  it("builds the flat label from the join, and only when the flat exists", () => {
    const withFlat = memberFromRow(
      row({
        apartment_id: "cccccccc-0000-4000-8000-000000000001",
        apartment_number: "A-101",
        building_id: "dddddddd-0000-4000-8000-000000000001",
        building_name: "Block A",
        floor: 1,
      }),
    );
    expect(withFlat.apartment).toEqual({
      id: "cccccccc-0000-4000-8000-000000000001",
      number: "A-101",
      buildingId: "dddddddd-0000-4000-8000-000000000001",
      buildingName: "Block A",
      floor: 1,
    });

    // An id with no joined label is a repair artefact, and "no flat recorded" is the honest
    // rendering rather than a half-built address.
    const orphaned = memberFromRow(
      row({ apartment_id: "cccccccc-0000-4000-8000-000000000001" }),
    );
    expect(orphaned.apartment).toBeNull();
    expect(orphaned.apartmentId).toBe("cccccccc-0000-4000-8000-000000000001");
  });

  it("degrades an unknown role to guest and an unknown status to inactive", () => {
    // Forward compatibility: a role or a status added by T046/T049 must never read as `admin`
    // or `active`, which is the failure mode that silently grants access.
    const member = memberFromRow(row({ role: "warden", status: "on_holiday" }));

    expect(member.role).toBe("guest");
    expect(member.status).toBe("inactive");
  });

  it("maps the committee spelling the database uses", () => {
    expect(memberFromRow(row({ role: "committee" })).role).toBe(
      "committee_member",
    );
  });

  it("refuses an occupancy it does not recognise, rather than guessing one", () => {
    // Unlike role and status there is no least-privileged occupancy: it drives which charge
    // heads apply, so guessing would put a billing-relevant value on a member nobody chose.
    expect(() => memberFromRow(row({ occupancy: "squatting" }))).toThrow(
      /Something went wrong/,
    );
  });

  it("reads the flat a member is the primary occupant of", () => {
    const member = memberFromRow(
      row({
        apartment_id: "cccccccc-0000-4000-8000-000000000001",
        apartment_number: "A-101",
        building_id: "dddddddd-0000-4000-8000-000000000001",
        building_name: "Block A",
        floor: 0,
        is_primary: true,
      }),
    );

    // Floor 0 is the ground floor and must not be confused with an unrecorded one.
    expect(member.apartment?.floor).toBe(0);
    expect(member.isPrimary).toBe(true);
  });

  it("keeps the four occupancy labels distinct", () => {
    const labels = [
      "owner_occupied",
      "tenant",
      "family_member",
      "vacant_owner",
    ] as const;
    for (const occupancy of labels) {
      expect(memberFromRow(row({ occupancy })).occupancy).toBe(occupancy);
    }
  });
});

describe("roleToDatabase", () => {
  it("translates the one spelling the database does not share", () => {
    expect(roleToDatabase("committee_member")).toBe("committee");
  });

  it("passes every other role through, and round-trips through roleFromRow", () => {
    const roles = [
      "admin",
      "treasurer",
      "committee_member",
      "resident",
      "tenant",
      "guest",
    ] as const;

    for (const role of roles) {
      // A write and a read of the same role must name the same role. The directory's
      // `role=committee_member` filter carried the bug this pairs with until T046: reads looked
      // right while a filter failed the enum cast with a `22P02`.
      expect(memberFromRow(row({ role: roleToDatabase(role) })).role).toBe(
        role,
      );
    }
  });
});

describe("memberErrorFromPostgres", () => {
  it("reads the role cap as its own code, naming the role field", () => {
    const error = memberErrorFromPostgres(
      {
        code: "P0001",
        message: "SOCIETY_ROLE_CAP_EXCEEDED",
        hint: "A society can have at most 3 admins.",
      },
      "write",
    );

    // Its own code rather than `conflict`: "that value is taken" and "that role is full" are
    // different screens, and the mapper below turns this into a 409 with a detail code.
    expect(error.code).toBe("role_cap_exceeded");
    expect(error.details?.field).toBe("role");
    expect(error.message).toContain("at most 3 admins");
  });

  it("reads the last-admin refusal as sole_admin", () => {
    const error = memberErrorFromPostgres(
      { code: "P0001", message: "SOCIETY_ADMIN_REQUIRED" },
      "write",
    );

    expect(error.code).toBe("sole_admin");
  });

  it("classifies the shadow-phone index as a conflict on the phone field", () => {
    const error = memberErrorFromPostgres(
      {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "uq_members_shadow_phone"',
        constraint_name: "uq_members_shadow_phone",
      },
      "write",
    );

    expect(error.code).toBe("conflict");
    expect(error.details?.field).toBe("phone");
  });

  it("classifies the primary-occupant index as a conflict on the flat", () => {
    const error = memberErrorFromPostgres(
      {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "uq_primary_occupant"',
        constraint_name: "uq_primary_occupant",
      },
      "write",
    );

    expect(error.code).toBe("conflict");
    expect(error.details?.field).toBe("apartmentId");
  });

  it("reports a duplicate membership as an already-a-member conflict", () => {
    const error = memberErrorFromPostgres(
      {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "members_society_user_key"',
        constraint: "members_society_user_key",
      },
      "write",
    );

    expect(error.code).toBe("conflict");
  });

  it("reports a flat from another society as a validation failure, not a 404", () => {
    // The composite key is the only constraint that makes this reachable, and the field is what
    // lets the form highlight the flat picker.
    const error = memberErrorFromPostgres(
      {
        code: "23503",
        message:
          'insert or update on table "members" violates foreign key constraint "fk_members_apartment_society"',
        constraint_name: "fk_members_apartment_society",
      },
      "write",
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("apartmentId");
  });

  it("names the lease field for the window check", () => {
    const error = memberErrorFromPostgres(
      {
        code: "23514",
        message: 'new row violates check constraint "chk_members_lease_window"',
        constraint_name: "chk_members_lease_window",
      },
      "write",
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("leaseEnd");
  });

  it("reads RLS as not_found on a read and forbidden on a write", () => {
    const read = memberErrorFromPostgres(
      { code: "42501", message: "new row violates row-level security policy" },
      "read",
    );
    const write = memberErrorFromPostgres(
      { code: "42501", message: "new row violates row-level security policy" },
      "write",
    );

    expect(read.code).toBe("not_found");
    expect(write.code).toBe("forbidden");
  });

  it("unwraps the error the ORM actually throws", () => {
    // Drizzle wraps the driver's error in its own, whose `code` is undefined. Reading one level
    // deep sent every database failure to `unknown` in the society module until a live database
    // found it; this asserts the shared unwrapper still walks the chain.
    const wrapped = new Error("Failed query") as Error & { cause?: unknown };
    wrapped.cause = {
      code: "23505",
      message:
        'duplicate key value violates unique constraint "uq_members_shadow_phone"',
    };

    const error = memberErrorFromPostgres(wrapped, "write");

    expect(error.code).toBe("conflict");
    expect(error.details?.field).toBe("phone");
  });

  it("keeps the SQLSTATE in the details, and never the server's detail text", () => {
    const error = memberErrorFromPostgres(
      {
        code: "23505",
        message: "duplicate key value",
        detail: "Key (society_id, phone)=(x, +919800000009) already exists.",
      },
      "write",
    );

    expect(error.details?.code).toBe("23505");
    // `detail` can carry column values, and these objects travel toward the UI.
    expect(JSON.stringify(error.details)).not.toContain("+919800000009");
  });

  it("reports a missing migration as an operator hint rather than a user error", () => {
    const error = memberErrorFromPostgres(
      { code: "42P01", message: 'relation "public.members" does not exist' },
      "read",
    );

    expect(error.code).toBe("unknown");
    expect(String(error.details?.hint)).toContain("20260925120000");
  });
});
