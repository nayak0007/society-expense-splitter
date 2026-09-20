import { defineConfig } from "drizzle-kit";

/**
 * Configuration for `drizzle-kit` (schema generation, studio, and the `down`
 * checks in CI). Applying migrations is `src/tools/migrate.ts`, which validates
 * the whole environment through the same schema the server uses — drizzle-kit
 * reads only what it needs here.
 *
 * `MIGRATION_DATABASE_URL`, not `DATABASE_URL`: drizzle-kit issues DDL, and the
 * runtime role is deliberately not permitted to (see `UnitOfWork` and SAD §8.7).
 */
const migrationUrl = process.env.MIGRATION_DATABASE_URL;

if (migrationUrl === undefined || migrationUrl === "") {
  throw new Error(
    "MIGRATION_DATABASE_URL is not set. drizzle-kit runs DDL, so it needs the owner " +
      "connection, not the runtime DATABASE_URL. Copy apps/api/.env.example to .env and fill it in.",
  );
}

export default defineConfig({
  dialect: "postgresql",
  // The API's schema entry point, which re-exports `@ses/db-schema` so the
  // generated migration matches the definitions the mobile replica also uses.
  schema: "./src/infrastructure/database/schema.ts",
  out: "./migrations",
  dbCredentials: { url: migrationUrl },
  // Ask before a statement that cannot be undone, and print the SQL being run.
  strict: true,
  verbose: true,
});
