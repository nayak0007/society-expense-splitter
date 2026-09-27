import { isStructureError } from "@ses/domain";

import { SQLSTATE } from "../../../../common/database/postgres-errors";
import {
  buildingFromRow,
  buildingRowSchema,
  RAISED_EXCEPTION,
  structureErrorFromPostgres,
  unexpectedShapeError,
} from "../building.rows";

/**
 * The database ⇄ domain boundary for the building module.
 *
 * These are the assertions that make the repository's "validate, never trust"
 * claim true rather than aspirational: each one would fail if the translation
 * silently degraded — a `42501` read reported as 403 (leaking that a foreign
 * society exists), a `NULL` floor count becoming `0`, a cleared field becoming
 * "leave it alone".
 */

/** A row as Postgres returns it, overridable per test. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    society_id: "22222222-2222-4222-8222-222222222222",
    name: "Block A",
    total_floors: 12,
    display_order: 1,
    created_at: "2026-09-24T10:00:00.000Z",
    updated_at: "2026-09-24T10:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

describe("buildingFromRow", () => {
  it("maps snake_case columns onto the entity and brands the ids", () => {
    const building = buildingFromRow(buildingRowSchema.parse(row()));

    expect(building).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      societyId: "22222222-2222-4222-8222-222222222222",
      name: "Block A",
      totalFloors: 12,
      displayOrder: 1,
      createdAt: "2026-09-24T10:00:00.000Z",
      updatedAt: "2026-09-24T10:00:00.000Z",
      deletedAt: null,
    });
  });

  it("keeps 'not recorded' distinct from zero", () => {
    const building = buildingFromRow(
      buildingRowSchema.parse(row({ total_floors: null })),
    );

    // `null`, never 0: a building with no floors is a data-entry mistake the
    // domain refuses, so the reader must not invent one either.
    expect(building.totalFloors).toBeNull();
  });

  it("normalises all three timestamp serialisations to one shape", () => {
    // `postgres.js` returns a Date for a direct column read, Postgres's text form
    // arrives for a cast, and an RPC's jsonb carries an ISO string. A reader that
    // handled one and not the others produces two types for one field.
    const asDate = buildingFromRow(
      buildingRowSchema.parse(
        row({ created_at: new Date("2026-09-24T10:00:00Z") }),
      ),
    );
    const asText = buildingFromRow(
      buildingRowSchema.parse(row({ created_at: "2026-09-24 10:00:00+00" })),
    );

    expect(asDate.createdAt).toBe("2026-09-24T10:00:00.000Z");
    expect(asText.createdAt).toBe("2026-09-24T10:00:00.000Z");
  });

  it("coerces numeric columns that arrive as strings", () => {
    const building = buildingFromRow(
      buildingRowSchema.parse(row({ total_floors: "3", display_order: "2" })),
    );

    expect(building.totalFloors).toBe(3);
    expect(building.displayOrder).toBe(2);
  });

  it("rejects a row missing a column it needs, rather than passing undefined on", () => {
    const broken: Record<string, unknown> = row();
    delete broken.name;

    expect(buildingRowSchema.safeParse(broken).success).toBe(false);
  });
});

describe("unexpectedShapeError", () => {
  it("stays generic and puts the actionable part in details", () => {
    const error = unexpectedShapeError("building");

    expect(error.code).toBe("unknown");
    expect(error.message).not.toContain("shape");
    // The hint can surface in a log or a response; it names what was wrong
    // without naming a column value.
    expect(String(error.details?.hint)).toContain("building");
    expect(isStructureError(error)).toBe(true);
  });
});

describe("structureErrorFromPostgres", () => {
  const postgres = (code: string, message: string, extra = {}) => ({
    code,
    message,
    ...extra,
  });

  it("reads a not-found condition as not_found for both contexts", () => {
    // `assert_society_admin` reports a non-member this way, and
    // `building_soft_delete` uses it for a building that is not in that society.
    const error = structureErrorFromPostgres(
      postgres(SQLSTATE.notFound, "SOCIETY_NOT_FOUND"),
      "write",
    );
    expect(error.code).toBe("not_found");
  });

  it("reads a forbidden condition as forbidden, with the server's hint", () => {
    const error = structureErrorFromPostgres(
      postgres(SQLSTATE.forbidden, "SOCIETY_FORBIDDEN", {
        hint: "Only a society Admin can do this.",
      }),
      "write",
    );

    expect(error.code).toBe("forbidden");
    expect(error.message).toBe("Only a society Admin can do this.");
  });

  it("recognises the soft-delete function's own exception by name", () => {
    const error = structureErrorFromPostgres(
      postgres(SQLSTATE.raised, RAISED_EXCEPTION.buildingNotFound),
      "write",
    );

    expect(error.code).toBe("not_found");
  });

  it("tells a read and a write apart for the same SQLSTATE", () => {
    // 42501 covers both "you are not in this tenant" and "your role is not
    // enough". A read must answer not_found (PRD T041 — no existence leak); a
    // write must answer forbidden, or a Treasurer sees "not found" for their own
    // society's buildings.
    const denial = postgres(SQLSTATE.insufficientPrivilege, "denied");

    expect(structureErrorFromPostgres(denial, "read").code).toBe("not_found");
    expect(structureErrorFromPostgres(denial, "write").code).toBe("forbidden");
  });

  it("reports a missing table grant as an expired session, not a permission problem", () => {
    // The role itself has no grant — nothing is granted to `anon` — so the request
    // arrived without a usable identity and "try signing in again" is the honest
    // instruction.
    const error = structureErrorFromPostgres(
      postgres(
        SQLSTATE.insufficientPrivilege,
        "permission denied for table buildings",
      ),
      "read",
    );

    expect(error.code).toBe("forbidden");
    expect(error.message).toContain("session expired");
  });

  it("turns a duplicate building name into a conflict", () => {
    const error = structureErrorFromPostgres(
      postgres(SQLSTATE.uniqueViolation, "duplicate key value", {
        detail: "Key (society_id, name)=(…, Block A) already exists.",
      }),
      "write",
    );

    expect(error.code).toBe("conflict");
    expect(error.message).toContain("already exists");
  });

  it("turns a check violation into a validation failure naming the field", () => {
    const error = structureErrorFromPostgres(
      postgres(SQLSTATE.checkViolation, "new row violates check constraint", {
        detail: "Failing row contains (…, 0, …).",
        constraint_name: "chk_buildings_total_floors",
      }),
      "write",
    );

    expect(error.code).toBe("validation");
    expect(error.message).toContain("1 and 200");
  });

  it("reads a broken society FK as not_found rather than a server error", () => {
    const error = structureErrorFromPostgres(
      postgres(SQLSTATE.foreignKeyViolation, "insert or update violates FK"),
      "write",
    );

    expect(error.code).toBe("not_found");
  });

  it("names the migration to apply when the table is missing", () => {
    const error = structureErrorFromPostgres(
      postgres(
        SQLSTATE.undefinedTable,
        'relation "public.buildings" does not exist',
      ),
      "read",
    );

    expect(error.code).toBe("unknown");
    // Developer-facing, and deliberately in `details` rather than the message: the
    // message can surface in a response through the error mapper.
    expect(String(error.details?.hint)).toContain("20260924130000");
  });

  it("classifies an RLS message that arrived without a SQLSTATE", () => {
    const denial = postgres(
      "00000",
      'new row violates row-level security policy for table "buildings"',
    );

    expect(structureErrorFromPostgres(denial, "read").code).toBe("not_found");
    expect(structureErrorFromPostgres(denial, "write").code).toBe("forbidden");
  });

  it("falls back to unknown for a failure it cannot place", () => {
    expect(
      structureErrorFromPostgres(new Error("socket closed"), "read").code,
    ).toBe("unknown");
  });

  it("never copies Postgres's detail into a message the UI could render", () => {
    const error = structureErrorFromPostgres(
      postgres(SQLSTATE.checkViolation, "violates check constraint", {
        detail: "Failing row contains (Block A, 12).",
      }),
      "write",
    );

    expect(error.message).not.toContain("Failing row");
  });

  /**
   * The wrapper Drizzle actually throws.
   *
   * `tx.execute()` does not rethrow `postgres.js`'s error — it wraps it in a
   * `DrizzleQueryError` whose own properties are `query`, `params` and `cause`.
   * Every test above builds a driver-shaped error by hand, which is precisely how
   * the classifier could be inert in production while a file like this stayed
   * green. This is the one that would have caught it.
   */
  it("does not hide the driver's SQLSTATE behind `cause`", () => {
    const wrapped = {
      name: "DrizzleQueryError",
      query: "select * from public.buildings",
      params: [],
      cause: {
        code: SQLSTATE.uniqueViolation,
        message: "duplicate key value violates unique constraint",
        detail: "Key (society_id, name)=(…, Block A) already exists.",
      },
    };

    expect(structureErrorFromPostgres(wrapped, "write").code).toBe("conflict");
  });

  it("follows a deeper cause chain rather than pinning one level", () => {
    const twiceWrapped = {
      message: "Failed query: select …",
      cause: {
        message: "wrapped again",
        cause: { code: SQLSTATE.notFound, message: "BUILDING_NOT_FOUND" },
      },
    };

    expect(structureErrorFromPostgres(twiceWrapped, "write").code).toBe(
      "not_found",
    );
  });
});
