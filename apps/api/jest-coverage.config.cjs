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

  // ── The per-file budget Jest ACTUALLY applies — the root's, never a project's ──
  //
  // The same rule as `maxWorkers` and `coverageThreshold` above, and the one that
  // made this gate red nondeterministically: a project's `testTimeout` is NOT what
  // its own files run under here. jest-circus seeds its per-file timeout state from
  // the **root global config** (`initialize({ globalConfig, … })` does
  // `if (globalConfig.testTimeout) state.testTimeout = globalConfig.testTimeout`)
  // and every hook and test timer then reads that one value; nothing consults the
  // project's declaration. This file declared none, so Jest's 5 000 ms default
  // applied to *every* project in the merged run, while the projects declare 30 s
  // (integration, e2e) and the preset declares 60 s (unit).
  //
  // Measured, not inferred — a 6 s test body and a 6 s `beforeEach` in one
  // integration file, run twice in the same minute against the same containers:
  //
  //   jest --config jest-integration.config.cjs --testPathPatterns zz-…  → 2 passed
  //   jest --config jest-coverage.config.cjs    --testPathPatterns zz-…  → 2 failed
  //     "Exceeded timeout of 5000 ms for a test." / "… for a hook."
  //
  // That is the whole reason the affected suites pass alone and failed here, and
  // why the failing set moved between runs: a hook that stalls for five seconds
  // (a busy machine, a slow first query, a container round trip) was aborted with
  // its query still in flight, and the abandoned work then piled up behind it.
  //
  // One value has to be chosen for a merged run, so it is DERIVED — the strictest
  // budget any participating project declares. For this package that is exactly the
  // 30 s integration and e2e declare, and strictly *tighter* than the unit preset's
  // 60 s: the gate can never be more permissive than a project's own contract, only
  // as permissive. Derived rather than written as a literal so a project that
  // changes its declared budget cannot silently drift from the gate again — and no
  // global increase is introduced: every number used here is already declared in
  // the config of the project it applies to.
  testTimeout: Math.min(
    ...[unit, integration, e2e].map(
      // A project that declares nothing legitimately runs on Jest's 5 s default, so
      // that is the value it contributes rather than an invented one.
      (project) =>
        typeof project.testTimeout === "number" ? project.testTimeout : 5_000,
    ),
  ),

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
