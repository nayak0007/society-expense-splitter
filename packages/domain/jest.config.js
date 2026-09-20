/**
 * Jest for `@ses/domain`.
 *
 * The transform, test discovery and coverage source live in the shared
 * `@ses/config/jest-preset/node` preset — see `packages/config/jest-preset/base.js`
 * for why that transform is SWC rather than ts-jest (short version: ts-jest does
 * not support the TypeScript 6 compiler this workspace is on).
 *
 * Nothing is added on top: the domain package has zero runtime dependencies, so
 * it needs no `moduleNameMapper` and no environment setup.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...require("@ses/config/jest-preset/node"),
};
