/**
 * Environment for the Testcontainers integration suite — runs as a `setupFiles`
 * entry, i.e. **before** the first module of a test file is imported.
 *
 * That ordering is not incidental. `apps/api/src/config/validation.schema.ts`
 * validates the environment when `ConfigModule` is imported, and
 * `apps/api/src/config/app-config.ts` builds the Postgres client from
 * `DATABASE_URL` at construction. A `beforeAll` would therefore be too late: the
 * application graph would already hold the placeholder URL from
 * `test/setup-env.ts`.
 *
 * The base file is imported first on purpose — it assigns the whole variable set
 * (Supabase issuer, service-role placeholder, `NODE_ENV`, `PORT`) with `=` rather
 * than `??=`, and this file then overrides the three values that must point at the
 * containers. One definition of the Supabase variables, one definition of the
 * connection targets.
 */
import { readFileSync } from "node:fs";

import { STATE_FILE, type IntegrationState } from "./state";

import "../setup-env";

function loadState(): IntegrationState {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as IntegrationState;
  } catch (error) {
    throw new Error(
      `The integration containers have not been started: ${STATE_FILE} is ` +
        `missing or unreadable. This file is written by ` +
        `test/integration/global-setup.ts, so a direct \`jest --config ` +
        `jest-integration.config.cjs\` outside the configured run, or a killed ` +
        `global setup, produces this. Re-run \`pnpm --filter @ses/api ` +
        `test:integration\`. Cause: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const state = loadState();

// The runtime connection the API uses: `authenticator`, restricted by RLS.
process.env["DATABASE_URL"] = state.runtimeUrl;
// The owner connection only the migration runner and the fixtures use.
process.env["MIGRATION_DATABASE_URL"] = state.ownerUrl;
process.env["REDIS_URL"] = state.redisUrl;

// The membership cache is Redis-backed in production (T038's invalidation work);
// the suite runs that path rather than the in-memory one so the Redis container
// is load-bearing instead of decorative. `MEMBERSHIP_CACHE_STORE` is the
// documented seam; `memory` remains available for a suite that must isolate a
// single-process cache.
process.env["MEMBERSHIP_CACHE_STORE"] = "redis";
