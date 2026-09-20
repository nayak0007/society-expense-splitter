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
   */
  transformIgnorePatterns: [
    "node_modules/(?!(@nestjs|\\.pnpm/[^/]+/node_modules/@nestjs)/)",
  ],

  /**
   * SAD §15.2, enforced per path rather than as one global number, so the
   * financial core cannot be diluted by well-covered plumbing:
   *
   *   use cases   90% lines / 85% branches
   *   everything  80% lines / 70% branches
   *
   * The `split-engine` and money thresholds (100%) belong to their own packages
   * and are enforced there. The use-case glob has no matches yet — it governs the
   * first use case rather than being added alongside it, which is the whole point
   * of putting the gate in before the code.
   */
  coverageThreshold: {
    global: { lines: 80, branches: 70, functions: 80, statements: 80 },
    "./src/modules/**/use-cases/**": { lines: 90, branches: 85 },
  },
};
