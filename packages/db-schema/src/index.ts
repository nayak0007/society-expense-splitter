/**
 * `@ses/db-schema` — Drizzle table definitions, shared by the API (Postgres) and
 * the mobile replica (SQLite subset), so a column has one definition rather than
 * two that drift.
 *
 * Currently the shared column helpers only. Table definitions arrive with the
 * modules that own them (T017 adds `src/postgres/{users,societies,members}.ts`);
 * the package deliberately does not carry empty placeholder modules, because an
 * empty schema file makes `drizzle-kit generate` produce a migration that
 * changes nothing.
 */

export * from "./shared/columns";
