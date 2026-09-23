import { asSocietyId, asUserId, isSocietyError } from "@ses/domain";
import type { CreateSocietyInput, UpdateSocietyInput } from "@ses/domain";

import {
  createPayload,
  isJoinCodeCollision,
  joinPreviewFromPayload,
  joinPreviewSchema,
  membershipFromRow,
  occupancyToRow,
  RAISED_EXCEPTION,
  societyErrorFromPostgres,
  societyFromSnapshot,
  societySnapshotSchema,
  SQLSTATE,
  updatePayload,
} from "../society.rows";

/**
 * The database ⇄ domain boundary.
 *
 * These are the assertions that make the repository's "validate, never trust"
 * claim true rather than aspirational: each one would fail if the translation
 * silently degraded — a `42501` read reported as 403 (leaking that a foreign
 * society exists), an unrecognised role landing on `admin`, a cleared field
 * becoming "leave it alone".
 */

/** A full snapshot as `society_snapshot()` renders it, overridable per test. */
function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    society: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Green Meadows",
      slug: "green-meadows",
      society_type: "apartment",
      registration_no: "REG-1",
      address_line1: "1 MG Road",
      address_line2: null,
      city: "Pune",
      state: "MH",
      pincode: "411001",
      country: "IN",
      currency: "INR",
      timezone: "Asia/Kolkata",
      join_code: "ABC123",
      join_code_expires_at: null,
      plan: "free",
      created_by: "22222222-2222-4222-8222-222222222222",
      created_at: "2026-09-01T00:00:00.000Z",
      updated_at: "2026-09-01T00:00:00.000Z",
      deleted_at: null,
      // Columns the domain does not model yet. Present on purpose: the schema is
      // non-strict so a forward-compatible database does not break the read path.
      logo_key: null,
      ...(overrides.society as Record<string, unknown> | undefined),
    },
    settings: overrides.settings ?? {
      billing_day: 1,
      due_day: 10,
      grace_days: 5,
      approval_threshold_paise: 500_000,
      bill_vacant_flats: false,
      allow_partial_payments: true,
      defaulter_list_public: false,
      financial_year_start_month: 4,
    },
    membership: overrides.membership ?? {
      id: "33333333-3333-4333-8333-333333333333",
      society_id: "11111111-1111-4111-8111-111111111111",
      user_id: "22222222-2222-4222-8222-222222222222",
      role: "admin",
      status: "active",
      occupancy: "owner_occupied",
      joined_at: "2026-09-01T00:00:00.000Z",
    },
    memberCount: overrides.memberCount ?? 3,
  };
}

