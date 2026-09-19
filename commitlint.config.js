/**
 * Conventional Commits, enforced per SAD §18.9.
 * Types: feat fix refactor perf test docs chore ci build revert
 * Scopes: expenses payments sync auth db ui api mobile split-engine ci
 */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "refactor",
        "perf",
        "test",
        "docs",
        "chore",
        "ci",
        "build",
        "revert",
      ],
    ],
    "scope-enum": [
      2,
      "always",
      [
        "expenses",
        "payments",
        "sync",
        "auth",
        "db",
        "ui",
        "api",
        "mobile",
        "split-engine",
        "ci",
      ],
    ],
    "subject-max-length": [2, "always", 72],
    "subject-case": [0],
  },
};
