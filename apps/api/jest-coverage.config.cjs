/**
 * `@ses/api` coverage over **unit + integration** in one measurement.
 *
 * ## Why this exists, and why it is not the default yet
 *
 * SAD §15.2's "everything else 80% / 70%" row is a statement about the API's
 * production code, and that code is only half reachable by either suite alone:
 * the unit suite owns the pipeline and the boundary, and the integration suite
 * owns the repositories, `UnitOfWork`, the Redis cache and the migration runner
 * (~940 lines the unit suite cannot touch, because they need a server). Measuring
 * the row against the unit suite alone therefore compares a number against a
 * suite the row was never about — which is exactly what T014 discovered.
 *
 * Jest merges coverage across `projects` natively (one CoverageReporter at the
 * root collects from every project), so this needs no `istanbul-merge` and no
 * second toolchain. That is the whole mechanism.
 *
 * It is reachable as `pnpm --filter @ses/api test:coverage:integrated` and is
 * deliberately NOT what `test:coverage` runs, for one recorded reason (see
 * `docs/guides/TEST_COVERAGE.md` §4): it requires a container runtime, and the
 * default gate must stay runnable (and meaningful) on a machine without Docker.
 *
 * The merge itself has been executed (2026-09-30, T034): 24 suites / 315 tests
 * green, `@ses/api` 50.76 / 41.25 / 35.84 / 50.14 — below the 80/70 row, and the
 * honest merged number on the same file set the gate measures. Executing it found
 * the two root-option defects this file now fixes (`maxWorkers`, and the
 * `collectCoverageFrom` set). See the guide for the arithmetic on whether the 80%
 * row is reachable this way at all (it needs e2e in the merge too).
 *
 * @type {import('jest').Config}
 */
const unit = require("./jest.config.cjs");
const integration = require("./jest-integration.config.cjs");

module.exports = {
  projects: [
    { ...unit, displayName: "ses/api-unit" },
    { ...integration, displayName: "ses/api-integration" },
  ],

  // Global, because Jest does NOT honour a project-level `maxWorkers` in a
  // multi-project run — it warns (`Option "maxWorkers" is not supported in an
  // individual project configuration`) and ignores it, so the integration
  // project's `maxWorkers: 1` did not apply here. The integration specs share one
  // container and isolate by *destructive* truncation, so parallel files clear
  // each other's fixtures: the first execution of this merged command failed four
  // `rls` tests with `societies_created_by_fkey` violations and took 52s instead
  // of ~10s. One worker is the same contract `jest-integration.config.cjs`
  // declares; unit files pay a few seconds of serialisation they can afford.
  maxWorkers: 1,

  // Thresholds and reporters are read from the ROOT config in a multi-project
  // run, not from a project — so the numbers live here, once, and are the same
  // object the single-project unit config declares.
  coverageThreshold: unit.coverageThreshold,
  coverageReporters: unit.coverageReporters,

  // The same declared file set the unit gate measures (from the shared preset).
  // The root ignores a project's `collectCoverageFrom` for the same reason it
  // ignores `maxWorkers`, so without this the merged denominator is “whatever the
  // suites loaded”: measured, that pulled six `test/**` helpers in (98 lines, ~80%
  // covered) and omitted every source no test imports, which makes the merged
  // percentage a different claim about a different file set than the gate's.
  // Declared here so both numbers describe the same files.
  collectCoverageFrom: ["<rootDir>/src/**/*.ts", "!<rootDir>/src/**/*.d.ts"],
  coveragePathIgnorePatterns: ["/__tests__/"],

  // One report for the package, collected across both projects. `collectCoverageFrom`
  // and the ignore patterns come from the shared preset and are the same set the
  // unit run uses, so a file cannot be measured in one mode and not the other.
  coverageDirectory: `${__dirname}/coverage`,
};
