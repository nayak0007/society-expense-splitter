# Test coverage — the gate, its thresholds, and what it does not yet reach

Roadmap **T014** · SAD §15.2 (unit tests) and §16.2 (the CI job). The gate is
[`coverageThreshold`](https://jestjs.io/docs/configuration#coveragethreshold-object)
in each package's Jest config, enforced by Jest's exit code.

## 1. The command

```bash
pnpm test:coverage                       # every package, from the repo root
pnpm --filter @ses/domain test:coverage  # one package, while iterating
pnpm --filter @ses/domain test           # the same suite with no coverage
```

`pnpm test:coverage` is `turbo run test:coverage`, and every package's
`test:coverage` is `jest --coverage`. There is no wrapper script and no second
config: **the number CI compares is the number a developer sees locally**, because
it is the same command in the same package directory.

**Exit code is the gate.** Non-zero means at least one threshold was missed; Jest
prints one line per missing metric, e.g.

```
Jest: Coverage for branches (84.79%) does not meet "global" threshold (70%)
```

Do not read the table and decide for yourself — the table shows every collected
file, while a threshold row covers only its own files (see §3).

## 2. The thresholds

SAD §15.2's table, with the row-by-row home in this repository:

| SAD row                                            | Enforced in                                       | Metric    |
| -------------------------------------------------- | ------------------------------------------------- | --------- |
| `packages/split-engine/**`                         | `packages/split-engine/jest.config.js` (`global`) | 100 / 100 |
| `packages/domain/src/shared/money*`                | `packages/domain/jest.config.js`                  | 100 / 100 |
| `packages/domain/src/member/permission-evaluator*` | `packages/domain/jest.config.js`                  | 100 / 100 |
| `**/payment-allocator*`, `**/dues-calculator*`     | **not declared** — see §5                         | 100 / 100 |
| `apps/api/src/modules/**/use-cases/**`             | **not declared** — see §5                         | 90 / 85   |
| everything else                                    | `global` in each config                           | 80 / 70   |

`@ses/split-engine` uses `global` rather than a path pattern because the row is
the whole package and a global row cannot be silently vacuous. The other three
packages also pin `functions` and `statements` at their `global` figure (80, or
100 for the split engine) — the SAD table has only Lines and Branches columns,
but pinning the two extra metrics at the same number means no metric is left
open behind the two that are named.

### Current result (measured 2026-09-30)

| Package             | Statements | Branches | Functions | Lines | Gate              |
| ------------------- | ---------: | -------: | --------: | ----: | ----------------- |
| `@ses/domain`       |      89.70 |    91.27 |     84.83 | 91.23 | **pass**          |
| `@ses/application`  |      88.18 |    82.21 |     94.44 | 90.48 | **pass**          |
| `@ses/split-engine` |        100 |      100 |       100 |   100 | **pass**          |
| `@ses/api`          |      35.37 |    35.95 |     24.52 | 34.44 | **fail** — see §4 |

So `pnpm test:coverage` exits non-zero today, and the CI job `Unit tests with
coverage` is red. That is the honest state of the repository, not a broken gate:
`@ses/api` is measured at what it is, and its threshold is not lowered to match.

The `@ses/domain` figure is not the number its `global` row is checked against.
Jest excludes any file matched by a more specific row from `global`, so the
domain's enforced global covers 26 of its 29 files: **87.99 / 89.96 / 81.29 /
89.68**.

### Which packages participate

Exactly the four that own a unit suite: `@ses/domain`, `@ses/application`,
`@ses/split-engine` and `@ses/api`. `pnpm test:coverage` runs `test:coverage` in
every workspace that defines it — Turbo reports `3 successful, 4 total` today
because the fourth, `@ses/api`, fails.

Three packages are **not** in the gate, and none of them is excluded to make a
number look better:

- **`packages/contracts`** — Zod schema declarations with no Jest config and no
  test script. SAD §15.2's scope line does not name it (it names `packages/domain`,
  `packages/split-engine`, use cases, mappers, hooks and utilities). Wiring a
  suite for it is its own task, not a threshold.
