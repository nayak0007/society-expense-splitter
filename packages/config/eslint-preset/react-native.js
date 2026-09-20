/**
 * SES React Native ESLint preset. Extends base with:
 *  - raw hex colours banned in .tsx (use theme tokens, SAD §3)
 *  - react-hooks and react-native plugin rules
 */
const base = require("./base");
const reactHooks = require("eslint-plugin-react-hooks");
const reactNative = require("eslint-plugin-react-native");

module.exports = [
  {
    ...base,
    name: "ses/react-native/base",
  },
  {
    name: "ses/react-native/no-cross-feature-imports",
    files: ["**/src/features/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/features/*/**"],
              message:
                "Cross-feature imports are forbidden. Shared code belongs in src/lib or packages/*.",
            },
          ],
        },
      ],
    },
  },
  {
    // TypeScript sources: the core rules below misread TS-only syntax
    // (type parameters, interface call signatures, `declare` blocks), which
    // typescript-eslint documents as false positives. `tsc` already reports
    // undefined variables, and the TS-aware rule understands the syntax.
    name: "ses/react-native/typescript-core-rule-replacements",
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      // `@typescript-eslint/no-unused-vars` is deliberately NOT restated here:
      // base.js configures it with the `^_` ignore patterns, and a bare
      // `"error"` at this level would discard them.
    },
  },
  {
    name: "ses/react-native/hex-ban-and-rn-rules",
    files: ["**/*.tsx"],
    plugins: {
      "react-native": reactNative,
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/#[0-9a-fA-F]{3,8}\\b/]",
          message:
            "Raw hex colours are banned in components — use theme tokens (see src/theme).",
        },
      ],
      "react-native/no-unused-styles": "error",
      "react-native/split-platform-components": "error",
    },
  },
  {
    name: "ses/react-native/hooks",
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
];
