/**
 * SES Node (API) ESLint preset. Extends base, allows console.warn/error.
 */
const base = require("./base");

module.exports = [
  {
    ...base,
    name: "ses/node/base",
    rules: {
      ...base.rules,
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
];
