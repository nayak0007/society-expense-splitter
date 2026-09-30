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
   * THESE NUMBERS ARE NOW ENFORCED, AND THIS PACKAGE DOES NOT PASS THEM (T014).
   * `pnpm test:coverage` runs `jest --coverage` here, so Jest applies the block
   * below on every developer machine and in CI — which is the point: before this,
   * the thresholds were declared and nothing invoked them. Measured today the
   * unit suite stands at 35.4 statements / 36.0 branches / 24.5 functions /
   * 34.4 lines, and it cannot be moved to 80 by scoping the file set: the
   * uncovered remainder is production code that its unit tests are not the
   * instrument for. Roughly a third of it is the SAD §15.4 integration surface
   * (repositories, `UnitOfWork`, the Redis membership cache, the migration
   * runner) which needs Testcontainers Postgres + Redis — infrastructure this
   * repository does not have yet and which Roadmap T034 owns — and the rest is
   * the request pipeline, controllers and module operations, exercised today by
   * the 333-test e2e suite and the live matrix instead of by unit tests.
   *
   * So the failure is deliberate and the numbers are NOT lowered: a gate that is
   * relaxed until it passes is decoration. The deficit, the files responsible for
   * it and the exact work that closes it are documented in
   * `docs/guides/TEST_COVERAGE.md`; no `collectCoverageFrom` narrowing and no
   * `istanbul ignore` was added to make this row green.
   */
  coverageThreshold: {
    global: { lines: 80, branches: 70, functions: 80, statements: 80 },
  },
};
