import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import postgres from "postgres";

import { AppConfig } from "../config/app-config";
import { AppConfigModule } from "../config/config.module";

/**
 * Drops and recreates the schemas this API owns — Roadmap T016
 * (`pnpm db:reset`).
 *
 * Two guards, because this command deletes data and the cost of a mistake is
 * unbounded:
 *
 * 1. **Refuses in `production` and `staging`.** A reset command that runs where
 *    it was not meant to is not a mistake you recover from with a second
 *    command.
 * 2. **Drops Drizzle's own journal along with `public`.** The journal records
 *    which migrations have been applied. Dropping the tables but keeping the
 *    journal leaves the database claiming to be migrated while every table is
 *    gone — and the next `db:migrate` would apply nothing. The two schemas are
 *    dropped together so they can only ever be consistent.
 *
 * Note what this cannot know: the Supabase CLI also writes into `public`
 * (`profiles`, its triggers, every RLS policy and the `society_*` functions).
 * Those are re-applied by `supabase db push`, not by this tool — see
 * `supabase/README.md`. After a reset, run the Supabase migrations before the
 * Drizzle ones, because those objects are what the tenant tables reference.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppConfigModule, {
    logger: false,
  });

  try {
    const config = app.get(AppConfig);

    if (config.isProduction || config.environment === "staging") {
      throw new Error(
        `Refusing to reset the database while NODE_ENV=${config.environment}. ` +
          "This command is for development and test databases only.",
      );
    }

    const client = postgres(config.migrationDatabaseUrl, {
      max: 1,
      prepare: false,
      connection: { application_name: "ses-api-reset" },
    });

    try {
      console.log('Dropping schemas "public" and "drizzle"…');
      await client`drop schema if exists public cascade`;
      await client`drop schema if exists drizzle cascade`;

      await client`create schema public`;
      // PG15 removed the implicit CREATE grant on `public` that earlier versions
      // had, so it is restated explicitly rather than assumed.
      await client`grant usage on schema public to public`;
      await client`grant create on schema public to public`;

      console.log("Schemas recreated.");
      console.log(
        "Next: re-apply the Supabase migrations (`npx supabase db push`), then `pnpm db:migrate`.",
      );
    } finally {
      await client.end({ timeout: 5 });
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error("\nDatabase reset failed.\n");
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
