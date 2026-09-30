import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { readMigrationDatabaseUrl } from "../../src/config/migration-env";
import {
  applyMigrations,
  withMigrations,
} from "../../src/infrastructure/database/migrations/runner";

import {
  IntegrationInfrastructureError,
  startInfrastructure,
  stopInfrastructure,
} from "./containers";
import { STATE_FILE, type IntegrationState } from "./state";

/**
 * Jest `globalSetup` for the integration suite — Roadmap T034.
 *
 * One container pair per **run**, not per test file: the acceptance
 * ("Suite completes in under 3 minutes") rules out a fresh Postgres per file, and
 * a shared server is safe because isolation is achieved by data, not by server
 * (see `apps/api/test/utils/integration-db.ts` for the reset strategy). Jest runs
 * this once before any worker starts; the containers are stopped by
 * `global-teardown.ts`, which reads their ids from the state file written below.
 * (An earlier revision returned a teardown closure from this function — a
 * mechanism Jest does not support: `@jest/core`'s `runGlobalHook` awaits the
 * exported function and discards its return value, so that closure never ran and
 * cleanup was silently left to Ryuk. Verified against the installed Jest 30
 * source, then fixed here.)
 *
 * ## The order is the contract
 *
 *   1. start Postgres and Redis, and fail loudly and *specifically* if either
 *      cannot start (`containers.ts` names the stage);
 *   2. apply the **real** migration history through the **real** runner — the same
 *      `withMigrations` + `applyMigrations` pair `pnpm db:migrate` calls, reading
 *      the same `supabase/migrations`, under the same session advisory lock. There
 *      is no test-only schema and no second authority: if the history is broken,
 *      the integration suite is where that shows up rather than another place it
 *      can be forgotten;
 *   3. write the connection strings — and the container ids — where `setup-env.ts`
 *      and `global-teardown.ts` can read them, because Jest gives each test file
 *      its own module registry and its own env — a `process.env` mutation here
 *      does NOT reach the workers.
 *
 * ## Why the migration URL is read, not passed
 *
 * `MIGRATION_DATABASE_URL` is set here for the duration of this process and then
 * read through `readMigrationDatabaseUrl()`, the same accessor the CLI tools use.
 * That keeps one definition of "where migrations may be applied" and means the
 * integration path cannot drift from `pnpm db:check`'s.
 */
export default async function globalSetup(): Promise<void> {
  const infrastructure = await startInfrastructure();
  process.env["MIGRATION_DATABASE_URL"] = infrastructure.ownerUrl;

  const startedAt = Date.now();
  let applied = 0;

  try {
    applied = await withMigrations(
      readMigrationDatabaseUrl(),
      async (sql, state) => {
        const result = await applyMigrations(sql, state);
        return result.appliedNow.length;
      },
    );
  } catch (error) {
    // Stop the containers before rethrowing: a failed migration should not leave
    // two servers running for the rest of the CI job.
    await stopInfrastructure(infrastructure);
    throw new IntegrationInfrastructureError(
      "migrations",
      `the committed migration chain did not apply to ${"postgres:18-alpine"}. ${
        error instanceof Error ? error.message : String(error)
      }`,
      error,
    );
  }

  process.stdout.write(
    `[integration] migrations applied in ${((Date.now() - startedAt) / 1000).toFixed(1)}s (${applied} pending)\n`,
  );

  const state: IntegrationState = {
    ownerUrl: infrastructure.ownerUrl,
    runtimeUrl: infrastructure.runtimeUrl,
    redisUrl: infrastructure.redisUrl,
    postgresId: infrastructure.postgres.getId(),
    redisId: infrastructure.redis.getId(),
  };

  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}
