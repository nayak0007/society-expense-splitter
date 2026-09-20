/**
 * SES base ESLint preset (flat config). Composed by node.js and react-native.js.
 * Rules mandated by Roadmap T003 / PRD §18:
 *  - @typescript-eslint/no-explicit-any (error) — `any` is banned, use unknown
 *  - no-console (error; API allows warn/error — see node.js)
 *  - import/no-cycle (error) — no import cycles
 *  - no-restricted-imports: cross-feature imports forbidden (applied per
 *    preset to `src/features/**` files only — app route wrappers are the
 *    composition layer and MUST import feature slices, SAD §4.2)
 */
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const eslintPluginImport = require("eslint-plugin-import");
const prettierConfig = require("eslint-config-prettier");

module.exports = {
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    parser: tseslint.parser,
    parserOptions: {
      ecmaFeatures: { jsx: true },
    },
  },
  plugins: {
    "@typescript-eslint": tseslint.plugin,
    import: eslintPluginImport,
  },
  rules: {
    ...js.configs.recommended.rules,
    ...tseslint.configs.recommended[0].rules,
    ...prettierConfig.rules,

    "@typescript-eslint/no-explicit-any": "error",
    "no-console": "error",
    "import/no-cycle": "error",

    eqeqeq: ["error", "smart"],
    "prefer-const": "error",
    "object-shorthand": ["error", "always"],
  },
  linterOptions: {
    reportUnusedDisableDirectives: true,
  },
};
