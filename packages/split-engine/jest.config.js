/**
 * Jest for `@ses/split-engine`.
 *
 * The transform and test discovery come from `@ses/config/jest-preset/node`.
 *
 * WHY THE `moduleNameMapper`: `@ses/domain`'s entry point is TypeScript source
 * (`src/index.ts`) rather than compiled output, which is what lets Metro and tsc
 * consume it with no build step. Jest cannot reach it that way — its default
 * `transformIgnorePatterns` skips `node_modules` — so the entry point is mapped
 * straight to source, where the transform applies. Identical to the mapping
 * `@ses/application` uses, for the identical reason.
 *
 * NO `coverageThreshold` HERE, deliberately: the per-path coverage gate is
 * Roadmap T014, which owns `.github/workflows/ci.yml` and every package's
 * thresholds. Declaring one now would be a second, unreachable source of truth
 * for the same number. T056's "100% coverage (blocking)" is verified by running
 * the suite with `--coverage` and reading the table; see `docs/guides/
 * SPLIT_ENGINE.md`.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...require("@ses/config/jest-preset/node"),
  moduleNameMapper: {
    "^@ses/domain$": "<rootDir>/../domain/src/index.ts",
  },
};
