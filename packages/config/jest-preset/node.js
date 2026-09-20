/**
 * SES Node (API and pure packages) Jest preset.
 *
 * Tests are colocated with sources under `__tests__/`, named `*.test.ts`, which
 * is the convention SAD §15.8 and §18.1 specify ("test file beside source").
 * Integration suites that need a live database live in `apps/api/test/` instead
 * and are run by a separate config, so they are deliberately not matched here.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...require("./base"),
  displayName: "ses/node",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/__tests__/**/*.test.ts"],
};
