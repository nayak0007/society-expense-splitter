import { bigint, integer, timestamp, uuid } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * The standard column set from SAD §8.1, applied to every table.
 *
 * WHY SOME OF THESE ARE FACTORIES RATHER THAN CONSTANTS: the SAD writes
 * `auditColumns`, `softDeleteColumns` and `tenantColumn` as plain objects that
 * close over `members.id` and `societies.id`. Those tables do not exist yet —
 * they arrive in T017 — so the literal form would be a forward import to a table
 * that is not defined, which Drizzle evaluates eagerly at module load and would
 * crash. Taking the referenced column as an argument keeps the helper usable the
 * moment the tables exist, without inventing a placeholder table that later has
 * to be deleted.
 *
 * The `updated_at` trigger these columns depend on already exists:
 * `public.touch_updated_at()` was created by
 * `supabase/migrations/20260920120000_auth_profiles.sql`. Drizzle must not
 * create it again — two definitions of the same trigger function is how a
 * version bump silently stops happening on half the tables.
 */

/** `created_at` / `updated_at` / `version` — SAD §8.1. */
export const auditColumns = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  /** Optimistic locking (SAD §7.10 `VERSION_MISMATCH`). Bumped by the trigger. */
  version: integer("version").notNull().default(1),
};

/**
 * `created_by` / `updated_by` — SAD §8.1. Pass the `members.id` column:
 * `{ ...auditActorColumns(members.id) }`.
 */
export function auditActorColumns(membersId: AnyPgColumn) {
  return {
    createdBy: uuid("created_by").references(() => membersId),
    updatedBy: uuid("updated_by").references(() => membersId),
  };
}

/** `deleted_at` / `deleted_by` — the soft-delete tier of SAD §8.1. */
export function softDeleteColumns(membersId?: AnyPgColumn) {
  const columns = {
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  };
  return membersId === undefined
    ? columns
    : { ...columns, deletedBy: uuid("deleted_by").references(() => membersId) };
}

/**
 * `society_id` — the tenant column (SAD §2.3 row-level tenancy, §8.1).
 *
 * Every tenant table carries it, every tenant index starts with it, and every
 * RLS policy filters on it. `onDelete: 'cascade'` matches the SAD: deleting a
 * society removes its data rather than orphan it.
 */
export function tenantColumn(societiesId: AnyPgColumn) {
  return {
    societyId: uuid("society_id")
      .notNull()
      .references(() => societiesId, { onDelete: "cascade" }),
  };
}

/**
 * A money column — always `bigint` paise, never numeric or float (ADR-0005,
 * SAD §18.1: every money field is suffixed `Paise`/`_paise`, no exceptions).
 *
 * `mode: 'bigint'` is deliberate: it keeps the value as `bigint` in TypeScript
 * rather than a JS `number`, so a value above 2^53 cannot silently lose
 * precision on the way to the domain's `Money` type.
 */
export function paiseColumn(name: string) {
  return bigint(name, { mode: "bigint" }).notNull();
}

/** Nullable paise, for columns that legitimately have no amount yet. */
export function optionalPaiseColumn(name: string) {
  return bigint(name, { mode: "bigint" });
}
