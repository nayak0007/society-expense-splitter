import { isExpenseError } from "@ses/domain";

import { SQLSTATE } from "../../../../common/database/postgres-errors";
import {
  categoryErrorFromPostgres,
  categoryFromRow,
  categoryRowSchema,
  RAISED_EXCEPTION,
  unexpectedShapeError,
} from "../category.rows";

/**
 * The database ⇄ domain boundary for the expense module.
 *
 * These are the assertions that make the repository's "validate, never trust" claim
 * true rather than aspirational: each one would fail if the translation silently
 * degraded — a `42501` read reported as 403 (leaking that a foreign society exists), a
 * `NULL` icon becoming `""`, an unknown stored strategy reaching a use case typed as if
 * it were implementable, or the reference check's refusal reading as a generic conflict.
 */

/** A row as Postgres returns it, overridable per test. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    society_id: "22222222-2222-4222-8222-222222222222",
    name: "Maintenance",
    icon: null,
    color: null,
    default_split_strategy: "equal",
    default_apartment_basis: null,
    is_owner_only: false,
    is_capital: false,
    gst_applicable: false,
    is_active: true,
    display_order: 1,
    created_at: "2026-10-01T10:00:00.000Z",
    updated_at: "2026-10-01T10:00:00.000Z",
    deleted_at: null,
    ...overrides,
  };
}

describe("categoryFromRow", () => {
  it("maps snake_case columns onto the entity and brands the ids", () => {
    const category = categoryFromRow(categoryRowSchema.parse(row()));

    expect(category).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      societyId: "22222222-2222-4222-8222-222222222222",
      name: "Maintenance",
      icon: null,
      color: null,
      defaultSplitStrategy: "equal",
      defaultApartmentBasis: null,
      isOwnerOnly: false,
      isCapital: false,
      gstApplicable: false,
      isActive: true,
      displayOrder: 1,
      createdAt: "2026-10-01T10:00:00.000Z",
      updatedAt: "2026-10-01T10:00:00.000Z",
      deletedAt: null,
    });
  });

  it("keeps a nullable icon and colour as null rather than an empty string", () => {
    // `""` and `null` must not be two spellings of "none": the column's own
    // representation is `null`, and a reader that invented `""` would make every
    // consumer handle both.
    const category = categoryFromRow(
      categoryRowSchema.parse(row({ icon: null, color: null })),
    );

    expect(category.icon).toBeNull();
    expect(category.color).toBeNull();
  });

  it("carries the seeded owner-only/capital pair through unchanged", () => {
    const category = categoryFromRow(
      categoryRowSchema.parse(
        row({
          name: "Sinking Fund",
          is_owner_only: true,
          is_capital: true,
          display_order: 17,
        }),
      ),
    );

    expect(category).toMatchObject({
      isOwnerOnly: true,
      isCapital: true,
      displayOrder: 17,
    });
  });

  it("coerces a smallint that arrived as a string", () => {
    expect(
      categoryFromRow(categoryRowSchema.parse(row({ display_order: "19" })))
        .displayOrder,
    ).toBe(19);
  });

  it("normalises all three timestamp serialisations to one shape", () => {
    const asDate = categoryFromRow(
      categoryRowSchema.parse(
        row({ created_at: new Date("2026-10-01T10:00:00Z") }),
      ),
    );
    const asText = categoryFromRow(
      categoryRowSchema.parse(row({ created_at: "2026-10-01 10:00:00+00" })),
    );

    expect(asDate.createdAt).toBe("2026-10-01T10:00:00.000Z");
    expect(asText.createdAt).toBe("2026-10-01T10:00:00.000Z");
  });

  it("refuses a stored strategy the domain does not implement", () => {
    // The `z.enum` is load-bearing: a value added to the database's enum without an
    // arm in the split engine (or before this package is rebuilt) must be reported as
    // a shape error rather than passed on typed as one of the five.
    expect(
      categoryRowSchema.safeParse(row({ default_split_strategy: "weighted" }))
        .success,
    ).toBe(false);
    expect(
      categoryRowSchema.safeParse(row({ default_apartment_basis: "per_wing" }))
        .success,
    ).toBe(false);
  });

  it("rejects a row missing a column it needs, rather than passing undefined on", () => {
    const broken: Record<string, unknown> = row();
    delete broken.name;

    expect(categoryRowSchema.safeParse(broken).success).toBe(false);
  });
});

describe("unexpectedShapeError", () => {
  it("stays generic and puts the actionable part in details", () => {
    const error = unexpectedShapeError("expense category");

    expect(error.code).toBe("unknown");
    expect(error.message).not.toContain("shape");
    // The hint can surface in a log or a response; it names what was wrong without
    // naming a column value.
    expect(String(error.details?.hint)).toContain("expense category");
    expect(isExpenseError(error)).toBe(true);
  });
});

describe("categoryErrorFromPostgres", () => {
  const postgres = (code: string, message: string, extra = {}) => ({
    code,
    message,
    ...extra,
  });

  it("reads a not-found condition as not_found for both contexts", () => {
    // `assert_society_membership` reports a non-member this way, and
    // `expense_category_soft_delete` uses it for a category that is not in that society.
    expect(
      categoryErrorFromPostgres(
        postgres(SQLSTATE.notFound, "SOCIETY_NOT_FOUND"),
        "write",
      ).code,
    ).toBe("not_found");
  });

  it("reads a forbidden condition as forbidden, with the server's hint", () => {
    const error = categoryErrorFromPostgres(
      postgres(SQLSTATE.forbidden, "CATEGORY_FORBIDDEN", {
        hint: "Only a society Admin or Treasurer can change expense categories.",
      }),
      "write",
    );

    expect(error.code).toBe("forbidden");
    expect(error.message).toBe(
      "Only a society Admin or Treasurer can change expense categories.",
    );
  });

  it("recognises the soft-delete function's own exceptions by name", () => {
    expect(
      categoryErrorFromPostgres(
        postgres(SQLSTATE.raised, RAISED_EXCEPTION.categoryNotFound),
        "write",
      ).code,
    ).toBe("not_found");
  });

  it("turns the database's reference refusal into category_has_expenses", () => {
    // The database's half of the rule `deleteExpenseCategory` states in the
    // application layer. Reaching it means the two disagreed, and the answer is still
    // the typed refusal rather than a 500 — or, worse, a generic conflict a client
    // could not tell from a duplicate name.
    const error = categoryErrorFromPostgres(
      postgres(SQLSTATE.raised, RAISED_EXCEPTION.categoryHasExpenses),
      "write",
    );

    expect(error.code).toBe("category_has_expenses");
    expect(error.message).toContain("Deactivate it instead");
  });

  it("tells a read and a write apart for the same SQLSTATE", () => {
    // 42501 covers both "you are not in this tenant" and "your role is not enough". A
    // read must answer not_found (PRD T041 — no existence leak); a write must answer
    // forbidden, or a Treasurer sees "not found" for their own society's categories.
    const denial = postgres(SQLSTATE.insufficientPrivilege, "denied");

    expect(categoryErrorFromPostgres(denial, "read").code).toBe("not_found");
    expect(categoryErrorFromPostgres(denial, "write").code).toBe("forbidden");
  });

  it("reports a missing table grant as an expired session, not a permission problem", () => {
    const error = categoryErrorFromPostgres(
      postgres(
        SQLSTATE.insufficientPrivilege,
        "permission denied for table expense_categories",
      ),
      "read",
    );

    expect(error.code).toBe("forbidden");
    expect(error.message).toContain("session expired");
  });

  it("turns a duplicate category name into a conflict that names the field", () => {
    const error = categoryErrorFromPostgres(
      postgres(SQLSTATE.uniqueViolation, "duplicate key value", {
        constraint_name: "uq_expense_categories_society_name",
        detail: "Key (society_id, name)=(…, Maintenance) already exists.",
      }),
      "write",
    );

    expect(error.code).toBe("conflict");
    expect(error.message).toContain("already exists");
    // Names the input, so a form highlights the right box instead of showing a banner.
    expect(error.details?.field).toBe("name");
  });

  it("turns a display-order check violation into a validation failure", () => {
    const error = categoryErrorFromPostgres(
      postgres(SQLSTATE.checkViolation, "new row violates check constraint", {
        constraint_name: "chk_expense_categories_display_order",
      }),
      "write",
    );

    expect(error.code).toBe("validation");
    expect(error.message).toContain("Display order");
  });

  it("reads a broken society FK as not_found rather than a server error", () => {
    expect(
      categoryErrorFromPostgres(
        postgres(SQLSTATE.foreignKeyViolation, "insert or update violates FK"),
        "write",
      ).code,
    ).toBe("not_found");
  });

  it("names the migration to apply when the table is missing", () => {
    const error = categoryErrorFromPostgres(
      postgres(
        SQLSTATE.undefinedTable,
        'relation "public.expense_categories" does not exist',
      ),
      "read",
    );

    expect(error.code).toBe("unknown");
    // Developer-facing, and deliberately in `details` rather than the message: the
    // message can surface in a response through the error mapper.
    expect(String(error.details?.hint)).toContain("20261001120000");
  });

  it("classifies an RLS message that arrived without a SQLSTATE", () => {
    const denial = postgres(
      "00000",
      'new row violates row-level security policy for table "expense_categories"',
    );

    expect(categoryErrorFromPostgres(denial, "read").code).toBe("not_found");
    expect(categoryErrorFromPostgres(denial, "write").code).toBe("forbidden");
  });

  it("falls back to unknown for a failure it cannot place", () => {
    expect(
      categoryErrorFromPostgres(new Error("socket closed"), "read").code,
    ).toBe("unknown");
  });

  it("never copies Postgres's detail into a message the UI could render", () => {
    const error = categoryErrorFromPostgres(
      postgres(SQLSTATE.checkViolation, "violates check constraint", {
        detail: "Failing row contains (Maintenance, -1).",
      }),
      "write",
    );

    expect(error.message).not.toContain("Failing row");
  });

  /**
   * The wrapper Drizzle actually throws.
   *
   * `tx.execute()` does not rethrow `postgres.js`'s error — it wraps it in a
   * `DrizzleQueryError` whose own properties are `query`, `params` and `cause`. Every
   * test above builds a driver-shaped error by hand, which is precisely how the
   * classifier could be inert in production while a file like this stayed green.
   */
  it("does not hide the driver's SQLSTATE behind `cause`", () => {
    const wrapped = {
      name: "DrizzleQueryError",
      query: "select * from public.expense_categories",
      params: [],
      cause: {
        code: SQLSTATE.uniqueViolation,
        message: "duplicate key value violates unique constraint",
        constraint_name: "uq_expense_categories_society_name",
      },
    };

    expect(categoryErrorFromPostgres(wrapped, "write").code).toBe("conflict");
  });

  it("follows a deeper cause chain rather than pinning one level", () => {
    const twiceWrapped = {
      message: "Failed query: select …",
      cause: {
        message: "wrapped again",
        cause: {
          code: SQLSTATE.raised,
          message: RAISED_EXCEPTION.categoryHasExpenses,
        },
      },
    };

    expect(categoryErrorFromPostgres(twiceWrapped, "write").code).toBe(
      "category_has_expenses",
    );
  });
});
