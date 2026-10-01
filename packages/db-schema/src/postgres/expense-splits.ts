/**
 * `expense_splits` — what each participating flat/member owes for one expense
 * (PRD §7.3, §3.5.3). The rows `chk_split_total()` sums.
 *
 * The invariant that reads this table is the reason the table exists in the shape it
 * does, and it lives in `supabase/migrations/20261001120000_expense_schema.sql`: a
 * DEFERRABLE INITIALLY DEFERRED constraint trigger on this table (and its companion
 * on `expenses`) refuses a COMMIT in which a published expense's splits do not sum
 * *exactly* to `expenses.amount_paise`. Constraints, the `UNIQUE NULLS NOT DISTINCT`
 * participant key, the composite tenant keys, the indexes, RLS and grants are all
 * there; see `./expenses.ts` for why they are not restated here.
 *
 * `amount_paise >= 0` rather than `> 0`: a floor-band exemption is a deliberate ₹0
 * allocation (SPLIT_ENGINE.md §5), so the constraint must allow it.
 */

import {
  bigint,
  numeric,
  timestamp,
  uuid,
  varchar,
  jsonb,
} from "drizzle-orm/pg-core";

export const expenseSplits = {
  id: uuid("id").primaryKey().defaultRandom(),
  societyId: uuid("society_id").notNull(),
  expenseId: uuid("expense_id").notNull(),

  /**
   * Both nullable, and one of them must be set. A participant is a *flat* first and
   * a member second: an owner-only category whose flat has no owner membership
   * produces a flat-only, "unassigned" row (PRD §3.5.4), and `member_id` is nullable
   * so a member's removal does not delete the debt.
   */
  memberId: uuid("member_id"),
  apartmentId: uuid("apartment_id"),

  amountPaise: bigint("amount_paise", { mode: "bigint" }).notNull(),
  /**
   * The split engine's exact weight, in the basis's own scale — carpet/built-up areas
   * in hundredths, BHK in tenths, band multipliers in thousandths (SPLIT_ENGINE.md
   * §7). This column is the first place a weight could overflow: a 100,000 sqft flat
   * weighs 10,000,000 hundredths, which fits, but the engine's ratios are unbounded by
   * design because they are computed in `bigint`.
   */
  weight: numeric("weight", { precision: 12, scale: 4 }),
  percent: numeric("percent", { precision: 7, scale: 4 }),
  /** Why this participant was charged — e.g. `owner_only_category` (T063). */
  assignedReason: varchar("assigned_reason", { length: 40 }),
  /** Participant name and flat number *at publish time*, so a rename cannot rewrite a bill. */
  snapshot: jsonb("snapshot").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
} as const;
