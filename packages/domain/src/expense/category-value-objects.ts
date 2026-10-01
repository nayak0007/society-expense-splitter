import { err, ok, type Result } from "../shared/result";
import type { ApartmentBasis, SplitStrategy } from "../shared/split-vocabulary";

import { expenseError, type ExpenseError } from "./errors";
import {
  CATEGORY_COLOR_MAX_LENGTH,
  CATEGORY_DISPLAY_ORDER_MAX,
  CATEGORY_DISPLAY_ORDER_MIN,
  CATEGORY_ICON_MAX_LENGTH,
  CATEGORY_NAME_MAX_LENGTH,
  DEFAULT_CATEGORY_DISPLAY_ORDER,
} from "./expense-category";

/**
 * Expense-category value objects — the *invariants* of a category, in one place.
 *
 * Everything here is a total function of its arguments: no I/O, no clock, no
 * framework. Each returns a `Result`, never throws, so a use case hands the failure
 * back with the offending field named (`details.field`), which is what becomes a
 * form error at the edge. The rules mirror
 * `supabase/migrations/20261001120000_expense_schema.sql`: the column widths, the
 * `display_order >= 0` check, and the two columns with no constraint at all — the
 * icon and the colour — which are the only two this file bounds on its own
 * authority.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Name
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum is 1: `Lift`, `Bank Charges` and a single word in any script are all names. */
export const CATEGORY_NAME_MIN_LENGTH = 1;

/**
 * Normalises and validates a category name.
 *
 * ## Whitespace is collapsed because the uniqueness rule is exact-string
 *
 * The partial unique index `uq_expense_categories_society_name` compares the stored
 * text, so `"Water"` and `"Water "` are two different names to the database and one
 * name to a human reading a picker. Collapsing runs of whitespace *before* the value
 * reaches the database is what keeps the index's rule and the reader's rule from
 * being two different rules — the only place this module tightens the column's own
 * comparison.
 *
 * ## What it deliberately does not do
 *
 * It does not lower-case, does not strip punctuation and does not require letters.
 * Any of those would be a stricter rule than the index behind it, and a rule the
 * database does not share is one a concurrent request can slip past — see
 * `create-category.ts` on why the uniqueness check is the index's and not this
 * file's. It does reject control characters, which mean pasted junk rather than a
 * name and are invisible in the picker that would render them.
 */
