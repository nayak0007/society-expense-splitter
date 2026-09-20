import "reflect-metadata";

import { existsSync } from "node:fs";
import { join } from "node:path";

import { NestFactory } from "@nestjs/core";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { AppConfig } from "../config/app-config";
import { AppConfigModule } from "../config/config.module";

/**
 * Applies pending Drizzle migrations — Roadmap T016.
 *
 * **Connects with `MIGRATION_DATABASE_URL`, never `DATABASE_URL`.** The runtime
 * role is scoped so RLS applies to it; handing DDL to that role would either fail
 * outright or, worse, tempt someone to grant it the rights it needs — which is
 * how the API ends up holding a role that can bypass every policy (SAD §8.7).
 *
 * Config comes from a Nest application context rather than a bare `dotenv` call,
 * because the point is to reuse **the same validated schema the server uses**: a
 * migration that runs against a differently-interpreted environment is a
 * migration whose target is a guess. It also means a typo'd variable fails here
 * the same way it fails at boot.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppConfigModule, {
    logger: false,
  });

  try {
    const config = app.get(AppConfig);

    const migrationsFolder = join(process.cwd(), "migrations");
    if (!existsSync(join(migrationsFolder, "meta", "_journal.json"))) {
      // No migrations defined yet (T017 adds the first). Exiting successfully
      // keeps `db:migrate` usable in the deploy sequence from day one, rather
      // than making it a command that must be remembered to skip.
      console.log(
        `No migrations to apply — no Drizzle journal at ${migrationsFolder}.`,
      );
      return;
    }

    const client = postgres(config.migrationDatabaseUrl, {
      max: 1,
      prepare: false,
      connection: { application_name: "ses-api-migrate" },
    });

    try {
      await assertTargetIsSane(client);
      console.log("Applying migrations…");
      await migrate(drizzle(client), { migrationsFolder });
      console.log("Migrations applied.");
    } finally {
      await client.end({ timeout: 5 });
    }
  } finally {
    await app.close();
  }
}

/**
 * Catches the two states that make a migration run meaningless rather than
 * failing loudly later.
 *
 * A missing `public` schema means the database was reset and the schema was never
 * recreated; Drizzle would report a confusing failure from inside its first
 * statement. Checking here turns that into one readable line.
 */
async function assertTargetIsSane(
  client: ReturnType<typeof postgres>,
): Promise<void> {
  const rows = await client<{ present: boolean }[]>`
    select exists (
      select 1 from information_schema.schemata where schema_name = 'public'
    ) as present
  `;

  if (rows[0]?.present !== true) {
    throw new Error(
      'The "public" schema does not exist in the target database. ' +
        "If this is a local database that was reset, run `pnpm db:reset` first.",
    );
  }
}

main().catch((error: unknown) => {
  console.error("\nMigration failed.\n");
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
