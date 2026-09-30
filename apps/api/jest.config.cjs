/**
 * Jest for `@ses/api` — unit tests.
 *
 * Transform and discovery come from the shared `@ses/config/jest-preset/node`
 * preset (SWC, with `legacyDecorator` + `decoratorMetadata`, which Nest's DI needs
 * in tests as much as in production).
 *
 * Named `.cjs` because `apps/api/package.json` sets `"type": "module"` (NestJS 12
 * is ESM-only), and Jest loads its config through `require`.
 *
 * Integration suites that expect a real database live in `test/` and are run by
 * `test/jest-e2e.config.cjs`, so they are deliberately not matched here.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...require("@ses/config/jest-preset/node"),

  // The API imports workspace packages by name; Jest cannot follow their
  // TypeScript `main` through node_modules (its transformIgnorePatterns skip it),
  // so the entry points are mapped straight to source where the transform applies.
  moduleNameMapper: {
    "^@ses/contracts$": "<rootDir>/../../packages/contracts/src/index.ts",
    "^@ses/db-schema$": "<rootDir>/../../packages/db-schema/src/index.ts",
    "^@ses/domain$": "<rootDir>/../../packages/domain/src/index.ts",
  },

  /**
   * NestJS 12 ships as ESM while Jest executes CommonJS, so `@nestjs/*` has to be
   * down-levelled by the transform like our own sources. Without this, importing
   * any Nest peer fails with "Must use import to load ES Module:
   * …/@nestjs/common/index.js".
   *
   * The idiom is not `node_modules/(?!@nestjs/)`. Jest tests that expression
   * against the whole path and ignores the file if it matches anywhere, and pnpm
   * stores dependencies as `node_modules/.pnpm/<pkg>/node_modules/<pkg>/…`. The
   * first `/node_modules/` examines `.pnpm`, which is not `@nestjs`, so the
   * lookahead succeeds and the exclusion silently wins — the Nest ESM error comes
   * back unchanged. The second alternative is what actually matches pnpm's real
   * layout; `postgres` and every other CommonJS dependency still match the pattern
   * and are skipped, which matters because SWC cannot parse all of their sources.
   *
   * `jose` is here for the same reason as `@nestjs`: v6 ships ESM only, and the
   * auth tests exercise real signature verification rather than a mocked
   * library — mocking it would leave the algorithm-confusion and key-rotation
   * paths untested, which are the two the verifier exists to close.
   */
  transformIgnorePatterns: [
    "node_modules/(?!(@nestjs|jose|\\.pnpm/[^/]+/node_modules/(@nestjs|jose))/)",
  ],

  /**
   * SAD §15.2, enforced per path rather than as one global number, so the
   * financial core cannot be diluted by well-covered plumbing:
   *
   *   use cases   90% lines / 85% branches
   *   everything  80% lines / 70% branches
   *
   * The `split-engine` and money thresholds (100%) belong to their own packages
   * and are enforced there.
   *
   * THE USE-CASE ROW THAT USED TO BE HERE HAS MOVED OUT OF THIS CONFIG, and its
   * reason is a measurement rather than a preference. It read
   * `"./src/modules/**\/use-cases/**": { lines: 90, branches: 85 }` and matched
   * nothing, because this app's modules carry controllers and infrastructure
   * while the use cases live in `@ses/application`. Jest 30 does not tolerate
   * that: a threshold path matching no collected file fails the run outright with
   * `Jest: Coverage data for ./src/modules/**\/use-cases/** was not found.` So the
   * row was not a dormant gate waiting for the first use case — once T014 wired
   * `--coverage`, it would have failed every pull request with a configuration
   * error, which is exactly the kind of red that teaches people to ignore a gate.
   * The row should be re-declared here (or wherever the first API-side use case
   * lands) by the task that adds it; until then this package is held to the only
   * row that applies to it, and the drift is recorded in
   * `docs/guides/TEST_COVERAGE.md` §5.
   *
   * THESE NUMBERS ARE ENFORCED, AND THE PACKAGE NOW PASSES THEM (T014).
   * The block below is what the package's **authoritative** gate checks against
   * the *merged* unit + integration + e2e coverage — `test:coverage` runs
   * `jest-coverage.config.cjs`, which inherits this same `coverageThreshold`
   * object at its root (Jest reads thresholds from the root in a multi-project
   * run). This file's own numbers are the **unit-only** measurement, reachable
   * as `test:coverage:unit`, and they are not the gate's number: measured
   * 2026-09-30 the unit suite stands at 35.4 statements / 36.0 branches /
   * 24.5 functions / 34.4 lines. The merged number is **82.08 / 70.01 / 87.26 /
   * 81.95** (2,363/2,879 · 1,069/1,527 · 555/636 · 2,248/2,743) — the honest
   * figure for the package's complete automated test surface, and above the
   * 80/70 row. The branch margin is two counters, which is thin and worth
   * widening; it is not a reason to lower the row.
   *
   * Why the merged model: the uncovered remainder is production code no single
   * suite is the instrument for. The SAD §15.4 integration surface
   * (repositories, `UnitOfWork`, the Redis membership cache, the migration
   * runner) needs the Testcontainers suite Roadmap T034 landed; the request
   * pipeline, controllers and module operations are exercised by the 333-test
   * e2e suite; the remainder is the per-process shell (`main.ts`, `worker.ts`,
   * the CLI tools) that no test layer can honestly reach. Jest merges the three
   * projects' raw counters by file, so a statement executed by any layer counts
   * as covered — see `jest-coverage.config.cjs` and
   * `docs/guides/TEST_COVERAGE.md` §4 for the per-layer numbers, the file-set
   * proof and the gap math.
   *
   * The row was never lowered and nothing was excluded: what was missing was
   * production behaviour no assertion had reached, and T014 closed it with real
   * repository/database integration tests. No `collectCoverageFrom` narrowing and
   * no `istanbul ignore` is in play.
   */
  coverageThreshold: {
    global: { lines: 80, branches: 70, functions: 80, statements: 80 },
  },
};
