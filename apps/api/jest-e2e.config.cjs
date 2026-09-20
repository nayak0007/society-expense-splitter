/**
 * Jest for `@ses/api` integration suites.
 *
 * SAD §15.4 calls for Testcontainers (real Postgres and Redis, no mocked
 * database). Those suites arrive with the first module that owns tables (T017+);
 * what exists today is the harness and the pipeline-level assertions that need no
 * database at all — booting the real `AppModule` and driving it over HTTP.
 *
 * Split from `jest.config.cjs` so `pnpm --filter @ses/api test` stays fast and
 * unit-only, and so this suite can grow a container fixture without slowing the
 * inner loop.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...require("@ses/config/jest-preset/node"),

  displayName: "ses/api-e2e",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.e2e-spec.ts"],

  // Sets the environment before any module — including `ConfigModule`, which
  // validates at import time and would otherwise fail the suite on an ambient
  // variable. See the file for why values are assigned rather than merged.
  setupFiles: ["<rootDir>/test/setup-env.ts"],

  moduleNameMapper: {
    "^@ses/contracts$": "<rootDir>/../../packages/contracts/src/index.ts",
    "^@ses/db-schema$": "<rootDir>/../../packages/db-schema/src/index.ts",
    "^@ses/domain$": "<rootDir>/../../packages/domain/src/index.ts",
  },

  // See jest.config.cjs for why this pattern is shaped the way it is: NestJS 12
  // is ESM, Jest executes CommonJS, and pnpm's store layout defeats the usual
  // `node_modules/(?!@nestjs/)` idiom.
  transformIgnorePatterns: [
    "node_modules/(?!(@nestjs|\\.pnpm/[^/]+/node_modules/@nestjs)/)",
  ],

  testTimeout: 30_000,
};
