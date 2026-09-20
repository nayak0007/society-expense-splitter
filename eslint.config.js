// @ts-check
/**
 * Root ESLint flat config. `lint-staged` runs `eslint --fix` from the repo
 * root (the workspace has no root eslint until now), so this config must
 * resolve for EVERY staged file zone: root/package CommonJS config files and
 * apps/mobile sources.
 *
 * The mobile zone deliberately mirrors apps/mobile/eslint.config.js — keep
 * the two in sync (the app copy exists so `pnpm --filter @ses/mobile lint`
 * works standalone from the app cwd).
 */
const js = require("@eslint/js");
const globals = require("globals");
const reactNativePreset = require("./packages/config/eslint-preset/react-native");

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

  // ── Ignores (root-level, checked first) ──
  {
    ignores: [
      "**/node_modules/**",
      "**/.expo/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/dist/**",
    ],
  },
];