- **`packages/db-schema`** — Drizzle table definitions; same position, and the
  schema's real verification is the migration history `pnpm db:check` and the CI
  `test-db` job already apply to a live Postgres.
- **`apps/mobile`** — SAD §15.3 component tests are a separate layer, and the
  React Native preset says so itself
  (`packages/config/jest-preset/react-native.js`: the platform setup, RNTL
  matchers and `setupFilesAfterEnv` land "with the first component test").
  Roadmap T014's own status records the same gap for the auth screens. Nothing
  here changed that.

## 3. How a threshold row actually matches

Two behaviours cost time to discover and are worth writing down:

- **A row that matches no collected file fails the run outright**, it does not sit
  dormant:
  `Jest: Coverage data for ./src/payment/** was not found.`
  Jest resolves the row as a path prefix first and a glob second, and errors
  before any comparison when nothing matches. This is why a gate cannot be
  declared ahead of the code it protects (§5).
- **Glob rows are resolved against the process working directory**, not `rootDir`
  (`path.resolve(thresholdGroup)` in `@jest/reporters`). Every runner here —
  `pnpm --filter`, Turbo, CI — sets the cwd to the package directory, so
  `./src/...` rows mean what they look like. Adding a row with a path that
  escapes the package would be resolved relative to the caller's cwd instead, so
  don't.
- **`global` excludes files claimed by another row.** A file matched by
  `./src/shared/money*` is checked against that row only.

## 4. The `@ses/api` deficit

Measured: **35.37 statements / 35.95 branches / 24.52 functions / 34.44 lines**
(818 of 2,375 lines). The four threshold lines above are the only reason this run
fails — there is no configuration artifact left in it (an earlier glob that
matched nothing, `./src/modules/**/use-cases/**`, produced a _second_,
differently-shaped failure and was removed in T014; see §5).

This is genuine uncovered production code, in three groups:

1. **The SAD §15.4 integration surface.** Repositories
   (`src/modules/*/infrastructure/*.repository.ts`, `*.rows.ts`),
   `src/infrastructure/database/unit-of-work.ts`, the Redis membership cache
   (`membership-cache.redis.ts`, `redis.service.ts`), `database.service.ts`, the
   migration runner and `src/config/**` validation. These need a real Postgres
   and a real Redis — the Testcontainers layer SAD §15.4 specifies and Roadmap
   **T034** owns. Mocking them would test the mock, which is why they are not
   unit-tested now.
2. **The request pipeline's outer shell** — `main.ts`, `bootstrap.ts`,
   `worker.ts`, `swagger.ts`, `api-exception.filter.ts`,
   `request-context.interceptor.ts`, `ctx.decorator.ts`. These run once per
   process or once per request and are exercised end to end instead.
3. **Controllers, module operations and mappers**
   (`*.controller.ts`, `src/modules/*/application/*.operations.ts`,
   `*.mapper.ts`), covered by the 333-test e2e suite and the live matrix.

**What would turn it green:** the integration-test surface, not more assertions
against fakes. Concretely: Testcontainers Postgres + Redis in the CI job SAD
§16.2 calls `test-integration`, fixtures that apply the real migration set, and
Nest testing modules that boot the real repositories — then the unit and
integration coverage figures are read together, or the API's row is scoped to
what its unit suite can honestly own. Either way it is a decision that belongs
with T034, not a number to lower here.

**What was deliberately not done:** no `collectCoverageFrom` narrowing, no
`/* istanbul ignore */`, no exclusion of the API from the gate, and no threshold
change.

### The arithmetic, once the integration layer exists (updated 2026-09-30)

The infrastructure half of T034 has landed — see
`docs/guides/INTEGRATION_TESTS.md` — so "add integration tests" is no longer a
plan, and the honest question is whether the 80% row is reachable at all. By line
count from the measured report above:

| Category                                                                    |     Lines | Covered now | Ceiling if a suite owned it |
| --------------------------------------------------------------------------- | --------: | ----------: | --------------------------: |
| B — integration surface (repositories, cache, runner, `UnitOfWork`, health) |     1,342 |         398 |                       1,342 |
| A — unit-testable boundary (common, config, observability)                  |       572 |         382 |                         572 |
| C — presentation (controllers, mappers, route metadata)                     |       273 |          38 |                   273 (e2e) |
| D — process shell (entrypoints, CLI tools, CLI env)                         |       188 |           0 |               0 (by nature) |
| **total**                                                                   | **2,375** |     **818** |                           — |

So `unit + integration`, both at **complete** coverage of A and B and nothing
else, tops out at **82.2%** — passing, but with no room: the row would be green
only while _every_ non-presentation, non-bootstrap file stayed almost fully
covered, and the first untested branch in a repository would put it back under.
Adding the e2e suite's controller coverage (C) lifts the same ceiling to **92%**,
which is the comfortable shape. Two conclusions follow, and neither is a threshold
change:

1. **`@ses/api` coverage must eventually be measured over unit + integration +
   e2e**, because the 80% row is a statement about the package and no single suite
   sees more than about half of it.
2. **The default gate is still unit-only today**, deliberately. The merged
   measurement exists as `pnpm --filter @ses/api test:coverage:integrated`
   (`apps/api/jest-coverage.config.cjs`, Jest's native multi-project coverage —
   no `istanbul-merge`), and it is **not** wired into `test:coverage`, for one
   recorded reason: it would make the gate require a container runtime, and the
   gate must stay runnable (and meaningful) without Docker.
   **The merge itself has now been executed** (2026-09-30, T034): 24 suites / 315
   tests green, `@ses/api` **50.76 statements / 41.25 branches / 35.84 functions /
   50.14 lines** — a 15.4-point statements lift over the unit-only 35.37, still
   below the 80/70 row. Executing it found two real defects in that config, both
   fixed: Jest ignores project-level options the root must own, so (1) the
   integration specs ran in parallel and truncated each other's fixtures — four
   `rls` failures, a 52 s lock-contention run — until `maxWorkers: 1` sat at the
   root, and (2) the denominator was “whatever the suites loaded”, which pulled six
   `test/**` helpers in and omitted every source no test imports, until the same
   `collectCoverageFrom` the unit gate uses was declared at the root. The first
   merged figure (55.18) was measured before (2) and is not comparable with the
   gate; 50.76 is the number on the gate's own file set.

Consequence for the numbers above: the API figures in §2 are the **unit** suite's,
and remain what the gate computes. The integration suite has now run (and the merged
figure is 50.76/41.25/35.84/50.14), so the next step is measured rather than planned:
the row needs the e2e suite's controller coverage in the merge (conclusion 1) before
it can pass.

### Still not covered, and why (T034's own scope)

T034 as written in the roadmap is the **auth** integration suite: "Every endpoint
covered for happy path, 401, 422 and rate-limit cases · Login lockout escalation
verified · Token rotation and reuse detection verified". **Those endpoints do not
exist in this API.** Auth is Supabase-backed by design: `apps/api/src/modules/auth/**`
has never existed, the only auth code here is the JWKS _verifier_
(`src/common/auth/supabase-jwt.ts`) and the guard chain, and T022/T025/T026/T027
are all marked 🟡 Partial in the roadmap for that reason — its own words: "Supabase
ows the single-use token and its TTL; the outbox-style token table and
`token_version` invalidation belong to the self-hosted API path (T026) and are not
needed while Supabase Auth issues tokens." A rate-limit or lockout assertion would
therefore be testing the Supabase platform, not this repository. The integration
suite covers the auth _boundary_ that does exist — verified tokens, the guard
chain, and membership resolved from real rows — and no more.