describe("societySnapshotSchema", () => {
  it("accepts a snapshot carrying columns the domain does not model", () => {
    // A strict schema here would reject the whole payload the first time a
    // migration adds a column, which is a data-layer change breaking a screen.
    expect(societySnapshotSchema.safeParse(snapshot()).success).toBe(true);
  });

  it("normalises postgres.js Date columns and RPC ISO strings to the same shape", () => {
    // The two arrive differently: a `timestamptz` column is a `Date` over the
    // driver, while every `jsonb` field is an ISO string. A copy written against
    // only one of them would emit `Date` objects wherever a row is read directly.
    const parsed = societySnapshotSchema.parse(
      snapshot({
        society: { created_at: new Date("2026-09-01T00:00:00.000Z") },
      }),
    );

    expect(parsed.society.created_at).toBe("2026-09-01T00:00:00.000Z");
    expect(typeof parsed.society.created_at).toBe("string");
  });

  it("treats Postgres's own text timestamp form as the same instant", () => {
    const parsed = societySnapshotSchema.parse(
      snapshot({ society: { created_at: "2026-09-01 05:30:00+05:30" } }),
    );

    expect(parsed.society.created_at).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("societyFromSnapshot", () => {
  it("maps a row to the domain, pinning the two fields the PRD fixes", () => {
    const society = societyFromSnapshot(
      societySnapshotSchema.parse(snapshot()),
    );

    expect(society.id).toBe("11111111-1111-4111-8111-111111111111");
    expect(society.name).toBe("Green Meadows");
    // PRD §3.2 step 1: INR is the only supported currency, and the app is
    // India-only. Deriving these from the row would let a bad migration change
    // how every amount in the app is rendered.
    expect(society.currency).toBe("INR");
    expect(society.country).toBe("IN");
    expect(society.memberCount).toBe(3);
  });

  it("keeps a future society type from crashing the read path", () => {
    const society = societyFromSnapshot(
      societySnapshotSchema.parse(
        snapshot({ society: { society_type: "houseboat_collective" } }),
      ),
    );

    expect(society.type).toBe("other");
  });

  it("maps premium to the domain's single paid tier, lossily and deliberately", () => {
    const society = societyFromSnapshot(
      societySnapshotSchema.parse(snapshot({ society: { plan: "premium" } })),
    );

    expect(society.plan).toBe("pro");
  });

  it("falls back to documented defaults when the settings row is missing", () => {
    // `seed_society()` guarantees the row, so reaching this means the server is
    // already broken — a society that cannot render at all is a worse outcome
    // than one showing default billing days.
    const society = societyFromSnapshot(
      societySnapshotSchema.parse(snapshot({ settings: null })),
    );

    expect(society.settings.timezone).toBe("Asia/Kolkata");
    expect(society.settings.currency).toBe("INR");
    expect(society.settings.billingDay).toBeGreaterThan(0);
  });
});

describe("membershipFromRow", () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: "33333333-3333-4333-8333-333333333333",
    society_id: "11111111-1111-4111-8111-111111111111",
    user_id: "22222222-2222-4222-8222-222222222222",
    role: "admin",
    status: "active",
    occupancy: "owner_occupied",
    joined_at: null,
    ...overrides,
  });

  it("translates the database's vocabulary into the domain's", () => {
    const membership = membershipFromRow(row({ role: "committee" }));

    // PRD §7 spells the role `committee`; the domain spells it
    // `committee_member`. Getting this wrong would make a committee member
    // unrecognisable to every capability rule.
    expect(membership.role).toBe("committee_member");
    expect(membership.occupancyType).toBe("owner");
  });

  it("collapses the database's five membership states onto the domain's three", () => {
    expect(membershipFromRow(row({ status: "inactive" })).status).toBe(
      "removed",
    );
    expect(membershipFromRow(row({ status: "rejected" })).status).toBe(
      "removed",
    );
    expect(membershipFromRow(row({ status: "pending" })).status).toBe(
      "pending",
    );
  });

  it("degrades an unrecognised role or status to the least privileged option", () => {
    // A forward-compatible database (a role added by T046) must not silently
    // grant access: an unknown role is never an Admin, and an unknown status is
    // never active.
    const membership = membershipFromRow(
      row({ role: "auditor", status: "shadow_banned" }),
    );

    expect(membership.role).toBe("guest");
    expect(membership.status).toBe("removed");
  });

  it("refuses to invent a user id for a shadow member", () => {
    // An occupant recorded before they had an account. The domain cannot
    // represent one, and fabricating an id would attribute their row to a real
    // account — T045 owns the real representation.
    expect(() => membershipFromRow(row({ user_id: null }))).toThrow(
      "cannot be represented",
    );
  });
});

describe("toIso-through-the-schemas", () => {
  it("normalises a null nullable timestamp rather than inventing an epoch", () => {
    const society = societyFromSnapshot(
      societySnapshotSchema.parse(snapshot({ society: { deleted_at: null } })),
    );

    expect(society.deletedAt).toBeNull();
  });
});

describe("joinPreviewSchema / joinPreviewFromPayload", () => {
  it("parses the RPC's camelCase payload, which is not a row", () => {
    const parsed = joinPreviewSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Green Meadows",
      city: "Pune",
      state: "MH",
      type: "apartment",
      memberCount: 12,
      joinCodeExpiresAt: null,
    });

    expect(joinPreviewFromPayload(parsed).memberCount).toBe(12);
  });

  it("defaults a missing expiry to null rather than undefined", () => {
    // The field is optional in the payload because an older deployed SQL
    // function may not emit it; the domain wants a definite value so a client
    // never sees `undefined` where it expects an instant.
    const parsed = joinPreviewSchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Green Meadows",
      city: "Pune",
      state: "MH",
      type: "apartment",
      memberCount: 12,
    });

    expect(joinPreviewFromPayload(parsed).joinCodeExpiresAt).toBeNull();
  });
});

describe("createPayload", () => {
  it("sends what the user chose and nothing the server derives", () => {
    const input: CreateSocietyInput = {
      name: "Green Meadows",
      type: "apartment",
      city: "Pune",
      state: "MH",
      billingDay: 1,
      dueDay: 10,
      approvalThresholdPaise: 500_000,
    };

    const payload = createPayload(input);

    // No slug, no join code, no membership: the RPC mints those, and sending
    // them would invite a caller to choose their own tenancy identifiers.
    expect(Object.keys(payload).sort()).toEqual([
      "addressLine1",
      "addressLine2",
      "approvalThresholdPaise",
      "billingDay",
      "city",
      "dueDay",
      "name",
      "pincode",
      "registrationNumber",
      "state",
      "type",
    ]);
    expect(payload.registrationNumber).toBeNull();
  });
});

describe("updatePayload", () => {
  it("distinguishes 'clear this field' from 'leave it alone'", () => {
    // The domain expresses a clear as a key that is present and undefined, and
    // `JSON.stringify` drops such keys — so a naive spread would turn "clear the
    // registration number" into "leave it as it was", silently.
    const input: UpdateSocietyInput = {
      name: "Green Meadows",
      registrationNumber: undefined,
    };

    const payload = updatePayload(input);

    expect(Object.keys(payload)).toContain("registrationNumber");
    expect(payload.registrationNumber).toBeNull();
    expect(payload).not.toHaveProperty("city");
  });
});

describe("occupancyToRow", () => {
  it("maps the one value whose row spelling differs", () => {
    expect(occupancyToRow("owner")).toBe("owner_occupied");
    expect(occupancyToRow("tenant")).toBe("tenant");
  });
});

