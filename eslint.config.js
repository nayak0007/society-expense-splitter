// @ts-check
/**
 * Root ESLint flat config. `lint-staged` runs `eslint --fix` from the repo
 * root (the workspace has no root eslint until now), so this config must
 * resolve for EVERY staged file zone: root/package CommonJS config files,
 * apps/mobile sources and apps/api sources.
 *
 * The mobile zone deliberately mirrors apps/mobile/eslint.config.js, and the API
 * zone mirrors apps/api/eslint.config.js — keep each pair in sync (the app-level
 * copies exist so a filtered `pnpm --filter <pkg> lint` works from that cwd).
 */
const js = require("@eslint/js");
const globals = require("globals");
const reactNativePreset = require("./packages/config/eslint-preset/react-native");
const nodePreset = require("./packages/config/eslint-preset/node");

module.exports = [
  // ── Zone 1: mobile app sources (mirrors apps/mobile/eslint.config.js) ──
  ...reactNativePreset,
  {
    // Globals only — the core-rule replacements for TypeScript live in the
    // shared preset (ses/react-native/typescript-core-rule-replacements), so
    // the app-level config gets them too instead of drifting.
    files: ["**/*.ts", "**/*.tsx"],
    ignores: ["**/node_modules/**"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ["apps/mobile/*.config.js", "apps/mobile/*.cjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // ── Zone 2: root + packages CommonJS config files run in Node ──
  {
    files: ["*.js", "*.cjs", "packages/**/*.js", "scripts/**"],
    ignores: ["apps/**"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      eqeqeq: ["error", "smart"],
      "no-console": "off", // config files may log
    },
  },

  // ── Zone 3: API sources (mirrors apps/api/eslint.config.js) ──
  // The Node preset's entries carry no `files` key (they are meant to be spread
  // at the top of a dedicated config), so each is scoped to the API here rather
  // than allowed to override the mobile zone's stricter `no-console`.
  ...nodePreset.map((entry) => ({
    ...entry,
    files: entry.files ?? ["apps/api/**/*.ts"],
  })),
  {
    files: ["apps/api/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // The core rules misread TS-only syntax (type parameters, `declare`
      // blocks); typescript-eslint documents these as false positives, and
      // `tsc` already reports undefined variables with full type context.
      "no-undef": "off",
      "no-unused-vars": "off",
      // `@typescript-eslint/no-unused-vars` is configured once, in
      // packages/config/eslint-preset/base.js, with the `^_` ignore patterns.
      // Re-stating it as a bare `"error"` here would drop those options.
    },
  },
  {
    // SAD §19.2 / Roadmap T008: configuration is read through the typed
    // ConfigService, never `process.env` in feature code. Enforced rather than
    // documented, because a stray `process.env.X` is silently `undefined` in a
    // container and only fails on the code path that reads it.
    files: ["apps/api/src/**/*.ts"],
    ignores: ["apps/api/src/config/**"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Read configuration through ConfigService (apps/api/src/config). Direct process.env access is only allowed in src/config/**.",
        },
      ],
    },
  },
  {
    files: ["apps/api/*.config.js", "apps/api/*.cjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "no-console": "off", // build tooling config may log
    },
  },
  {
    // CLI tools write their progress to stdout — that output is the whole
    // interface (the migration runner, the OpenAPI exporter). The `no-console`
    // rule targets application code, where the structured logger is mandatory.
    files: ["apps/api/src/tools/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // ── Ignores (root-level, checked first) ──
  {
    ignores: [
      "**/node_modules/**",
      "**/.expo/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/dist/**",
      // Nested checkouts of this repository — agent and IDE worktrees under the
      // project root. ESLint does not read `.gitignore`, so without these it
      // descends into a separate working copy and reports ITS files against THIS
      // config: `pnpm exec eslint .` was failing on a raw-hex-colour error from
      // `.kilo/worktrees/charm-shop/mobile/App.tsx`, a file that is not part of
      // this repository's source at all. A gate that fails for something you did
      // not write is a gate people disable.
      ".kilo/**",
      ".freebuff/**",
    ],
  },
];
