import postgres from "postgres";

import {
  assertResetIsAllowed,
  readMigrationDatabaseUrl,
  readMigrationsDir,
} from "../config/migration-env";
import {
  applyMigrations,
  assertCleanHistory,
  createMigration,
  HistoryError,
  inspectState,
  listMigrationFiles,
  MigrationFailedError,
  resolveMigrationsDir,
  withMigrations,
  type ApplyResult,
} from "../infrastructure/database/migrations/runner";

/**
 * The migration CLI — every database-schema operation goes through here
 * (ADR-0008). One runner, one ledger (`ses_meta.migrations`), one source of
 * truth (`supabase/migrations/*.sql`).
 *
 * ```
 * pnpm db:migrate          apply pending migrations
 * pnpm db:status           what has been applied, and what is pending
 * pnpm db:check            CI gate: fail if the database does not match HEAD
 * pnpm db:migrate:new <slug>  scaffold the next migration file
 * ```
 *
 * `MIGRATION_DATABASE_URL` (owner role) for every command that touches the
 * database; the runtime `DATABASE_URL` role cannot write DDL by design. Config
 * comes from `src/config/migration-env.ts` — this file never touches
 * `process.env` itself.
 */

const USAGE = `Usage: node dist/migrate.js <command>

Commands:
  apply              Apply pending migrations (default).
  status             Show applied and pending migrations for the database.
  check              Exit 1 unless the database exactly matches HEAD (CI gate).
  new <subject>      Scaffold the next migration file (no database needed).
  reset              DEV ONLY: drop public + ses_meta, then apply everything.

Environment:
  MIGRATION_DATABASE_URL   owner connection (required for db commands)
  MIGRATIONS_DIR           optional directory override (container layout)
`;

type Command = "apply" | "status" | "check" | "new" | "reset";

function parseCommand(argv: readonly string[]): {
  command: Command;
  args: string[];
} {
  const [maybeCommand, ...rest] = argv;
  if (maybeCommand === undefined || maybeCommand === "") {
    return { command: "apply", args: [] };
  }
  if (
    maybeCommand === "apply" ||
    maybeCommand === "status" ||
    maybeCommand === "check" ||
    maybeCommand === "new" ||
    maybeCommand === "reset"
  ) {
    return { command: maybeCommand, args: rest };
  }
  if (maybeCommand === "--help" || maybeCommand === "-h") {
    console.log(USAGE);
    process.exit(0);
  }
  console.error(`Unknown command: ${maybeCommand}\n`);
  console.error(USAGE);
  process.exit(1);
}

/** Connection settings shared by every database-backed command. */
function openOwnerConnection(): ReturnType<typeof postgres> {
  return postgres(readMigrationDatabaseUrl(), {
    max: 1, // the advisory lock is session-scoped: one connection, one writer
    connect_timeout: 10,
    prepare: false,
    connection: {
      application_name: "ses-migrations",
      // DDL is unbounded by design; the runtime statement timeout must not
      // abort a long migration halfway.
      statement_timeout: 0,
    },
  });
}