export function createCategoryName(raw: string): Result<string, ExpenseError> {
  const value = raw.trim().replace(/\s+/g, " ");

  if (value.length < CATEGORY_NAME_MIN_LENGTH) {
    return err(
      expenseError("validation", "Enter a category name.", { field: "name" }),
    );
  }
  if (value.length > CATEGORY_NAME_MAX_LENGTH) {
    return err(
      expenseError(
        "validation",
        `Category name must be at most ${CATEGORY_NAME_MAX_LENGTH} characters.`,
        { field: "name" },
      ),
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return err(
      expenseError(
        "validation",
        "Category name contains characters that are not allowed.",
        { field: "name" },
      ),
    );
  }

  return ok(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Icon
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalises the optional icon.
 *
 * Free-form by design: the column is `varchar(40)`, which fits an emoji sequence or
 * a short identifier, and the PRD names `icon` as a field a category "carries"
 * without saying what vocabulary it comes from. Refusing anything but one of them
 * would be this layer picking the client's icon set, so only two things are
 * rejected — more than the column holds, and control characters.
 *
 * An empty or whitespace-only string becomes `null` rather than `""`: the two mean
 * the same thing ("no icon"), and the column's own representation of "none" is
 * `null`, so storing `""` would be a second spelling of it that every reader would
 * then have to know about.
 */
export function createCategoryIcon(
  raw: string | null | undefined,
): Result<string | null, ExpenseError> {
  if (raw === null || raw === undefined) return ok(null);

  const value = raw.trim();
  if (value.length === 0) return ok(null);

  if (value.length > CATEGORY_ICON_MAX_LENGTH) {
    return err(
      expenseError(
        "validation",
        `Icon must be at most ${CATEGORY_ICON_MAX_LENGTH} characters.`,
        { field: "icon" },
      ),
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return err(
      expenseError(
        "validation",
        "Icon contains characters that are not allowed.",
        {
          field: "icon",
        },
      ),
    );
  }

  return ok(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Colour
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `#RRGGBB` or `#RRGGBBAA` — the form the column's width implies.
 *
 * ## Why this one is validated when the icon is not
 *
 * `varchar(9)` is exactly the length of `#RRGGBBAA`. A column sized to the hex
 * literal and nothing else is a statement about what belongs in it, so accepting
 * `"red"` would store a value the width was chosen to exclude. (The PRD is silent
 * on the format; the width is the only authority there is, and `db-schema`'s own
 * comment on the column reads it the same way.)
 *
 * ## Why it is lower-cased
 *
 * `#AABBCC` and `#aabbcc` are one colour, and a palette that stores both is a
 * palette with two entries a user cannot tell apart. Hex is case-insensitive
 * everywhere it is interpreted, so normalising it loses nothing — unlike a
 * category *name*, where the case is part of the text a person chose and the value
 * object leaves it alone.
 *
 * The note this narrowing deserves: the database does not check the format, so a
 * colour written by a script that skips this value object would be stored as typed.
 * The reads are unaffected (a client parses what it is given), which is why this is
 * a validation rule rather than a migration.
 */
export const CATEGORY_COLOR_PATTERN = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

export function createCategoryColor(
  raw: string | null | undefined,
): Result<string | null, ExpenseError> {
  if (raw === null || raw === undefined) return ok(null);

  const value = raw.trim();
  if (value.length === 0) return ok(null);

  if (!CATEGORY_COLOR_PATTERN.test(value)) {
    return err(
      expenseError(
        "validation",
        `Colour must be a hex value like #4F46E5 or #4F46E5FF, at most ${CATEGORY_COLOR_MAX_LENGTH} characters.`,
        { field: "color" },
      ),
    );
  }

  return ok(value.toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Split defaults
// ─────────────────────────────────────────────────────────────────────────────

/** `default_split_strategy`'s column default, and the PRD's most common strategy. */
export const DEFAULT_CATEGORY_SPLIT_STRATEGY: SplitStrategy = "equal";

/**
 * The basis a category's default actually applies.
 *
 * ## The two columns are not independent, and this is where that is decided
 *
 * `default_apartment_basis` describes *how* the `apartment` strategy weights a flat
 * — carpet area, BHK, floor band, and so on (`@ses/domain`'s
 * `shared/split-vocabulary.ts`). It is meaningless for the other four strategies:
 * an `equal` split weights every participant by `1` and never reads a basis, so a
 * row carrying `strategy = 'equal'` beside `basis = 'per_sqft_carpet'` is a
 * contradiction a reader has to resolve and a screen has to explain.
 *
 * The rule is therefore a **normalisation rather than a refusal**: a basis supplied
 * for a non-apartment strategy is dropped, not rejected. Refusing it would fail a
 * request that is doing the obvious thing — a form that posts the whole category
 * object on every save sends the basis even when the strategy is `equal` — and
 * dropping it is what makes the stored pair coherent whichever order the two fields
 * arrive in.
 *
 * `null` for an `apartment` strategy is legal and is not the same as the basis
 * being wrong: it means the society has not chosen which attribute to weight by
 * yet, and the expense form (T063) asks for it. A default is allowed to be
 * incomplete in a way an expense is not.
 */
export function resolveCategoryApartmentBasis(
  strategy: SplitStrategy,
  basis: ApartmentBasis | null,
): ApartmentBasis | null {
  return strategy === "apartment" ? basis : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Display order
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the manual sort key.
 *
 * Absent means the column's default, resolved here rather than left to the database
 * for the reason `createDisplayOrder` records: the use case's result should be the
 * same whether it wrote to Postgres or to a fake, and a test that asserts the order
 * of the nineteen plus one new category must not depend on which adapter ran.
 *
 * `null` is accepted as the same thing as absent, so a JSON body that spells "no
 * value" explicitly is not a different case from one that omits the key.
 */
export function createCategoryDisplayOrder(
  value: number | null | undefined,
): Result<number, ExpenseError> {
  if (value === undefined || value === null) {
    return ok(DEFAULT_CATEGORY_DISPLAY_ORDER);
  }

  if (
    !Number.isInteger(value) ||
    value < CATEGORY_DISPLAY_ORDER_MIN ||
    value > CATEGORY_DISPLAY_ORDER_MAX
  ) {
    return err(
      expenseError(
        "validation",
        `Display order must be a whole number between ${CATEGORY_DISPLAY_ORDER_MIN} and ${CATEGORY_DISPLAY_ORDER_MAX}.`,
        { field: "displayOrder" },
      ),
    );
  }
  return ok(value);
}
