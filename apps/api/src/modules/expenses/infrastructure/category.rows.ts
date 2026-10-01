import {
  APARTMENT_BASES,
  SPLIT_STRATEGIES,
  ExpenseError,
  asExpenseCategoryId,
  asSocietyId,
} from "@ses/domain";
import type { ExpenseCategory } from "@ses/domain";
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
 * The database ⇄ domain boundary for the expense module.
 *
 * Every nullability difference and SQLSTATE the API can receive is decided here, once,
 * rather than across five repository methods. Rows are **validated, not trusted**: a
 * column rename or a new `NOT NULL` must fail loudly here rather than reach a use case
 * as `undefined`.
 *
 * The timestamp schemas and the driver-error unwrapping are imported from
 * `common/database/` rather than copied from the structure module — see those files
 * for why, in particular that the unwrapping is a bug fix the API paid for once.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `coerce` on `smallint` because those columns can arrive as strings, and `z.enum` on
 * the two `public.*` enum columns because their values are a closed vocabulary the
 * domain already owns.
 *
 * The `z.enum` is load-bearing rather than decorative: a stored strategy this build
 * does not know means the database has a value the split engine cannot implement (or a
 * migration added one and this package has not been rebuilt), and both are bugs the
 * row boundary should report as a shape error rather than pass to a use case typed as
 * if it were one of the five.
 */