async function main(): Promise<void> {
  const { command, args } = parseCommand(process.argv.slice(2));

  // ── `new` needs no database ────────────────────────────────────────────────
  if (command === "new") {
    const subject = args[0];
    if (subject === undefined || subject.trim() === "") {
      console.error("Usage: pnpm db:migrate:new <subject>  e.g. expense-core");
      process.exit(1);
    }
    const dir = resolveMigrationsDir(readMigrationsDir(), process.cwd());
    const created = createMigration(dir, subject);
    console.log(`Created ${created}`);
    console.log(
      "Describe the change and its reason in the header comment. Applied",
      "migrations are immutable — never edit an existing file; add another.",
    );
    return;
  }

  // ── every other command needs the owner connection ────────────────────────
  const sql = openOwnerConnection();

  try {
    switch (command) {
      case "apply": {
        const dir = readMigrationsDir();
        const result: ApplyResult = await withMigrations(
          readMigrationDatabaseUrl(),
          async (sql, state): Promise<ApplyResult> => {
            if (state.pending.length === 0) {
              console.log(
                `Database is up to date (${state.applied.length} migrations applied, nothing pending).`,
              );
              return { appliedNow: [], alreadyApplied: state.applied.length };
            }
            console.log(`Applying ${state.pending.length} migration(s)…`);
            for (const file of state.pending) {
              console.log(`  → ${file.name}`);
            }
            return applyMigrations(sql, state);
          },
          dir === undefined ? {} : { dir },
        );
        if (result.appliedNow.length > 0) {
          console.log(
            `Done: ${result.appliedNow.length} applied now, ${result.alreadyApplied} previously applied.`,
          );
        }
        break;
      }

      case "status": {
        const files = listMigrationFiles(
          resolveMigrationsDir(readMigrationsDir()),
        );
        const state = await inspectState(sql, files);
        assertCleanHistory(state);

        console.log(
          `Migrations directory: ${resolveMigrationsDir(readMigrationsDir())}`,
        );
        console.log(
          `Applied: ${state.applied.length} · Pending: ${state.pending.length}\n`,
        );
        for (const file of files) {
          const row = state.applied.find((r) => r.name === file.name);
          const marker = row === undefined ? "  pending " : "  applied  ";
          const when =
            row === undefined
              ? ""
              : `  (${row.appliedAt.toISOString()} by ${row.appliedBy})`;
          console.log(`${marker}${file.name}${when}`);
        }
        break;
      }

      case "check": {
        const files = listMigrationFiles(
          resolveMigrationsDir(readMigrationsDir()),
        );
        const state = await inspectState(sql, files);
        // Fails on edited-after-apply and ledger-rows-without-files, exactly
        // what `assertCleanHistory` guards in the apply path.
        assertCleanHistory(state);

        if (state.pending.length > 0) {
          console.error(
            `Database is behind HEAD: ${state.pending.length} migration(s) not applied:\n` +
              state.pending.map((f) => `  - ${f.name}`).join("\n"),
          );
          process.exitCode = 1;
          break;
        }
        console.log(
          `OK: database matches HEAD (${state.applied.length} migrations).`,
        );
        break;
      }

      case "reset": {
        // Belt and braces: the same guard the command always had, now before
        // any destructive statement runs.
        assertResetIsAllowed();
        console.log(
          'Dropping schemas "public", "ses_meta" and "drizzle" (cascade)…',
        );
        await sql`drop schema if exists public cascade`;
        await sql`drop schema if exists ses_meta cascade`;
        // Left behind by the previous Drizzle-based runner; dropped so a reset
        // tree cannot keep claiming the journal state that no longer exists.
        await sql`drop schema if exists drizzle cascade`;

        await sql`create schema public`;
        // PG15 removed the implicit CREATE grant on `public`; restate it so the
        // bootstrap migration's role grants land on a usable schema.
        await sql`grant usage on schema public to public`;
        await sql`grant create on schema public to public`;
        console.log("Schemas recreated. Re-applying history…");

        const resetDir = readMigrationsDir();
        const result = await withMigrations(
          readMigrationDatabaseUrl(),
          async (_sql, state) => applyMigrations(_sql, state),
          resetDir === undefined ? {} : { dir: resetDir },
        );
        console.log(
          `Reset complete: ${result.appliedNow.length} migration(s) applied.`,
        );
        break;
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  if (error instanceof HistoryError || error instanceof MigrationFailedError) {
    console.error(`\n${error.name}: ${error.message}\n`);
    if (error instanceof MigrationFailedError) {
      console.error(
        `The failed file (${error.migration.name}) was left unapplied — fix it ` +
          "and re-run `pnpm db:migrate`. Do not edit an already-applied " +
          "migration; add a new migration instead.",
      );
    }
  } else {
    console.error("\nMigration command failed.\n");
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  }
  process.exitCode = 1;
});
