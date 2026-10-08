/**
 * `expense_comments` — the flat discussion stream on an expense (PRD §3.5.3
 * "Notes", Roadmap T072).
 *
 * The table, its constraints, index, RLS policies and grants are created by
 * `supabase/migrations/20261014120000_expense_comments.sql`, which is the schema's
 * source of truth (ADR-0008). This module describes the same columns for the two
 * TypeScript consumers, and — as every other module here does — deliberately
 * omits what Drizzle cannot express faithfully:
 *
 * 1. **The composite `(expense_id, society_id)` key to `expenses`.** Drizzle has
 *    no composite-foreign-key form; the migration owns it.
 * 2. **The single-column author key.** It references `members`, which has no
 *    module in this package (the same omission `expenses.created_by` records).
 * 3. **The `UNIQUE (expense_id, sequence)` constraint, the CHECKs and the identity
 *    semantics of `sequence`.** `sequence` is `GENERATED ALWAYS AS IDENTITY` — the
 *    database assigns it and a client never writes it — which is why it is
 *    described here only for reads.
 *
 * This table *is* soft-deletable (unlike `expenses`, which is voided instead), so
 * it carries its own `deleted_at`/`deleted_by` pair rather than borrowing the
 * helper, whose `deleted_by` would be an eagerly-evaluated forward reference.
 */

import { bigint, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const expenseComments = {
  id: uuid("id").primaryKey().defaultRandom(),
  societyId: uuid("society_id").notNull(),
  expenseId: uuid("expense_id").notNull(),
  authorId: uuid("author_id").notNull(),
  body: text("body").notNull(),
  /** Database-assigned position within the stream; never client-supplied. */
  sequence: bigint("sequence", { mode: "bigint" }).generatedAlwaysAsIdentity(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
} as const;
