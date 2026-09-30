/**
 * `@ses/api` coverage over the **complete automated API test surface**:
 * unit + integration (Testcontainers) + e2e (SAD §15.2's "everything else
 * 80% / 70%" row, measured against every suite that legitimately exercises the
 * production code).
 *
 * ## Why this exists
 *
 * SAD §15.2's 80/70 row is a statement about the API's production code, and that
 * code is only fully reachable by the union of the three suites: the unit suite
 * owns the pipeline and the boundary, the integration suite owns the
 * repositories, `UnitOfWork`, the Redis cache and the migration runner (~940
 * lines that need a server), and the e2e suite owns the controllers, mappers and
 * the request pipeline mounted on the real `AppModule` against fake repositories.
 * Measuring the row against any one suite compares a number against a suite the
 * row was never about — which is exactly what T014 discovered.
 *
 * Jest merges coverage across `projects` natively (one CoverageReporter at the
 * root collects every project's raw counters and merges them by file, so a
 * statement executed by *any* layer counts as covered — this is a raw-map merge,
 * not an average of percentages). That is the whole mechanism; no `istanbul-merge`
 * and no second toolchain.
 *
 * ## What runs here
 *
 *   unit         `jest.config.cjs`             — in-process, no infrastructure
 *   integration  `jest-integration.config.cjs` — real Postgres + Redis, started
 *                                                by the project's own
 *                                                `globalSetup` (requires Docker)
 *   e2e          `jest-e2e.config.cjs`         — real `AppModule`, fake
 *                                                repositories, no Docker
 *
 * ## The Docker requirement is deliberate
 *
 * This command is the **authoritative** API coverage gate (`pnpm test:coverage`
 * at the root runs it through Turbo), so it requires a container runtime. If
 * Docker is unavailable, the integration project's `globalSetup` fails with the
 * staged, explicit message from `test/integration/global-setup.ts` and Jest
 * exits non-zero *before any suite runs* — the gate fails loudly rather than
 * skipping integration and reporting a partial number as complete. The
 * lightweight, no-Docker variants are `test:coverage:unit` (this package, unit
 * only) and the per-layer commands recorded in `docs/guides/TEST_COVERAGE.md`.
 *
 * @type {import('jest').Config}
 */
const unit = require("./jest.config.cjs");
const integration = require("./jest-integration.config.cjs");
const e2e = require("./jest-e2e.config.cjs");

module.exports = {
  projects: [
    { ...unit, displayName: "ses/api-unit" },
    { ...integration, displayName: "ses/api-integration" },
    { ...e2e, displayName: "ses/api-e2e" },
  ],

  // Global, because Jest does NOT honour a project-level `maxWorkers` in a
  // multi-project run — it warns (`Option "maxWorkers" is not supported in an
  // individual project configuration`) and ignores it, so the integration
  // project's `maxWorkers: 1` did not apply here. The integration specs share one
  // container and isolate by *destructive* truncation, so parallel files clear
  // each other's fixtures: the first execution of the merged command failed four
  // `rls` tests with `societies_created_by_fkey` violations and took 52s instead
  // of ~10s. One worker is the same contract `jest-integration.config.cjs`
  // declares; the unit and e2e suites pay a few seconds of serialisation they
  // can afford.
  maxWorkers: 1,

  // Thresholds and reporters are read from the ROOT config in a multi-project
  // run, not from a project — so the numbers live here, once, and are the same
  // object the single-project unit config declares (SAD §15.2's global 80/70 row;
  // no per-layer threshold is applied to this run).
  coverageThreshold: unit.coverageThreshold,
  coverageReporters: unit.coverageReporters,

  // The same declared file set the unit gate measures (from the shared preset).
  // The root ignores a project's `collectCoverageFrom` for the same reason it
  // ignores `maxWorkers`, so without this the merged denominator is “whatever the
  // suites loaded”: measured, that pulled six `test/**` helpers in (98 lines, ~80%
  // covered) and omitted every source no test imports, which makes the merged
  // percentage a different claim about a different file set than the gate's.
  // Declared here so all four numbers (each layer and the merge) describe the
  // same files.
  collectCoverageFrom: ["<rootDir>/src/**/*.ts", "!<rootDir>/src/**/*.d.ts"],
  coveragePathIgnorePatterns: ["/__tests__/"],

  // One report for the package, collected across all three projects.
  coverageDirectory: `${__dirname}/coverage`,
};
