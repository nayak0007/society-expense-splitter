/**
 * Injection tokens for the expense draft lifecycle — Roadmap T065.
 *
 * Tokens rather than class references, for the reason `expense-category.tokens.ts`
 * records: `ExpenseRepository`, `ExpenseApprovalPolicyReader` and `Clock` are things
 * `@ses/domain` declares, and injecting a concrete Postgres adapter would put
 * infrastructure under the application layer (SAD §3.1) and leave the e2e suite no
 * seam to substitute an in-memory repository.
 *
 * ```
 * EXPENSE_REPOSITORY            ──▶ ExpenseRepositoryPostgres        (this module)
 * EXPENSE_CLOCK                 ──▶ systemClock                       (a value)
 * EXPENSE_APPROVAL_POLICY_READER ─▶ SocietyRepositoryPostgres        (SocietiesModule, exported)
 * ```
 *
 * The approval-policy token is bound with `useExisting` to the provider the society
 * module already exports, so the one read of `society_settings.approval_threshold_paise`
 * keeps its implementation in the module that owns the table — the same borrow
 * `EXPENSE_SOCIETY_READER` makes, and the reason this module changes no SQL of the
 * society module's.
 */
export const EXPENSE_REPOSITORY = Symbol("EXPENSE_REPOSITORY");

/**
 * The clock every create and edit reads.
 *
 * Injected rather than imported so a test can step it — the 30-day expense-date rule
 * and `updated_at` are both functions of "now", and a rule about today is untestable
 * if it reads the wall clock. The societies module already binds the same
 * `systemClock` under its own token; this module declares its own so neither module
 * depends on the other's wiring.
 */
export const EXPENSE_CLOCK = Symbol("EXPENSE_CLOCK");

/** The society-settings read the approval threshold needs — one field. */
export const EXPENSE_APPROVAL_POLICY_READER = Symbol(
  "EXPENSE_APPROVAL_POLICY_READER",
);
