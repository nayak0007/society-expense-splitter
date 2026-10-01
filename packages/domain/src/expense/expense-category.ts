import type { ExpenseCategoryId, SocietyId } from "../shared/ids";
import type { ApartmentBasis, SplitStrategy } from "../shared/split-vocabulary";

/**
 * ExpenseCategory entity (PRD §7.3, §3.5.3; Roadmap T062).
 *
 * A society's expense vocabulary: one row per thing the society spends money on.
 * Every society is seeded with nineteen of them by `seed_society()`
 * (`supabase/migrations/20261001120000_expense_schema.sql`), and the PRD's
 * §Categories section settles the question T062 had to answer before writing a
 * line of code:
 *
 * > "Seeded per society, **editable**: [the nineteen]. Each category carries:
 * > `icon`, `color`, `default_split_strategy`, `is_owner_only` (excluded from
 * > tenants), `is_capital` (excluded from operating-expense trend charts),
 * > `gst_applicable`."
 *
 * ## There is no "default vs custom" distinction, and that is the PRD's answer
 *
 * The prompt that produced this task asked how T062 distinguishes a seeded
 * category from a society-created one, and whether the seeded ones may be renamed,
 * flagged, deactivated or deleted. The schema refuses to make the distinction
 * possible — there is no `is_system`, no `seed_key`, no `society_id IS NULL` for
 * the shared rows — and the PRD calls all nineteen editable while stating no
 * "seeded categories cannot be deleted" rule anywhere. So the only thing that
 * blocks a deletion is the rule the Roadmap *does* state, and it is about
 * **references**, not about provenance: a category any expense has ever used
 * cannot be removed, and deactivation (`isActive: false`) is offered instead.
 *
 * The consequence worth stating plainly: a society may rename `Maintenance` to
 * `Repairs & Maintenance`, may turn off `gstApplicable` on it, and may delete it
 * outright if nothing references it. That is what "editable" means, and encoding
 * a provenance rule the documents do not state would be this layer inventing
 * product behaviour — the same mistake as guessing an icon for the nineteen.
 *
 * ## Why the field list stops where it does
 *
 * `created_by`, `updated_by`, `deleted_at`, `deleted_by` and `version` are columns
 * the table has and this interface does not, for the reason `Building` records:
 * `deleted_at` is the read path's filter rather than a field a screen renders (an
 * entity in hand is live by construction), the audit ids are not selected by any
 * read, and `version` is bumped by the `set_expense_categories_updated_at` trigger
 * rather than by a caller. A field here would be a field with no route behind it.
 */
export interface ExpenseCategory {
  readonly id: ExpenseCategoryId;
  readonly societyId: SocietyId;
  readonly name: string;
  /** A name or an emoji the client renders; `null` = the society chose none. */
  readonly icon: string | null;
  /** `#RRGGBB` or `#RRGGBBAA`, lower-cased. `null` = the society chose none. */
  readonly color: string | null;
  /** What a new expense in this category starts as (PRD §3.5). */
  readonly defaultSplitStrategy: SplitStrategy;
  /**
   * The basis the `apartment` strategy weights by; `null` when it applies to no
   * strategy, which is every strategy but `apartment`.
   */
  readonly defaultApartmentBasis: ApartmentBasis | null;
  /** Excluded from tenant splits and routed to the flat's owner (PRD §2.2). */
  readonly isOwnerOnly: boolean;
  /** Excluded from operating-expense trend charts (PRD §3.5.3). */
  readonly isCapital: boolean;
  /** Whether GST details are collected for an expense in this category. */
  readonly gstApplicable: boolean;
  /**
   * `false` = deactivated: still readable and still named by historical expenses,
   * but not offered for a *new* expense. This is the documented alternative to
   * deleting a referenced category (T062's acceptance, SAD §8.1's soft-delete tier).
   */
  readonly isActive: boolean;
  /** Lower sorts first; ties broken by name. Seeded 1..19 in PRD list order. */
  readonly displayOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}

/**
 * Length bounds, exported so the SQL `varchar`, the wire contract and the value
 * object cannot disagree about where a limit is — the same reason
 * `BUILDING_NAME_MAX_LENGTH` is exported rather than written out twice.
 */

/** `varchar(80)` in the PRD's DDL and in T060's table. */
export const CATEGORY_NAME_MAX_LENGTH = 80;

/** `varchar(40)` — sized for an emoji sequence or a short icon name. */
export const CATEGORY_ICON_MAX_LENGTH = 40;