export const categoryRowSchema = z.object({
  id: z.string(),
  society_id: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  color: z.string().nullable(),
  default_split_strategy: z.enum(SPLIT_STRATEGIES),
  default_apartment_basis: z.enum(APARTMENT_BASES).nullable(),
  is_owner_only: z.boolean(),
  is_capital: z.boolean(),
  gst_applicable: z.boolean(),
  is_active: z.boolean(),
  display_order: z.coerce.number().int(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  deleted_at: nullableTimestampSchema,
});
export type CategoryRow = z.infer<typeof categoryRowSchema>;

export const categoryRowListSchema = z.array(categoryRowSchema);

/**
 * One row → the domain entity.
 *
 * The `society_id` and the timestamps are taken from the row rather than from the
 * arguments that produced the query: the row is the authority, and echoing back what
 * the caller asked for would let a bug in the `WHERE` clause go unnoticed.
 */
export function categoryFromRow(row: CategoryRow): ExpenseCategory {
  return {
    id: asExpenseCategoryId(row.id),
    societyId: asSocietyId(row.society_id),
    name: row.name,
    icon: row.icon,
    color: row.color,
    defaultSplitStrategy: row.default_split_strategy,
    defaultApartmentBasis: row.default_apartment_basis,
    isOwnerOnly: row.is_owner_only,
    isCapital: row.is_capital,
    gstApplicable: row.gst_applicable,
    isActive: row.is_active,
    displayOrder: row.display_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export function categoriesFromRows(
  rows: readonly CategoryRow[],
): readonly ExpenseCategory[] {
  return rows.map((row) => categoryFromRow(row));
}

/** A `count(*)::int` result — its own schema because it is not a category row. */
export const categoryReferenceCountRowSchema = z.object({
  reference_count: z.coerce.number().int(),
});

/**
 * A row that did not match its schema. Always a bug on one side of the boundary (a
 * renamed column, a new nullable field), never something the user did — so the copy
 * stays generic and the actionable part is a hint for the operator.
 */
export function unexpectedShapeError(what: string): ExpenseError {
  return new ExpenseError(
    "unknown",
    "Something went wrong. Please try again.",
    { hint: `Unexpected ${what} shape returned by the database.` },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The named exceptions `expense_category_soft_delete()` and T060's checks raise.
 *
 * The not-found one travels as `P0002` rather than `P0001`, so its code alone
 * classifies it — unlike the module's other `P0001` refusals, which have to be matched
 * by name (the split-conservation trigger raises `P0001/SPLIT_MISMATCH` on the same
 * code). This is a table rather than an inline check for that reason: two `P0001`
 * exceptions with two different meanings arrive on one code.
 */
export const RAISED_EXCEPTION = {
  categoryNotFound: "CATEGORY_NOT_FOUND",
  /** Raised when an expense still references the category being removed. */
  categoryHasExpenses: "CATEGORY_HAS_EXPENSES",
} as const;

/**
 * Postgres failure → the module's error vocabulary.
 *
 * `context` matters for exactly one case, and it is the same one the society and
 * structure modules document: `42501` covers both "your role has no grant on this
 * table" and "RLS refused this row". On a **read** that must be `not_found` (PRD T041:
 * a non-member cannot tell a foreign society from a non-existent one). On a **write**
 * the caller has already passed `SocietyGuard`, so they are an active member and the
 * only thing RLS can be refusing is their *role* — `forbidden`, which is a message the
 * user can act on, rather than a 404 for a society they can plainly see.
 *
 * What this deliberately does NOT copy is Postgres's `detail`: it can carry column
 * values, and these objects travel toward the UI.
 */
export function categoryErrorFromPostgres(
  error: unknown,
  context: "read" | "write",
): ExpenseError {
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
      // `assert_society_membership`'s P0002 and `expense_category_soft_delete`'s own
      // P0002 are one answer to the caller: there is nothing here for you.
      return new ExpenseError(
        "not_found",
        "That category is not available to you.",
        withHint(),
      );

    case SQLSTATE.forbidden:
      return new ExpenseError(
        "forbidden",
        hint ??
          "Only a society Admin or Treasurer can change expense categories.",
        withHint(),
      );

    case SQLSTATE.raised:
      if (message.includes(RAISED_EXCEPTION.categoryHasExpenses)) {
        // The database's half of the rule `deleteExpenseCategory` states in the
        // application layer: a category an expense references is not removable.
        // Reaching this at all means the two disagreed — the use case counted zero
        // and the statement found one — and the answer is still the typed refusal
        // rather than a 500, because the rule is the same rule.
        return new ExpenseError(
          "category_has_expenses",
          "An expense uses this category. Deactivate it instead of deleting it.",
          withHint(),
        );
      }
      return message.includes(RAISED_EXCEPTION.categoryNotFound)
        ? new ExpenseError(
            "not_found",
            "That category is not available to you.",
            withHint(),
          )
        : new ExpenseError(
            "unknown",
            "Something went wrong. Please try again.",
            withHint(),
          );

    case SQLSTATE.insufficientPrivilege:
      if (/permission denied for table/i.test(message)) {
        // The role itself has no grant, which for this app means the request arrived
        // without a usable identity: nothing is granted to `anon`.
        return new ExpenseError(
          "forbidden",
          "Your session expired. Please sign in again.",
          withHint(),
        );
      }
      return context === "read"
        ? new ExpenseError(
            "not_found",
            "That category is not available to you.",
            withHint(),
          )
        : new ExpenseError(
            "forbidden",
            "Only a society Admin or Treasurer can change expense categories.",
            withHint(),
          );

    case SQLSTATE.uniqueViolation:
      // `uq_expense_categories_society_name`, over live rows of one society. The
      // same code the use case's own pre-check produces, so a duplicate that raced
      // past that check answers identically.
      if (/name|uq_expense_categories/i.test(haystack)) {
        return new ExpenseError(
          "conflict",
          "A category with that name already exists in this society.",
          { ...withHint(), field: "name" },
        );
      }
      return new ExpenseError(
        "conflict",
        "That change conflicts with an existing record.",
        withHint(),
      );

    case SQLSTATE.checkViolation:
      return new ExpenseError(
        "validation",
        checkViolationMessage(haystack),
        withHint(),
      );

    case SQLSTATE.foreignKeyViolation:
      // The only FKs a category has are its society and its audit members, so this is
      // a society that was removed between the guard's read and this write.
      return new ExpenseError(
        "not_found",
        "That society is not available to you.",
        withHint(),
      );

    case SQLSTATE.undefinedTable:
      return new ExpenseError(
        "unknown",
        "This part of the app is not available yet. Please try again later.",
        {
          ...withHint(),
          hint: "The expense_categories table is missing. Apply supabase/migrations/20261001120000_expense_schema.sql.",
        },
      );

    default:
      break;
  }

  if (/row-level security|permission denied/i.test(message)) {
    return context === "read"
      ? new ExpenseError(
          "not_found",
          "That category is not available to you.",
          withHint(),
        )
      : new ExpenseError(
          "forbidden",
          "Only a society Admin or Treasurer can change expense categories.",
          withHint(),
        );
  }

  return new ExpenseError(
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
  if (/display_order/i.test(haystack)) {
    return "Display order cannot be negative.";
  }
  return "Please check the details and try again.";
}
