/**
 * SES base Jest preset. Composed by `node.js` and `react-native.js`; consumers
 * spread it (`{ ...require("@ses/config/jest-preset/node"), ... }`) rather than
 * using `preset:`, because almost every consumer adds its own paths.
 *
 * WHY SWC AND NOT ts-jest — this workspace is on the TypeScript 6 compiler and
 * `ts-jest` supports 4.3–5.x only, so a `preset: "ts-jest"` config cannot run at
 * all. SWC is also the only next-gen compiler that supports the legacy decorators
 * and `emitDecoratorMetadata` that NestJS DI depends on, which is why the API
 * uses the same transform as the pure packages instead of a second toolchain.
 *
 * WHY THE TRANSFORM IS DATA, NOT A require(): Jest resolves a `transform` value
 * relative to the *consuming* project's rootDir, so `@swc/jest` stays a
 * devDependency of each consumer. Requiring it here would only work by accident
 * of pnpm hoisting.
 *
 * Type safety is not lost by skipping ts-jest: every package exposes a
 * `typecheck` script that runs the real compiler over sources *and* tests, and it
 * is wired into the Turbo pipeline.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  transform: {
    "^.+\\.(t|j)sx?$": [
      "@swc/jest",
      {
        jsc: {
          parser: {
            syntax: "typescript",
            // Handles .ts and .tsx with one rule; the API has no JSX but the
            // mobile preset inherits this entry.
            tsx: true,
            decorators: true,
          },
          transform: {
            legacyDecorator: true,
            decoratorMetadata: true,
          },
          // Types are already gone by this point; nothing needs down-levelling
          // for the Node versions this workspace supports.
          target: "es2022",
        },
        module: { type: "commonjs" },
      },
    ],
  },
  moduleFileExtensions: ["ts", "tsx", "js", "json"],
  moduleDirectories: ["node_modules"],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts"],
  // Tests and test support live beside the sources, so coverage must not count
  // the fakes and fixtures as production code.
  coveragePathIgnorePatterns: ["/__tests__/"],
  clearMocks: true,
};
