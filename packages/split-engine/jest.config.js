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
 * @type {import('jest').Config}
 */
module.exports = {
  ...require("@ses/config/jest-preset/node"),
  moduleNameMapper: {
    "^@ses/domain$": "<rootDir>/../domain/src/index.ts",
  },

  /**
   * Coverage thresholds — SAD §15.2's `packages/split-engine/**` row: 100% lines,
   * 100% branches. Roadmap T056 required the same number and verified it by
   * reading a `--coverage` table; T014 wires the number so the verification is no
   * longer manual.
   *
   * WHY `global` RATHER THAN A PATH PATTERN: the row covers the entire package,
   * and `collectCoverageFrom` already limits collection to `src/**` minus tests,
   * so `global` *is* `packages/split-engine/**`. A path pattern would additionally
   * be capable of silently matching nothing; a global threshold cannot be
   * vacuous, which matters for the one gate in the repository that is allowed to
   * fail the build over a single uncovered branch.
   *
   * All four metrics are pinned, not just the two SAD names: a split that is
   * correct and a split that is *exercised* are the same requirement here
   * (`docs/guides/SPLIT_ENGINE.md` §11), and functions and statements were
   * already 100% when the row was written, so pinning them records a fact rather
   * than imposing a new one.
   *
   * Measured today: 100 statements / 100 branches / 100 functions / 100 lines
   * across all six source files.
   */
  coverageThreshold: {
    global: { statements: 100, branches: 100, functions: 100, lines: 100 },
  },
};
