/**
 * `dues` — what a member actually owes (PRD §7.3, §3.6).
 *
 * A split is the *bill*; a due is the *receivable*. They are separate rows because a
 * due can also be a late fee or an adjustment, and because its status moves on its own
 * as payments land. The constraint that matters is
 * `CHECK (paid_paise >= 0 AND paid_paise <= amount_paise)`; the indexes
 * (`idx_dues_member_status`, `idx_dues_society_due_date`, and the partial
 * `idx_dues_outstanding … WHERE status IN ('pending','partial','overdue')`), the
 * composite tenant keys and the grants are in
 * `supabase/migrations/20261001120000_expense_schema.sql`.
 *
 * **`paid_paise` is a derived value and is not client-writable.** SAD §8.6 invariant 3
 * says it "must equal the sum of verified allocations"; the migration therefore grants
 * `SELECT` on this table and nothing else, so no client can mark its own bill paid.
 * The policies that let a payment path write it arrive with that path (T079+);
 * T067 creates the rows themselves, from splits, inside the definer publishing
 * transaction, and adds `uq_dues_split` so one allocation cannot be billed twice.
 *
 * `amount_paise` carries no CHECK of its own, but read it together with the
 * constraint above: `paid_paise BETWEEN 0 AND amount_paise` is unsatisfiable for a
 * negative amount, so a due is always a **non-negative obligation**. That is the
 * settled model, not an accident (T067): credits and advance balances live on
 * `member_balances` (`advance_paise` / a signed `outstanding_paise`), never as a
 * negative due, so the PRD's void flow needs no weakening of this constraint.
 * `kind = 'adjustment'` is a positive correction line, not a credit: the credit
 * side of an adjustment is the member's balance.
 */

import {
  bigint,
  date,
  pgEnum,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * The dues lifecycle (PRD §7.1): `pending → partial → paid`, plus `overdue`,
 * `waived`, `written_off` and the advance credit. Created by
 * `supabase/migrations/20261001120000_expense_schema.sql`.
 */
export const dueStatus = pgEnum("due_status", [
  "pending",
  "partial",
  "paid",
  "overdue",
  "waived",
  "written_off",
]);

export const dues = {
  id: uuid("id").primaryKey().defaultRandom(),
  societyId: uuid("society_id").notNull(),
  memberId: uuid("member_id").notNull(),
  apartmentId: uuid("apartment_id"),
  expenseId: uuid("expense_id"),
  splitId: uuid("split_id"),
  /** `principal|late_fee|adjustment` — a CHECK in the migration, not an enum type. */
  kind: varchar("kind", { length: 16 }).notNull().default("principal"),
  amountPaise: bigint("amount_paise", { mode: "bigint" }).notNull(),
  paidPaise: bigint("paid_paise", { mode: "bigint" }).notNull().default(0n),
  status: dueStatus("status").notNull().default("pending"),
  dueDate: date("due_date").notNull(),
  waivedReason: text("waived_reason"),
  // No `version`: the PRD's `dues` block has none and SAD §8.3's ER agrees, so
  // `auditColumns` (which carries one) is not used here. The migration still attaches
  // `touch_updated_at()`, which sets `updated_at` and skips the version bump when the
  // column is absent.
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
} as const;
