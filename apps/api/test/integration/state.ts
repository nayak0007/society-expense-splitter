import { resolve } from "node:path";

/**
 * The hand-off between the integration global setup and the workers.
 *
 * `globalSetup` runs in Jest's parent process; every test file runs in a worker
 * with its own environment. Mutating `process.env` in the parent therefore does
 * *not* reach a suite — a mistake that shows up as a suite quietly connecting to
 * the placeholder URL from `test/setup-env.ts` and failing with `ECONNREFUSED`,
 * which reads like a flaky container rather than a wiring bug. The state is
 * written to a file and read by `setup-env.ts` in each file instead, so the
 * mechanism does not depend on how Jest forks workers.
 *
 * The file lives beside the suite and is gitignored (`.gitignore`); it is
 * scratch state for one run, and committing connection strings that contain a
 * container's ephemeral port would be noise in every diff.
 */
export interface IntegrationState {
  /** Owner connection: owns the schema, bypasses RLS. Migrations and fixtures. */
  readonly ownerUrl: string;
  /** `authenticator` connection: what the API runs as, subject to every policy. */
  readonly runtimeUrl: string;
  readonly redisUrl: string;
  /** Container ids, so `global-teardown.ts` stops exactly what this run started. */
  readonly postgresId: string;
  readonly redisId: string;
}

export const STATE_FILE = resolve(__dirname, "../.integration-env.json");
