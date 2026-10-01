/**
 * Jest for `@ses/domain`.
 *
 * The transform, test discovery and coverage source live in the shared
 * `@ses/config/jest-preset/node` preset — see `packages/config/jest-preset/base.js`
 * for why that transform is SWC rather than ts-jest (short version: ts-jest does
 * not support the TypeScript 6 compiler this workspace is on).
 *
 * Nothing is added on top for discovery: the domain package has zero runtime
 * dependencies, so it needs no `moduleNameMapper` and no environment setup.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...require("@ses/config/jest-preset/node"),

  /**
   * Coverage thresholds — SAD §15.2, enforced per path rather than as one global
   * number so the financial and authorization core cannot be diluted by
   * well-covered plumbing around it.
   *
   * The three path rows are SAD §15.2's own rows, which name **lines and
   * branches** (the two columns that table has) and nothing else, so only those
   * two are set here. The `global` row is the table's "everything else 80% / 70%"
   * expressed with the same four metrics `@ses/api` already enforced before this
   * task; functions and statements are pinned at the same 80 rather than left
   * open, so the row is not quietly looser than the sentences above it.
   *
   * TWO OF SAD §15.2'S ROWS CANNOT BE DECLARED YET, AND NOT FOR A DOCUMENTATION
   * REASON. Jest 30 fails the whole run — non-zero, before any comparison — when
   * a threshold path matches no file that was collected:
   *
   *   Jest: Coverage data for ./src/payment/** was not found.
   *
   * Measured while writing this file. That is why the table's
   * `**\/payment-allocator*` and `**\/dues-calculator*` rows (which the roadmap
   * will land at `src/payment/allocator.service.ts` under T079 and
   * `src/payment/dues-calculator.ts` under T080) are NOT written here as a
   * placeholder: a provisional row does not sit dormant waiting for the code, it
   * turns every unrelated pull request red with a configuration error. The same
   * defect was latent in `apps/api`'s use-case glob until this task removed it.
   * Both rows are therefore recorded in `docs/guides/TEST_COVERAGE.md` §5 and
   * belong to whichever task creates the files.
   *
   * Measured today (see `docs/guides/TEST_COVERAGE.md` for the command):
   * global 89.7 statements / 91.27 branches / 84.83 functions / 91.23 lines,
   * `money*` 100 across all four metrics, `permission-evaluator*` 100 after the
   * unknown-role case in `src/member/__tests__/permission-evaluator.test.ts`.
   */
  coverageThreshold: {
    global: { statements: 80, branches: 70, functions: 80, lines: 80 },
    "./src/shared/money*": { lines: 100, branches: 100 },
    "./src/member/permission-evaluator*": { lines: 100, branches: 100 },
    // Roadmap T061's own row: "90%+ coverage" on the Expense aggregate and its
    // value object. A path row rather than an aspiration in prose — the financial
    // core's rules are the ones a diluted global number would hide.
    "./src/expense/**": { lines: 90, branches: 90 },
  },
};