## 5. Rows that are not declared yet, and why

**Jest will not hold a threshold for code that does not exist** (§3). Each row
below is therefore recorded here and belongs to the task that creates the file,
because the moment the first file appears, the row is one line in that package's
config:

| Row                                    | Where it will live                                             | Why it is absent                     |
| -------------------------------------- | -------------------------------------------------------------- | ------------------------------------ |
| `**/payment-allocator*`                | `packages/domain/src/payment/` (T079's `allocator.service.ts`) | no `src/payment/` directory yet      |
| `**/dues-calculator*`                  | `packages/domain/src/payment/` (T080)                          | same                                 |
| `apps/api/src/modules/**/use-cases/**` | `apps/api/jest.config.cjs`                                     | no `use-cases/` directory in the API |

**The use-case row has also drifted from the code.** SAD §15.2 scopes 90 / 85 to
`apps/api/src/modules/**/use-cases/**`; the use cases actually live in
`@ses/application`, under `src/<feature>/use-cases/**`. Holding them to 90 / 85
where they are is a decision for whoever owns that consolidation, because two of
the four directories are below it today (statements / branches):

| Directory              | Statements | Branches |
| ---------------------- | ---------: | -------: |
| `structure/use-cases`  |      83.55 |       75 |
| `invitation/use-cases` |      91.42 |    82.69 |
| `member/use-cases`     |      89.77 |    84.79 |
| `society/use-cases`    |      91.66 |    89.47 |

Re-pointing the row without closing those would fail `@ses/application`, so it is
recorded rather than done silently.

## 6. Proof that the gate enforces

Configured numbers are not evidence. Each shape was made to fail on purpose, and
every one of these exits was non-zero:

| Proof                 | Method                                                                                                               | Result                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `global` row          | `pnpm --filter @ses/domain exec jest --coverage --coverageThreshold='{"global":{...,"lines":95}}'` (domain is 91.23) | `Coverage for lines (92.37%) does not meet "global" threshold (95%)` |
| path/glob row         | same command, adding `"./src/shared/result*": {"lines":100,"branches":100}` (result.ts is 22.22 lines / 0 branches)  | named the resolved absolute path of `result.ts`, both metrics        |
| 100% package row      | a temporary uncovered `packages/split-engine/src/threshold-probe.ts` (deleted immediately after)                     | all four metrics reported against the 100% row                       |
| real, current failure | `pnpm --filter @ses/api test:coverage`                                                                               | four `does not meet "global" threshold` lines                        |
| satisfied             | the real `test:coverage` runs for domain, application and split-engine                                               | exit 0 with the thresholds in place                                  |

The `--coverageThreshold` flag overrides the config for one run only, which is why
these proofs left no trace in the tree. The planted file was the single exception
and is gone; `git status` is the check.

## 7. Where the outputs go

`packages/config/jest-preset/base.js` sets
`coverageReporters: ["text", "json-summary", "lcov"]`:

- `text` — the terminal table, the one to read when a threshold is missed;
- `json-summary` — what the CI pull-request comment is rendered from
  (`scripts/ci/coverage-comment.mjs`);
- `lcov` — editor gutters and any future coverage service.

Written to each package's `coverage/`, which is gitignored (`coverage/` in
`.gitignore`, so the pattern covers every depth). Turbo declares
`outputs: ["coverage/**"]` for the task, so a cache hit restores the reports the
comment needs. **Never commit these** — `*.info` and `coverage-final.json`
contain absolute paths from the machine that ran the tests.

## 8. Exclusions

The only files excluded from collection are:

- `*.d.ts` — declarations have no executable behaviour;
- anything under `__tests__/` — test files and the fakes, fixtures and
  `support/` helpers beside them are not production code.

Both live in the shared preset, so they are identical in every package. No
package, file or directory was excluded to make a number pass.