describe("isJoinCodeCollision", () => {
  it("recognises a join-code collision, the one unique violation worth retrying", () => {
    expect(
      isJoinCodeCollision({
        code: SQLSTATE.uniqueViolation,
        detail: "Key (join_code)=(ABC123) already exists.",
      }),
    ).toBe(true);
  });

  it("does not treat another unique violation as a collision", () => {
    // Retrying a slug or membership collision would fail identically and turn
    // one clear error into two round trips and a generic failure.
    expect(
      isJoinCodeCollision({
        code: SQLSTATE.uniqueViolation,
        detail: "Key (slug)=(green-meadows) already exists.",
      }),
    ).toBe(false);
    expect(isJoinCodeCollision(new Error("socket closed"))).toBe(false);
  });
});

describe("societyErrorFromPostgres", () => {
  it("reports a read refusal as not_found, so a foreign society stays invisible", () => {
    // PRD T041: a non-member must not be able to tell a society that exists from
    // one that does not. A 42501 on a read is exactly that case.
    const error = societyErrorFromPostgres(
      { code: SQLSTATE.insufficientPrivilege, message: "permission denied" },
      "read",
    );

    expect(error.code).toBe("not_found");
  });

  it("reports a write refusal as forbidden, because the caller is a member", () => {
    // The RPC has already run its membership check by this point, so the caller
    // is a member who lacks the role. Answering not_found would leave a
    // Treasurer staring at "not found" for their own society.
    const error = societyErrorFromPostgres(
      { code: SQLSTATE.insufficientPrivilege, message: "permission denied" },
      "write",
    );

    expect(error.code).toBe("forbidden");
  });

  it("reads a missing table as a developer error, not a user one", () => {
    // The actionable half travels in `details.hint`, which the UI never renders.
    const error = societyErrorFromPostgres(
      { code: SQLSTATE.undefinedTable, message: "relation does not exist" },
      "read",
    );

    expect(error.code).toBe("unknown");
    expect(String(error.details?.hint)).toContain("supabase/migrations");
  });

  it("names the column for a check violation, so a form can highlight it", () => {
    expect(
      societyErrorFromPostgres(
        {
          code: SQLSTATE.checkViolation,
          detail: "Failing row contains (..., pincode).",
        },
        "write",
      ).message,
    ).toBe("Enter a 6-digit PIN code.");
  });

  it("separates a join-code collision from a membership one", () => {
    const joinCode = societyErrorFromPostgres(
      {
        code: SQLSTATE.uniqueViolation,
        detail: "Key (join_code)=(ABC123) already exists.",
      },
      "write",
    );
    const membership = societyErrorFromPostgres(
      {
        code: SQLSTATE.uniqueViolation,
        detail: "Key (society_id, user_id)=(..., ...) already exists.",
      },
      "write",
    );

    expect(joinCode.code).toBe("conflict");
    expect(membership.code).toBe("already_member");
  });

  it("never copies Postgres's detail into the message", () => {
    // `detail` carries column values — a join code, an email — and these objects
    // travel toward the UI.
    const error = societyErrorFromPostgres(
      {
        code: SQLSTATE.uniqueViolation,
        detail: "Key (join_code)=(SECRET) already exists.",
        message: "duplicate key value violates unique constraint",
      },
      "write",
    );

    expect(error.message).not.toContain("SECRET");
    expect(JSON.stringify(error.message)).not.toContain("SECRET");
  });

  it("translates each exception the migrations raise by name", () => {
    const raised = (name: string) =>
      societyErrorFromPostgres(
        { code: SQLSTATE.raised, message: name },
        "write",
      ).code;

    // Matched by name rather than by code, because they all travel as P0001.
    // This list is what makes a `RAISE EXCEPTION` added to the SQL without a
    // matching entry here visible in review.
    expect(raised(RAISED_EXCEPTION.societyAdminRequired)).toBe("sole_admin");
    expect(raised(RAISED_EXCEPTION.societyNotFound)).toBe("not_found");
    expect(raised(RAISED_EXCEPTION.societyForbidden)).toBe("forbidden");
    expect(raised(RAISED_EXCEPTION.notAuthenticated)).toBe("forbidden");
    expect(raised(RAISED_EXCEPTION.memberStatusChangeForbidden)).toBe(
      "forbidden",
    );
    expect(raised(RAISED_EXCEPTION.emptyPatch)).toBe("validation");
  });

  it("classifies an unrecognised failure as unknown rather than guessing", () => {
    const error = societyErrorFromPostgres(new Error("socket closed"), "write");

    expect(isSocietyError(error)).toBe(true);
    expect(error.code).toBe("unknown");
  });
});

describe("branded ids", () => {
  it("round-trips the ids the repository builds from rows", () => {
    const id = asSocietyId("11111111-1111-4111-8111-111111111111");
    const actor = asUserId("22222222-2222-4222-8222-222222222222");

    expect(typeof id).toBe("string");
    expect(typeof actor).toBe("string");
  });
});
