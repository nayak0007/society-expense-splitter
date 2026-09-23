import type { NodeEnv } from "./validation.schema";

/**
 * Environment for the migration tooling (`db:migrate`, `db:reset`,
 * `db:status`, `db:check`, `db:migrate:new`).
 *
 * ## Why this is not `AppConfig`
 *
 * `AppConfig` is validated through `@nestjs/config`, which requires the full
 * variable set (`SUPABASE_*`, `REDIS_URL`, …) to be present. The migration
 * runner talks to **one database** and reads **one directory**; demanding a
 * Supabase project from a schema command would make `db:migrate` unusable
 * anywhere but a fully configured checkout. This file therefore validates only
 * what the runner needs, with the same "refuse loudly" contract as §19.2.
 *
 * ## Where the values come from
 *
 * Scripts pass `--env-file-if-exists` (Node ≥ 22.9) so `apps/api/.env` is
 * loaded by the runtime before this module evaluates, mirroring how the server
 * gets its values. Node gives precedence to pre-existing environment variables,
 * which is the same dotenv precedence rule the server relies on. The module
 * itself never loads a file — it only reads what is already in `process.env` —
 * which is why the `no-restricted-properties` rule allows it here in
 * `src/config/**`, exactly like `validation.schema.ts` and `tool-env.ts`.
 */

/** The owner connection — the only role allowed to run DDL (SAD §8.7). */
export function readMigrationDatabaseUrl(): string {
  const value = process.env["MIGRATION_DATABASE_URL"];
  if (value === undefined || value === "") {
    throw new Error(
      "MIGRATION_DATABASE_URL is not set. The migration runner needs the " +
        "database OWNER connection (the runtime DATABASE_URL role is " +
        "deliberately too weak to write DDL — SAD §8.7). " +
        "See apps/api/.env.example.",
    );
  }
  return value;
}

/**
 * Optional override for the migrations directory. The runner defaults to
 * `supabase/migrations` resolved from the working directory upward, so this is
 * only needed when the SQL is shipped somewhere else — the container layout
 * (`MIGRATIONS_DIR=/app/migrations` in `infra/docker/api.Dockerfile`).
 */
export function readMigrationsDir(): string | undefined {
  const value = process.env["MIGRATIONS_DIR"];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Guard for destructive commands: `db:reset` refuses to run against anything
 * that claims to be production or staging, the same assertion the old
 * `tools/reset.ts` made through `AppConfig`. Read from `NODE_ENV` directly
 * because the runner does not boot Nest.
 */
export function assertResetIsAllowed(): void {
  const environment =
    (process.env["NODE_ENV"] as NodeEnv | undefined) ?? "development";
  if (environment === "production" || environment === "staging") {
    throw new Error(
      `Refusing to reset the database while NODE_ENV=${environment}. ` +
        "This command is for development and test databases only.",
    );
  }
}
