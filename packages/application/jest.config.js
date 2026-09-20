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
};
