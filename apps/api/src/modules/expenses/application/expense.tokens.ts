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

/**
 * The publishing write path — T066's `ExpenseSplitRepository`.
 *
 * A token of its own rather than a method on `EXPENSE_REPOSITORY`: the two ports are
 * two tables' writers (`expenses` and `expense_splits`, joined by one definer
 * function), they are bound to two adapters, and the e2e suite substitutes them
 * independently — a fake that had to reproduce both would be the god-object the
 * ports exist to avoid.
 */
export const EXPENSE_SPLIT_REPOSITORY = Symbol("EXPENSE_SPLIT_REPOSITORY");

/**
 * The member-name read the publish snapshot needs — T066.
 *
 * Bound with `useExisting` to the participant adapter, which is already the module's
 * one reader of `members`: a second adapter reading the same table would be the
 * duplication `ParticipantMember`'s docstring rules out, and this port answers a
 * question that adapter can answer with the query it already owns.
 */
export const EXPENSE_MEMBER_NAME_READER = Symbol("EXPENSE_MEMBER_NAME_READER");

/**
 * Where a committed publication's event goes — SAD §3.2's dispatch seam.
 *
 * Bound today to an in-process publisher that records the event on the log; T107
 * replaces the binding with the orchestrator's queue. The *contract* — called after
 * commit, for fresh publications only, failures never propagated — is T066's, and
 * the unit suite observes it through this token.
 */
export const EXPENSE_EVENT_PUBLISHER = Symbol("EXPENSE_EVENT_PUBLISHER");

/**
 * The revision-history read — T068's `ExpenseRevisionRepository`.
 *
 * Its own token rather than a method on `EXPENSE_REPOSITORY`, for the reason
 * `EXPENSE_SPLIT_REPOSITORY` has one: it is a different table with a different
 * lifetime (append-only, SAD §8.1), and the e2e suite substitutes it independently —
 * a fake that had to answer revisions *and* expenses would be the god-object the
 * ports exist to avoid.
 */
export const EXPENSE_REVISION_REPOSITORY = Symbol(
  "EXPENSE_REVISION_REPOSITORY",
);

/**
 * The GST-details read and write — T072's `ExpenseGstDetailsRepository`.
 *
 * Its own token rather than a method on `EXPENSE_REPOSITORY` for the reason the
 * revision and split tokens have one: it is a different table (`expense_gst_details`,
 * 1:1 with the expense) with a different writer, and the e2e suite substitutes it
 * independently — a fake that had to answer expenses *and* GST details would be the
 * god-object the ports exist to avoid.
 */
export const EXPENSE_GST_DETAILS_REPOSITORY = Symbol(
  "EXPENSE_GST_DETAILS_REPOSITORY",
);

/**
 * The comment stream — T072's `ExpenseCommentRepository`.
 *
 * A third table (`expense_comments`), a third adapter and a third token, for the
 * same reason each of the others has one: a comment is not an expense field and not
 * a GST field, and its writer must be swappable on its own.
 */
export const EXPENSE_COMMENT_REPOSITORY = Symbol("EXPENSE_COMMENT_REPOSITORY");
