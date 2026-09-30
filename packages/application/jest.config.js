/**
 * Jest for `@ses/application`.
 *
 * The transform and test discovery come from `@ses/config/jest-preset/node`.
 *
 * WHY THE `moduleNameMapper`: `@ses/domain`'s entry point is TypeScript source
 * (`src/index.ts`) rather than compiled output, which is what lets Metro and tsc
 * consume it with no build step. Jest cannot reach it that way — its default
 * `transformIgnorePatterns` skips `node_modules` — so the entry point is mapped
 * straight to source, where the transform applies.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...require("@ses/config/jest-preset/node"),
  moduleNameMapper: {
    "^@ses/domain$": "<rootDir>/../domain/src/index.ts",
  },

  /**
   * Coverage thresholds — SAD §15.2's "everything else 80% / 70%" row, which is
   * the row this package falls under.
   *
   * WHY THERE IS NO USE-CASE ROW HERE, EVEN THOUGH THIS PACKAGE IS WHERE THE USE
   * CASES LIVE. SAD §15.2's 90% lines / 85% branches use-case row is scoped to
   * `apps/api/src/modules/**\/use-cases/**`, and `@ses/api` declares exactly that
   * glob (it has no matches yet — the API modules carry controllers and
   * infrastructure while the use cases themselves live here). Re-pointing the row
   * at this package would be inventing a target the SAD does not state for this
   * path, so it is not done here; the drift is recorded in
   * `docs/guides/TEST_COVERAGE.md` §5 with today's per-directory figures
   * (statements / branches — `structure/use-cases` 83.55 / 75, `invitation/
   * use-cases` 91.42 / 82.69, `member/use-cases` 89.77 / 84.79,
   * `society/use-cases` 91.66 / 89.47) so the next task can decide in the open
   * rather than by quietly lowering a number to fit.
   *
   * The four metrics mirror `@ses/api`'s existing global row, so no metric is
   * left open behind the two SAD names.
   *
   * Measured today: 88.18 statements / 82.21 branches / 94.44 functions /
   * 90.48 lines.
   */
  coverageThreshold: {
    global: { statements: 80, branches: 70, functions: 80, lines: 80 },
  },
};
