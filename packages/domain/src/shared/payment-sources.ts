/**
 * Where the money came from — PRD §3.4's `payment_source` form choice.
 *
 * ## Why this lives in `shared/` rather than in `expense/ports.ts`
 *
 * It was declared beside `ExpenseDraftFields`, its first consumer, and that was the
 * wrong home for a *runtime* list: `ports.ts` is otherwise types only, and the domain's
 * coverage gate enforces 90% lines on every collected file under `src/expense/**` — a
 * module-level constant no unit test reads would have made a type-only file fail a
 * financial threshold. The vocabulary lists the contract, the database and the form
 * must agree on already have a home here (`split-vocabulary.ts` is the precedent), so
 * the list moved rather than the threshold.
 *
 * ## A closed union even though the column is open
 *
 * `expenses.payment_source` is `varchar(24)` (T060: "free text rather than an enum
 * because the PRD lists it as a form choice, not as a vocabulary the database has to
 * police"). The four values are the PRD's, and the contract imports this list so the
 * form and the column cannot drift; the database stays permissive because a future
 * source is a data change, not a migration.
 */
export const PAYMENT_SOURCES = [
  "society_account",
  "petty_cash",
  "member_paid",
  "vendor_credit",
] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];
