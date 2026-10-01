/**
 * `expense_revisions` — one full snapshot per edit (PRD §3.5.3).
 *
 * The PRD makes this history visible to residents and calls that transparency "a core
 * trust feature — do not make it optional", which is why the row is a snapshot rather
 * than a diff and why the table is **append-only**: `supabase/migrations/20261001120000_expense_schema.sql`
 * grants `SELECT` and `INSERT` only — no `UPDATE`, no `DELETE` — so a revision cannot
 * be rewritten. `UNIQUE (expense_id, version)` means one state per version.
 *
 * `society_id` is present because SAD §8.1 applies the tenant column to every tenant
 * table; the PRD's block omits it, and both the RLS predicate and the composite key
 * that keeps a revision inside its expense's society need the column to exist. See
 * `./expenses.ts` for what this module deliberately does not restate.
 */

import { integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const expenseRevisions = {
  id: uuid("id").primaryKey().defaultRandom(),
  societyId: uuid("society_id").notNull(),
  expenseId: uuid("expense_id").notNull(),
  /** The expense's `version` at the time of the edit; unique per expense. */
  version: integer("version").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  changedBy: uuid("changed_by").notNull(),
  changeNote: text("change_note"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
} as const;
