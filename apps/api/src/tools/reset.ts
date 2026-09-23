import postgres from "postgres";

import {
  assertResetIsAllowed,
  readMigrationDatabaseUrl,
} from "../config/migration-env";
import {
  applyMigrations,
  withMigrations,
} from "../infrastructure/database/migrations/runner";

/**
 * Dev-only database reset (`pnpm db:reset`).
 *
 * One tool, one history: this drops the application schemas and re-applies the
 * project's single migration set (ADR-0008). Where the old reset printed
 * "now run `supabase db push`, then `db:migrate`" — two runners, an ordering
 * constraint, and an operator expected to remember both — the reset now leaves
 * the database in exactly the state a fresh clone reaches with `pnpm
 * db:migrate`, because it runs the same runner over the same files.
 *
 * `ses_meta` (the ledger) is dropped with `public` on purpose: after a reset
 * the database has *no* migration history, and the runner's preflight then
 * treats every file as pending. Dropping them together is what makes "the data
 * is gone but the ledger claims it is migrated" impossible.
 *
 * Refuses to run in production/staging (`assertResetIsAllowed`), and connects
 * with the owner role from `MIGRATION_DATABASE_URL` — read through
 * `src/config/migration-env.ts`, since tools may not touch `process.env`
 * (SAD T008).
 */
async function main(): Promise<void> {
  assertResetIsAllowed();
  const migrationUrl = readMigrationDatabaseUrl();

  const sql = postgres(migrationUrl, {
    max: 1,
    connect_timeout: 10,
    prepare: false,
    connection: {
      application_name: "ses-migrations",
      statement_timeout: 0,
    },
  });

  try {
    console.log('Dropping schemas "public", "ses_meta" and "drizzle"…');
    await sql`drop schema if exists public cascade`;
    await sql`drop schema if exists ses_meta cascade`;
    // Left behind by the previous Drizzle-based runner; dropped so no reset
    // tree keeps a journal whose schema no longer exists.
    await sql`drop schema if exists drizzle cascade`;

    await sql`create schema public`;
    // PG15 removed the implicit CREATE grant on `public`; the bootstrap
    // migration's role grants then land on a usable schema.
    await sql`grant usage on schema public to public`;
    await sql`grant create on schema public to public`;

    console.log("Re-applying history via the migration runner…");
    const result = await withMigrations(migrationUrl, async (_sql, state) =>
      applyMigrations(_sql, state),
    );
    console.log(
      `Reset complete: ${result.appliedNow.length} migration(s) applied.`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error("\nDatabase reset failed.\n");
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
