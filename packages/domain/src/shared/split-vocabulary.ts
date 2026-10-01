/**
 * The split vocabulary — how an expense is divided, and what an `apartment` split
 * is weighted by (PRD §7.1, §3.5.4).
 *
 * ## Why these two lists live here rather than in `@ses/split-engine`
 *
 * They describe *stored state*, not an implementation. `split_strategy` and
 * `apartment_basis` are Postgres enums
 * (`supabase/migrations/20260920130000_society_core.sql`), mirrored in
 * `@ses/db-schema`, and `expense_categories` carries a column of each — so the
 * domain is the only layer that can describe its own table. `@ses/split-engine` is
 * the sole *implementation* of these five arms, not their definition.
 *
 * The move (Roadmap T062) is what lets one definitions serve three consumers
 * without a second spelling. `@ses/contracts` validates a category's strategy with
 * `z.enum(SPLIT_STRATEGIES)` the way it validates a member's status with
 * `z.enum(MEMBER_STATUSES)`, and `@ses/application` reads the same list. Neither
 * may import the engine: contracts is loaded by the mobile bundle and the generated
 * client, and the engine sits *beside* the domain rather than beneath it. The
 * engine re-exports both names, so `grep SPLIT_STRATEGIES` still finds one
 * definition and every existing import keeps working.
 *
 * ## The strategy union grows as implementations land
 *
 * Listing a strategy before it exists would be the tempting mistake: a caller could
 * pass it, type-check, and reach `planSplit`'s exhaustive `switch` — which has one
 * arm per value and no `default` — at runtime. Adding a value here without an arm
 * there is therefore a compile error, which is the property that keeps this list
 * honest.
 */
export const SPLIT_STRATEGIES = [
  "equal",
  "percentage",
  "shares",
  "apartment",
  "custom",
] as const;

export type SplitStrategy = (typeof SPLIT_STRATEGIES)[number];

/**
 * The apartment attributes a split can be weighted by (PRD §3.5.4).
 *
 * These six are the database's own — `apartment_basis` is exactly
 * `('per_flat', 'per_sqft_carpet', 'per_sqft_builtup', 'per_bhk',
 * 'per_floor_band', 'per_parking_slot')` — and the spelling matches it so a stored
 * value maps onto a basis without a translation table.
 *
 * ## What is deliberately *not* a basis
 *
 * PRD §3.5.4's bullet list also names `occupied_only`, and it is absent on purpose.
 * It is not in the `apartment_basis` enum, so no expense could ever store it; its
 * own gloss is "skip vacant flats", which is a question about *who participates*
 * rather than about how a participating flat is weighted; and T063's participant
 * resolver owns exactly that question (its selector has `occupancy`,
 * `includeVacant` and `bill_vacant_flats`). Making it a basis would move a
 * resolution decision into the engine.
 *
 * ## Why it is nullable on a category but not here
 *
 * A category's `default_apartment_basis` is NULL unless its strategy is
 * `apartment` — the column is nullable and the engine refuses to weight by a basis
 * when the strategy is not `apartment`. That nullability lives on the entity
 * (`ExpenseCategory.defaultApartmentBasis`), not in this list: "no basis applies"
 * is a fact about one category, not a sixth basis.
 */
export const APARTMENT_BASES = [
  "per_flat",
  "per_sqft_carpet",
  "per_sqft_builtup",
  "per_bhk",
  "per_floor_band",
  "per_parking_slot",
] as const;

export type ApartmentBasis = (typeof APARTMENT_BASES)[number];

/** Runtime membership test for a strategy, for callers holding an untrusted string. */
export function isSplitStrategy(value: string): value is SplitStrategy {
  return (SPLIT_STRATEGIES as readonly string[]).includes(value);
}

/** Runtime membership test for an apartment basis. */
export function isApartmentBasis(value: string): value is ApartmentBasis {
  return (APARTMENT_BASES as readonly string[]).includes(value);
}
