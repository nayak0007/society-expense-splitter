// @ts-check
/**
 * App-level ESLint config for `apps/api`, so `pnpm --filter @ses/api lint` works
 * from this cwd. Keep in sync with Zone 3 of the root `eslint.config.js`.
 */
const nodePreset = require("../../packages/config/eslint-preset/node");
const globals = require("globals");

module.exports = [
  ...nodePreset,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // The core rules misread TS-only syntax; `tsc` covers what they would catch.
      "no-undef": "off",
      "no-unused-vars": "off",
      // `@typescript-eslint/no-unused-vars` is configured once, in
      // packages/config/eslint-preset/base.js, with the `^_` ignore patterns.
      // Re-stating it as a bare `"error"` here would drop those options.
    },
  },
  {
    // SAD §19.2: configuration is read through the typed ConfigService, never
    // `process.env` in feature code.
    files: ["src/**/*.ts"],
    ignores: ["src/config/**"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Read configuration through ConfigService (src/config). Direct process.env access is only allowed in src/config/**.",
        },
      ],
    },
  },
  {
    files: ["*.config.js", "*.config.ts", "*.cjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "no-console": "off", // build tooling config may log
    },
  },
  {
    // CLI tools write their progress to stdout — that output is the whole
    // interface. The `no-console` rule targets application code, where the
    // structured logger is mandatory.
    files: ["src/tools/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    ignores: ["dist/**", "coverage/**", ".turbo/**", "node_modules/**"],
  },
];
