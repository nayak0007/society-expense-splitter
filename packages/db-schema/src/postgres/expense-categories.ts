/**
 * `expense_categories` — a society's expense vocabulary (PRD §7.3, §3.5.3).
 *
 * Columns are described for typing; the constraints, the partial unique index on
 * live names (`uq_expense_categories_society_name … WHERE deleted_at IS NULL`), the
 * `(id, society_id)` anchor that `expenses.category_id` points at, the RLS policies,
 * the column grants and the seeding of the nineteen defaults all live in
 * `supabase/migrations/20261001120000_expense_schema.sql` — for the reasons
 * `./expenses.ts` records (foreign keys to tables outside this package, composite
 * tenant keys and index expressions are not expressible here, and a partial
 * description of a constraint is worse than none).
 *
 * This is one of SAD §8.1's **soft-delete** tables: `deleted_at`/`deleted_by` are
 * present, `DELETE` is not granted, and deactivation (`is_active = false`) is the
 * documented alternative when an expense references the category (T062).
 */

import {
  boolean,
  smallint,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { auditColumns } from "../shared/columns";

import { apartmentBasis, splitStrategy } from "./expenses";

export const expenseCategories = {
  id: uuid("id").primaryKey().defaultRandom(),
  societyId: uuid("society_id").notNull(),
  name: varchar("name", { length: 80 }).notNull(),
  icon: varchar("icon", { length: 40 }),
  /** `#RRGGBB` or `#RRGGBBAA` — the PRD's `varchar(9)`. */
  color: varchar("color", { length: 9 }),

  /** What a new expense in this category starts as, and its basis when `apartment`. */
  defaultSplitStrategy: splitStrategy("default_split_strategy")
    .notNull()
    .default("equal"),
  defaultApartmentBasis: apartmentBasis("default_apartment_basis"),

  /**
   * Excluded from tenant splits and routed to the flat's owner (PRD §2.2).
   * Seeded `true` for Sinking Fund and Corpus Fund — the two the PRD names.
   */
  isOwnerOnly: boolean("is_owner_only").notNull().default(false),
  /** Excluded from operating-expense trend charts (PRD §3.5.3). Same two seeded. */
  isCapital: boolean("is_capital").notNull().default(false),
  gstApplicable: boolean("gst_applicable").notNull().default(false),
  /** Deactivation, not deletion, is what a referenced category gets (T062). */
  isActive: boolean("is_active").notNull().default(true),
  /** The seeded order is PRD §3.5.3's list order, 1..19. */
  displayOrder: smallint("display_order").notNull().default(0),

  ...auditColumns,
  createdBy: uuid("created_by"),
  updatedBy: uuid("updated_by"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
} as const;
