/**
 * `@ses/db-schema` — Drizzle table definitions, shared by the API (Postgres) and
 * the mobile replica (SQLite subset), so a column has one definition rather than
 * two that drift.
 *
 * Table definitions arrive with the modules that own them — the expense domain's
 * six landed with T060 (`src/postgres/{expense-categories,expenses,expense-splits,
 * expense-revisions,expense-gst-details,dues}.ts`) and `member-balances.ts` with
 * T067 — and the package deliberately
 * carries no empty placeholder modules, because an empty schema file makes
 * `drizzle-kit generate` produce a migration that changes nothing.
 *
 * The ordered SQL in `supabase/migrations/` remains the schema's source of truth and
 * the constraint authority (ADR-0008); these modules describe the same columns for
 * typing, and each one says what it deliberately does not restate.
 */

export * from "./shared/columns";

export * from "./postgres/expense-categories";
export * from "./postgres/expense-gst-details";
export * from "./postgres/expense-revisions";
export * from "./postgres/expense-splits";
export * from "./postgres/expenses";
export * from "./postgres/dues";
export * from "./postgres/member-balances";
