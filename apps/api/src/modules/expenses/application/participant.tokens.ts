/**
 * Injection tokens for participant resolution — Roadmap T063.
 *
 * Three tokens, because three questions come from three owners, and each is bound to
 * exactly one provider:
 *
 * ```
 * EXPENSE_PARTICIPANT_READER ──▶ ExpenseParticipantRepositoryPostgres  (this module)
 * EXPENSE_SOCIETY_READER     ──▶ SocietyRepositoryPostgres             (SocietiesModule, exported)
 * EXPENSE_CATEGORY_REPOSITORY ─▶ ExpenseCategoryRepositoryPostgres     (this module, T062)
 * MEMBERSHIP_READER          ──▶ SocietyRepositoryPostgres             (common/, T038)
 * ```
 *
 * The reader is a token for the reason `EXPENSE_CATEGORY_REPOSITORY` records: a Nest
 * injectable that named the Postgres class would put infrastructure under the
 * application layer and leave no seam in a test.
 *
 * `EXPENSE_SOCIETY_READER` is bound with `useExisting` to the provider
 * `SocietiesModule` already exports, so the one read of a society's `bill_vacant_flats`
 * keeps its single implementation in the module that owns `society_settings` — the
 * same borrow `MEMBERSHIP_READER` makes, and the reason this module changes no SQL of
 * the society module's. The port it satisfies is narrow (`findById`) and satisfied
 * *structurally* by the society repository, so no adapter class exists to drift.
 */
export const EXPENSE_PARTICIPANT_READER = Symbol("EXPENSE_PARTICIPANT_READER");

/** The society settings read resolution needs — `bill_vacant_flats`, one field. */
export const EXPENSE_SOCIETY_READER = Symbol("EXPENSE_SOCIETY_READER");
