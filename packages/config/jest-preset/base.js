/**
 * SES base Jest preset. Wired but minimal — per-path coverage thresholds
 * (split-engine/domain 100%, global 80%) are enforced when the test CI job
 * lands (Roadmap T014).
 */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts"],
  clearMocks: true,
};
