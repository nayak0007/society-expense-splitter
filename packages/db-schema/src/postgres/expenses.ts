/**
 * `expenses` — one society expense (PRD §7.3, §3.5).
 *
 * The **constraints, indexes, triggers, policies and grants live in
 * `supabase/migrations/20261001120000_expense_schema.sql`**, which is the
 * schema's source of truth (ADR-0008). This module describes the same columns for
 * the two consumers that need them in TypeScript — the API's typed queries and the
 * mobile replica's SQLite subset — so a column has one definition rather than two
 * that drift. Three things are therefore deliberately *not* here, and each is a
 * decision rather than an omission:
 *
 * 1. **Foreign keys to tables defined outside this package.** `society_id`,
 *    `category_id`, `created_by`, `paid_by_member_id`, `approved_by` and
 *    `voided_by` point at `societies`, `expense_categories`, and `members`. Only
 *    the last of those has a module in this package, and none of them exists here
 *    yet — a `.references(() => members.id)` to an undefined table is a forward
 *    import that Drizzle evaluates at module load and that crashes the moment this
 *    package is imported. `src/shared/columns.ts` documents the same trap for
 *    `tenantColumn`. The keys are real; the migration owns them.
 * 2. **The composite tenant keys.** `(category_id, society_id)` and the four
 *    `(member, society_id)` pairs are what stop a cross-society reference; Drizzle
 *    has no composite-foreign-key form, and a single-column `.references()` here
 *    would describe a weaker rule than the database enforces — worse than silence.
 * 3. **Indexes and CHECK constraints.** `idx_expenses_society_date`,
 *    `idx_expenses_society_status`, `idx_expenses_category`,
 *    `idx_expenses_search` (GIN over `to_tsvector('english', title || ' ' ||
 *    coalesce(description, '') || ' ' || coalesce(vendor_name, ''))`) and the
 *    `chk_expenses_*` checks are all in the migration. The GIN expression in
 *    particular must match query text exactly to be used at all, so it is stated
 *    once, where it is created.
 *
 * `expenses` is in SAD §8.1's "never deleted — voided instead" tier: there is no
 * `deleted_at`, and `DELETE` is not granted to any client role.
 */

import {
  bigint,
  boolean,
  char,
  date,
  jsonb,
  pgEnum,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { auditColumns } from "../shared/columns";

/**
 * The expense lifecycle (PRD §7.1). Created by `20261001120000_expense_schema.sql`;
 * declared here for typing. The value order is the PRD's and is load-bearing —
 * an enum is ordered, so `ORDER BY status` follows this list.
 *
 * `published` is the only state whose splits must sum to the amount (SAD §8.6).
 */
export const expenseStatus = pgEnum("expense_status", [
  "draft",
  "pending_approval",
  "published",
  "void",
]);

/**
 * How an expense is divided (PRD §7.1). The type itself is created by
 * `20260920130000_society_core.sql` — the settings table needed it first — and is
 * mirrored here rather than re-declared in a second module, because two `pgEnum`s
 * with one name is how a vocabulary drifts.
 *
 * `packages/split-engine` is the only implementation of these five arms, and its
 * `planSplit` has one arm per value with no `default`.
 */
export const splitStrategy = pgEnum("split_strategy", [
  "equal",
  "percentage",
  "shares",
  "apartment",
  "custom",
]);

/**
 * The per-flat weighting an `apartment` strategy reads (PRD §7.1), likewise
 * declared by `20260920130000_society_core.sql` and mirrored here for typing.
 * `occupied_only` is deliberately absent: it is a question about *who participates*
 * (T063's participant resolver), not a way of weighting a participating flat.
 */
export const apartmentBasis = pgEnum("apartment_basis", [
  "per_flat",
  "per_sqft_carpet",
  "per_sqft_builtup",
  "per_bhk",
  "per_floor_band",
  "per_parking_slot",
]);

export const expenses = {
  id: uuid("id").primaryKey().defaultRandom(),
  societyId: uuid("society_id").notNull(),
  categoryId: uuid("category_id").notNull(),
  title: varchar("title", { length: 120 }).notNull(),
  description: text("description"),

  /**
   * Money, always integer paise (ADR-0005) — never numeric, never a float, and
   * `mode: "bigint"` so a value above 2^53 cannot lose precision on its way to the
   * domain's `Money`. `CHECK (amount_paise > 0)` in the migration: a zero-value
   * expense is not a bill.
   */
  amountPaise: bigint("amount_paise", { mode: "bigint" }).notNull(),
  /** Single-market product; the column exists so a second currency is a data change. */
  currency: char("currency", { length: 3 }).notNull().default("INR"),
  expenseDate: date("expense_date").notNull(),
  vendorName: varchar("vendor_name", { length: 120 }),
  /** `society_account`, or a member's pocket (with `paidByMemberId` naming them). */
  paymentSource: varchar("payment_source", { length: 24 })
    .notNull()
    .default("society_account"),
  paidByMemberId: uuid("paid_by_member_id"),

  splitStrategy: splitStrategy("split_strategy").notNull(),
  /** NULL unless the strategy is `apartment` — `planSplit` refuses that case. */
  apartmentBasis: apartmentBasis("apartment_basis"),
  splitConfig: jsonb("split_config").notNull().default({}),
  participantSelector: jsonb("participant_selector").notNull().default({}),

  /** Draft by default: an expense is built with no splits and published to bill. */
  status: expenseStatus("status").notNull().default("draft"),
  isRecurring: boolean("is_recurring").notNull().default(false),
  dueDate: date("due_date"),

  createdBy: uuid("created_by").notNull(),
  approvedBy: uuid("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidedBy: uuid("voided_by"),
  voidReason: text("void_reason"),

  ...auditColumns,
} as const;
