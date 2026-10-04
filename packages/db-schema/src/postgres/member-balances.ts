/**
 * `member_balances` — the maintained summary of what a member owes (PRD §3.5,
 * §7.3; SAD §8.3, §14.4).
 *
 * Not a table of truth: it is a **materialised projection** of `dues` (and, once
 * the payment paths exist, verified `payment_allocations`), refreshed inside the
 * transaction that writes the source rows. The PRD is explicit — "Maintain a
 * `member_balances` materialised summary refreshed transactionally on every
 * due/payment write, so the dashboard never runs an aggregate scan" — and SAD
 * §14.4 adds "a maintained summary table, not a computed aggregate". It is
 * deliberately never Redis-cached (SAD §6.5: "Never cache per-member balances in
 * Redis") and never client-writable: the migration grants `SELECT` and nothing
 * else, so the rows are written by the definer publishing transaction.
 *
 * ## Sign convention
 *
 * `outstanding_paise` is **signed** — a member in credit has a negative
 * outstanding balance (`docs/guides/MONEY.md` §4). `advance_paise` is the credit
 * magnitude T069's void flow writes into. The PRD's own DDL puts no CHECK on any
 * of these columns, and T067 adds none: a credit is a legal state, not a bug.
 * `dues.amount_paise`, by contrast, stays non-negative — an obligation — so
 * `chk_dues_paid_within_amount` never has to be weakened (the T060 note's
 * "signed balance" requirement is satisfied entirely on this side).
 *
 * ## What is deliberately not restated here
 *
 * The constraints, the RLS policy and the ordering index live in
 * `supabase/migrations/20261006120000_member_balances.sql`, which is the
 * schema's source of truth (ADR-0008), exactly as the other modules in this
 * package document. `member_id` is the primary key, so a balance row's identity
 * is the membership; the migration's foreign keys reference the primary keys of
 * `members` and `societies` (the PRD's own single-column form), not the
 * composite `(id, society_id)` anchors the expense tables use — those belong to
 * rows a client can address, and no client writes this table.
 */

import { bigint, date, timestamp, uuid } from "drizzle-orm/pg-core";

export const memberBalances = {
  /** One row per membership — the row a publish locks and adds its delta to. */
  memberId: uuid("member_id").primaryKey(),
  societyId: uuid("society_id").notNull(),

  /**
   * Everything billed to this member (principal dues plus later late fees and
   * adjustments), summed from `dues`. Not reduced by payments.
   */
  totalDuePaise: bigint("total_due_paise", { mode: "bigint" })
    .notNull()
    .default(0n),
  /** Verified payments allocated to this member's dues (T079+ writes this half). */
  totalPaidPaise: bigint("total_paid_paise", { mode: "bigint" })
    .notNull()
    .default(0n),
  /** Credits available to apply — a magnitude, not a sign (T069+). */
  advancePaise: bigint("advance_paise", { mode: "bigint" })
    .notNull()
    .default(0n),
  /**
   * PRD §3.5's `Σdues − Σverified payments − Σcredits + Σlate fees`, maintained
   * transactionally. Signed: negative means the member is in credit.
   */
  outstandingPaise: bigint("outstanding_paise", { mode: "bigint" })
    .notNull()
    .default(0n),
  /** The oldest unpaid due date, for ageing (T080's buckets). NULL when none. */
  oldestDueDate: date("oldest_due_date"),
  /** Refreshed by `touch_updated_at()`; this table carries no `version`. */
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
} as const;
