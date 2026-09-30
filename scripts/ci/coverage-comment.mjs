#!/usr/bin/env node
/**
 * Coverage summary for the pull-request comment — Roadmap T014 ("Coverage
 * reported as a PR comment").
 *
 * WHY THIS IS INFORMATIONAL AND NOT A GATE. The gate is the exit code of
 * `pnpm test:coverage`: Jest's `coverageThreshold` in each package's config
 * decides pass/fail, per path, on the machine that ran the tests. This script
 * only *reads* the `json-summary` reports those runs already wrote, so it can
 * never disagree with the gate — and it deliberately does not re-state any
 * threshold, because a second copy of a number is a second thing to keep in sync
 * (the mistake `packages/split-engine/jest.config.js` records having avoided).
 * Read the table as measurement; read the job status as the verdict.
 *
 * The `@ses/api` row is the **merged** unit + integration + e2e number
 * (`apps/api/jest-coverage.config.cjs`), i.e. the number the API's threshold row
 * is actually checked against — not the unit suite alone.
 *
 * WHY IT STILL RUNS WHEN THE GATE FAILS. That is when a comment is worth having —
 * `apps/api` is below its threshold today (see `docs/guides/TEST_COVERAGE.md`),
 * so a comment that only appeared on green runs would never appear at all.
 *
 * WHY `json-summary` AND NOT `json`. This prints a few dozen rows; the raw
 * Istanbul map it would otherwise parse is roughly a megabyte per package. The
 * reporter set lives in `packages/config/jest-preset/base.js`.
 *
 * Usage:  node scripts/ci/coverage-comment.mjs [output.md]
 *         (no argument writes to stdout)
 * Exit:   always 0. A missing report is described in the output, never fatal —
 *         a rendering failure must not be able to turn a green gate red.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, derived from this file's own location so the script does not care
 * about the caller's cwd (the same class of bug as a Jest `rootDir` assumption). */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const MARKER = "<!-- coverage-report -->";

const PACKAGES = [
  { name: "@ses/domain", dir: "packages/domain" },
  { name: "@ses/application", dir: "packages/application" },
  { name: "@ses/split-engine", dir: "packages/split-engine" },
  { name: "@ses/api", dir: "apps/api" },
];

/**
 * The individual files SAD §15.2 names at 100%, listed separately because a
 * package total hides exactly this: `@ses/domain` reads 89.7% overall while its
 * money files must be — and are — at 100%.
 */
const PINNED = [
  {
    pkg: "@ses/domain",
    label: "`src/shared/money.vo.ts`",
    suffix: `src${sep}shared${sep}money.vo.ts`,
  },
  {
    pkg: "@ses/domain",
    label: "`src/shared/money.ts`",
    suffix: `src${sep}shared${sep}money.ts`,
  },
  {
    pkg: "@ses/domain",
    label: "`src/member/permission-evaluator.ts`",
    suffix: `src${sep}member${sep}permission-evaluator.ts`,
  },
];

function readSummary(dir) {
  const path = join(ROOT, dir, "coverage", "coverage-summary.json");
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

const pct = (value) => (Number.isFinite(value) ? `${value}%` : "n/a");

/** One row of the totals table. A `total` entry is always present when the
 * report exists; `branchesTrue` is deliberately not printed — it is not a
 * metric any threshold in this repository uses. */
function totalsRow(name, summary) {
  if (summary === null) {
    return `| \`${name}\` | — | — | — | — | no report |`;
  }
  const { total } = summary;
  return `| \`${name}\` | ${pct(total.statements.pct)} | ${pct(total.branches.pct)} | ${pct(
    total.functions.pct,
  )} | ${pct(total.lines.pct)} | ${summary.total.lines.covered}/${summary.total.lines.total} lines |`;
}

function pinnedRow(entry, summary) {
  if (summary === null) {
    return `| ${entry.label} | — | — | — | — | no report |`;
  }
  const key = Object.keys(summary).find((file) => file.endsWith(entry.suffix));
  if (key === undefined) {
    return `| ${entry.label} | — | — | — | — | not collected |`;
  }
  const entryMetrics = summary[key];
  return `| ${entry.label} | ${pct(entryMetrics.statements.pct)} | ${pct(
    entryMetrics.branches.pct,
  )} | ${pct(entryMetrics.functions.pct)} | ${pct(entryMetrics.lines.pct)} | ${
    entryMetrics.lines.covered
  }/${entryMetrics.lines.total} lines |`;
}

const summaries = new Map(
  PACKAGES.map(({ name, dir }) => [name, readSummary(dir)]),
);

const jobStatus = process.env.COVERAGE_JOB_STATUS ?? "unknown";

const lines = [
  MARKER,
  "## Test coverage",
  "",
  `SAD §15.2 thresholds are enforced per path by \`coverageThreshold\` in each package's Jest config — **the gate is the exit code of \`pnpm test:coverage\`, which this run reports as \`${jobStatus}\`.** The tables below are the measurements from that run; a missed threshold is named in the job log (\`Jest: ... coverage threshold ... not met\`). \`@ses/api\` is measured over its complete automated test surface — unit + integration (Testcontainers) + e2e, merged from the raw Istanbul maps by Jest's native multi-project coverage, so a line executed by any layer counts as covered.`,
  "",
  "| Package | Statements | Branches | Functions | Lines | Covered |",
  "|---|---:|---:|---:|---:|---|",
  ...PACKAGES.map(({ name }) => totalsRow(name, summaries.get(name))),
  "",
  "### Files SAD §15.2 pins at 100%",
  "",
  "| File | Statements | Branches | Functions | Lines | Covered |",
  "|---|---:|---:|---:|---:|---|",
  ...PINNED.map((entry) => pinnedRow(entry, summaries.get(entry.pkg))),
  "",
  "`packages/split-engine/**` is pinned at 100% too; its package total *is* that row (the package is the path).",
  "",
  "<sub>Reproduce locally: `pnpm test:coverage` (requires a container runtime for `@ses/api`'s integration layer; `pnpm --filter @ses/api test:coverage:unit` is the lightweight, no-Docker run). `@ses/api` is below its global threshold on purpose — see `docs/guides/TEST_COVERAGE.md` §4.</sub>",
  "",
];

const body = lines.join("\n");
const [outputPath] = process.argv.slice(2);

if (outputPath === undefined) {
  process.stdout.write(body);
} else {
  writeFileSync(outputPath, body);
  process.stdout.write(`Wrote ${outputPath}\n`);
}
