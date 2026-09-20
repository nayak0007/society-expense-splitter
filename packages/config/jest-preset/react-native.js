/**
 * SES React Native Jest preset.
 *
 * Inherits the SWC transform from `base.js`, which handles both `.ts` and `.tsx`.
 * What is still missing before component tests can run is the React Native
 * platform setup (`react-native` preset, RNTL matchers, a `setupFilesAfterEnv`
 * that installs them) — that lands with the first component test, together with
 * the `apps/mobile/jest.config.js` that will spread this object.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...require("./base"),
  displayName: "ses/react-native",
  testEnvironment: "node",
  testMatch: ["**/__tests__/**/*.test.tsx", "**/__tests__/**/*.test.ts"],
};
