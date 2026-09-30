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

  // WHY THESE THREE REPORTERS (Roadmap T014). `text` is the table a developer
  // reads locally and the one CI prints when a threshold is missed; nothing else
  // is needed to diagnose a failure. `json-summary` is what the CI PR comment is
  // rendered from (`scripts/ci/coverage-comment.mjs`) — it is ~1 KB per package
  // where the raw `json` report is megabytes. `lcov` is for editor gutter
  // extensions and any future coverage service, and is the only format every one
  // of them reads. Jest's default set (`clover`, `json`, `lcov`, `text`) is
  // dropped because `clover` has no consumer here and `json` duplicates
  // `coverage-final.json` at ~1 MB per package on every run.
  coverageReporters: ["text", "json-summary", "lcov"],

  // Nothing here is a threshold: the gate is per package (`packages/*/jest.config.js`
  // and `apps/api/jest.config.cjs`), because the required numbers differ per path
  // (SAD §15.2) and a shared number cannot express that.
  clearMocks: true,
};
