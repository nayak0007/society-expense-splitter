/**
 * The Expenses module's application layer (Roadmap T062 — expense categories).
 *
 * `createExpenseCategory` · `updateExpenseCategory` · `deleteExpenseCategory` ·
 * `listExpenseCategories`.
 *
 * `use-cases/support.ts` carries what every one of them shares: the injected
 * dependencies (`ExpenseCategoryDeps`), the load-and-authorise steps
 * (`loadExpenseCategoryContext`, `loadExpenseCategory`), the capability guard and the
 * duplicate-name check.
 *
 * Deliberately four use cases and not five: the Roadmap names exactly these four and
 * no `get-category`, and the list is a bounded read of every live row (nineteen seeded
 * plus a society's own), so a by-id read would be a second route over the same
 * handful of rows with no caller that needs it. A detail screen renders from the row
 * it already has.
 *
 * The Expense aggregate's own lifecycle (T061) lives in `@ses/domain` and is not
 * re-exported here; expense *creation*, publishing, approval and attachments are
 * T063's, and none of them is in this file.
 */
export * from "./use-cases";