/**
 * `varchar(9)` — exactly `#RRGGBBAA`. The width is the format's, not a choice made
 * here: a `#RRGGBB` needs 7 and a `#RRGGBBAA` needs 9, and a column that fits the
 * longer one and nothing else is a statement about what belongs in it.
 */
export const CATEGORY_COLOR_MAX_LENGTH = 9;

/** `chk_expense_categories_display_order CHECK (display_order >= 0)`. */
export const CATEGORY_DISPLAY_ORDER_MIN = 0;

/**
 * A whole number well inside the `smallint` column, and deliberately not 32767.
 *
 * The database's own check is `>= 0` only, so this upper bound is an
 * **application-side narrowing** rather than a restatement of a constraint — the
 * same choice `DISPLAY_ORDER_MAX` makes for buildings. It exists because display
 * order is a manual sort key with a handful of distinct values, so `9999` is a
 * typo rather than an intention, and a bound is what turns it into a field error
 * instead of a number the picker then sorts by forever.
 */
export const CATEGORY_DISPLAY_ORDER_MAX = 999;

/** The column's own default, resolved here so a result does not depend on the adapter. */
export const DEFAULT_CATEGORY_DISPLAY_ORDER = 0;

/**
 * Create payload — what the form collected, nothing derived.
 *
 * Every field but `name` is optional, and absent means the column's default rather
 * than a second spelling of it: `defaultSplitStrategy` defaults to `equal`,
 * `defaultApartmentBasis` to NULL, the three flags to `false`, `isActive` to
 * `true` and `displayOrder` to `0`. `isActive` is settable on a create because the
 * column is granted for `INSERT` and refusing it would be a rule with no source —
 * a society migrating its vocabulary in is the case that needs it.
 */
export interface CreateExpenseCategoryInput {
  readonly name: string;
  readonly icon?: string | null | undefined;
  readonly color?: string | null | undefined;
  readonly defaultSplitStrategy?: SplitStrategy | undefined;
  readonly defaultApartmentBasis?: ApartmentBasis | null | undefined;
  readonly isOwnerOnly?: boolean | undefined;
  readonly isCapital?: boolean | undefined;
  readonly gstApplicable?: boolean | undefined;
  readonly isActive?: boolean | undefined;
  readonly displayOrder?: number | undefined;
}

/**
 * Partial update: every field optional, an empty patch rejected by the use case.
 *
 * ## Why `icon`, `color` and `defaultApartmentBasis` accept `null` and the rest do not
 *
 * The three nullable columns are the three a society genuinely needs to *clear*:
 * remove an icon, drop a colour, or stop weighting by an apartment attribute. The
 * distinction is the one `UpdateApartmentInput` draws — `undefined` is "leave
 * unchanged", `null` is "set to nothing" — and it is expressible only because the
 * repository builds its assignment list field by field rather than through
 * `coalesce`. A patch that spelled "clear" as `undefined` would be
 * indistinguishable from one that omitted the key, so the two would be one
 * behaviour, and it would be the wrong one for half the callers.
 *
 * The non-nullable fields take no `null`: `name` has no empty state, a strategy is
 * one of five values, and the three flags and `isActive`/`displayOrder` are
 * `NOT NULL`. Allowing `null` there would put a value in the type that the
 * database would reject.
 */
export interface UpdateExpenseCategoryInput {
  readonly name?: string | undefined;
  readonly icon?: string | null | undefined;
  readonly color?: string | null | undefined;
  readonly defaultSplitStrategy?: SplitStrategy | undefined;
  readonly defaultApartmentBasis?: ApartmentBasis | null | undefined;
  readonly isOwnerOnly?: boolean | undefined;
  readonly isCapital?: boolean | undefined;
  readonly gstApplicable?: boolean | undefined;
  readonly isActive?: boolean | undefined;
  readonly displayOrder?: number | undefined;
}

/**
 * Sort order every read path uses: manual order first, then name.
 *
 * The same two keys the query orders by (`order by display_order asc, name asc`) — the
 * shape `compareBuildings` has, and for the same reason: a client that re-sorts a list
 * after an edit has to land where the server would, or a renamed category jumps
 * position a moment later.
 *
 * `localeCompare` rather than the byte comparison `compareApartments` uses: a flat
 * number is an identifier a society compares character by character (`"10"` before
 * `"2"`), while a category name is a word a person reads. Ordering words the way the
 * reader's language orders them is the point.
 */
export function compareExpenseCategories(
  left: ExpenseCategory,
  right: ExpenseCategory,
): number {
  if (left.displayOrder !== right.displayOrder) {
    return left.displayOrder - right.displayOrder;
  }
  return left.name.localeCompare(right.name);
}
