/**
 * Injection tokens for the expenses module's dependencies.
 *
 * A token rather than the concrete `ExpenseCategoryRepositoryPostgres` class, for the
 * reason the structure module's tokens record in full: `ExpenseCategoryRepository` is
 * an interface in `@ses/domain`, and injecting the adapter would make the application
 * layer depend on infrastructure — the direction SAD §3.1 exists to forbid — and would
 * leave the e2e suite no seam to substitute an in-memory repository, which is the only
 * way these routes can be tested without a database.
 *
 * ## Why two tokens for one adapter
 *
 * `EXPENSE_CATEGORY_REPOSITORY` and `EXPENSE_REFERENCE_READER` are bound to the same
 * `useExisting` instance today, and they are still two tokens rather than one. That is
 * deliberate: they are two *ports* with two owners-to-be. `ExpenseCategoryRepository`
 * is this module's; `ExpenseReferenceReader` counts rows in `expenses` and is declared
 * narrow precisely so that T063's expense repository can satisfy it without the
 * `deleteExpenseCategory` use case changing a line. Collapsing them into one token
 * would make that re-binding a change to the module's wiring *and* to a use case's
 * dependencies, which is the coupling the narrow port exists to avoid.
 *
 * The membership reader's token is **not** here. It is `MEMBERSHIP_READER` in
 * `common/authorization/`, because its provider is declared in `SocietiesModule` and
 * injected here — cross-module wiring belongs in shared vocabulary rather than in one
 * feature's internals. It is also already exported by `SocietiesModule` for the
 * structure module, so this module needs no change to the societies module at all.
 */
export const EXPENSE_CATEGORY_REPOSITORY = Symbol(
  "EXPENSE_CATEGORY_REPOSITORY",
);

/** The `expenses`-table read the delete rule needs — see the module docstring above. */
export const EXPENSE_REFERENCE_READER = Symbol("EXPENSE_REFERENCE_READER");
