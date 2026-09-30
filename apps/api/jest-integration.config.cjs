/**
 * Jest for `@ses/api` — the Testcontainers **integration** suite (Roadmap T034).
 *
 * Separate from `jest.config.cjs` (unit, fast, no infrastructure) and from
 * `jest-e2e.config.cjs` (boots the real app against *fakes*, asserting the HTTP
 * pipeline). This one boots the real app against a real Postgres and a real Redis
 * and asserts what only those can answer: policies, constraints, `SET ROLE`, and
 * `BEGIN`/`ROLLBACK`.
 *
 * WHY `globalSetup` AND `setupFiles` AND NOT `beforeAll`: the container must exist
 * before the first module of any test file is imported (`DATABASE_URL` is read to
 * build the pool), and a `beforeAll` runs after imports. The global setup starts
 * the servers, applies the migration chain and writes the connection strings; the
 * setup file loads them into `process.env` in each worker. The teardown removes
 * the containers from the ids the setup recorded. See
 * `test/integration/global-setup.ts`, `test/integration/global-teardown.ts` and
 * `test/integration/setup-env.ts`.
 *
 * WHY `maxWorkers: 1`: isolation here is **destructive** — `resetData` truncates
 * the schema between tests — so two files running in parallel would clear each
 * other's fixtures mid-test. One container, one schema, serial files, and every
 * file independent of the others' order. The suite is small enough that the
 * serialisation costs seconds; a shared container plus a truncate is worth far
 * more than a container per worker.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...require("@ses/config/jest-preset/node"),

  displayName: "ses/api-integration",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.integration-spec.ts"],

  // Starts the containers, applies the real migration chain, and writes the
  // connection strings + container ids to the state file.
  globalSetup: "<rootDir>/test/integration/global-setup.ts",

  // Runs after the last suite and removes the containers the setup started, by id
  // from the state file. A separate module because Jest ignores a teardown
  // *returned* by `globalSetup` (`@jest/core` discards the return value).
  globalTeardown: "<rootDir>/test/integration/global-teardown.ts",

  // Runs before the first import of every test file: loads the state file into
  // `process.env` so `ConfigModule` validates against the containers.
  setupFiles: ["<rootDir>/test/integration/setup-env.ts"],

  moduleNameMapper: {
    "^@ses/contracts$": "<rootDir>/../../packages/contracts/src/index.ts",
    "^@ses/db-schema$": "<rootDir>/../../packages/db-schema/src/index.ts",
    "^@ses/domain$": "<rootDir>/../../packages/domain/src/index.ts",
  },

  // Same pnpm/Nest-ESM reasoning as the other two configs.
  transformIgnorePatterns: [
    "node_modules/(?!(@nestjs|jose|\\.pnpm/[^/]+/node_modules/(@nestjs|jose))/)",
  ],

  // The container start and the migration chain happen once, in `globalSetup`
  // (which Jest does not time out), but a single spec still waits on real queries
  // and a pool handshake.
  testTimeout: 30_000,
  maxWorkers: 1,
};
