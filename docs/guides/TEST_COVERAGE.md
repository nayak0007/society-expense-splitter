# Test coverage — the gate, its thresholds, and what it does not yet reach

Roadmap **T014** · SAD §15.2 (unit tests) and §16.2 (the CI job). The gate is
[`coverageThreshold`](https://jestjs.io/docs/configuration#coveragethreshold-object)
in each package's Jest config, enforced by Jest's exit code.

## 1. The commands

```bash
pnpm test:coverage                          # authoritative: every package, from the root
pnpm --filter @ses/api test:coverage:unit   # lightweight: the API unit suite, no Docker
pnpm --filter @ses/api test:integration     # the API integration suite alone (needs Docker)
pnpm --filter @ses/api test:e2e             # the API e2e suite alone (needs nothing)
pnpm --filter @ses/domain test:coverage     # one package, while iterating
pnpm --filter @ses/domain test              # the same suite with no coverage
```

`pnpm test:coverage` is `turbo run test:coverage`. The three pure packages run
`jest --coverage`; `@ses/api` runs the **unified** measurement — unit +
integration + e2e merged from the raw Istanbul maps by Jest's native
multi-project coverage (`apps/api/jest-coverage.config.cjs`; no `istanbul-merge`,
no averaging of percentages). Because the integration project is part of that run,
the authoritative command **requires a container runtime**: without one the
integration `globalSetup` fails with its staged message and Jest exits non-zero
before any test runs, so a partial number cannot be mistaken for the gate.
There is no wrapper script and no second config: **the number CI compares is the
number a developer sees locally**, because it is the same command in the same
package directory.

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
| `**/dues-calculator*`                              | `packages/domain/jest.config.js` (T067)           | 100 / 100 |
| `**/payment-allocator*`                            | **not declared** — see §5                         | 100 / 100 |
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
| `@ses/api`          |      82.08 |    70.01 |     87.26 | 81.95 | **pass** — see §4 |

> **Post-fix re-run (2026-09-30, join-approval role correction).** The corrected-role fix added eight integration tests and one translation line in the member adapter; the gate now measures `@ses/api` at **82.38 / 70.46 / 87.57 / 82.28** (2,372/2,879 · 1,076/1,527 · 557/636 · 2,258/2,744) over **40 suites / 743 tests**, and `pnpm test:coverage` still exits 0. The thresholds are unchanged; the figures above are the T014 snapshot that closed the gap.

> **T060 re-measure (2026-10-01, expense schema).** T060 adds no production API code — only a migration, the `@ses/db-schema` column modules and one integration spec — so `@ses/api` measures the same **82.38 / 70.46 / 87.57 / 82.28** over **41 suites / 779 tests** (743 + the 36 expense-schema tests), and `pnpm test:coverage` still exits 0. `@ses/split-engine` stays **100 / 100 / 100 / 100** over **16 suites / 194 tests** (its task replays from the Turbo cache, T059's measurement unchanged), `@ses/domain` 15 suites / 397 tests, `@ses/application` 9 suites / 257 tests. No threshold, exclusion or measured-file set changed.

So `pnpm test:coverage` exits 0 today and the CI test job is green. `@ses/api` is
measured over its complete automated test surface (unit + integration + e2e, §4);
the row was not lowered, scoped or excluded to get there — the missing coverage
was real unreached production behaviour, and it was closed with the repository
integration tests §4 describes. One number is worth watching: branches clear the
70% floor by **two counters** (1,069 of the 1,067 required), so a refactor that
removes a handful of covered branches would flip the gate red. That is recorded
rather than pre-empted by padding assertions.

The `@ses/domain` figure is not the number its `global` row is checked against.
Jest excludes any file matched by a more specific row from `global`, so the
domain's enforced global covers 26 of its 29 files: **87.99 / 89.96 / 81.29 /
89.68**.

### Which packages participate

Exactly the four that own a unit suite: `@ses/domain`, `@ses/application`,
`@ses/split-engine` and `@ses/api`. `pnpm test:coverage` runs `test:coverage` in
every workspace that defines it — Turbo reports `4 successful, 4 total`.

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

## 4. The `@ses/api` measurement

### The unified measurement (executed 2026-09-30, T014)

`@ses/api`'s gate is the **merged** unit + integration + e2e run
(`apps/api/jest-coverage.config.cjs`): Jest reads each project's raw Istanbul
counters and merges them by file, so a statement executed by any layer counts as
covered — no averaging, no `istanbul-merge`. It has been executed repeatedly with
identical results: **40 suites / 735 tests green** (295 unit + 107 integration +
333 e2e), ~65 s wall clock. Before the repository-integration remediation the same
run read 35 suites / 648 tests (295 unit + 20 integration + 333 e2e); the 87 added
tests are the repository specs in §4.1.

| Metric     |     Merged (authoritative) | SAD §15.2 | Result          |
| ---------- | -------------------------: | --------: | --------------- |
| Statements | **82.08%** (2,363 / 2,879) |       80% | **met**, +2.08p |
| Branches   | **70.01%** (1,069 / 1,527) |       70% | **met**, +0.01p |
| Functions  |     **87.26%** (555 / 636) |       80% | **met**, +7.26p |
| Lines      | **81.95%** (2,248 / 2,743) |       80% | **met**, +1.95p |

Per layer, each measured with the same declared file set
(`<rootDir>/src/**/*.ts`, minus `*.d.ts` and `__tests__/`):

| Layer                    | Statements |  Branches | Functions |     Lines | Files reported |
| ------------------------ | ---------: | --------: | --------: | --------: | -------------: |
| unit (no infrastructure) |      35.37 |     35.95 |     24.53 |     34.44 |             92 |
| integration (T034)       |      56.32 |     39.57 |     48.93 |     56.36 |             91 |
| e2e                      |      48.74 |     24.10 |     48.85 |     49.98 |             92 |
| **merged**               |  **82.08** | **70.01** | **87.26** | **81.95** |        **100** |

The integration row moved from 30.22 / 6.46 / 14.99 / 30.52 to the figures above —
the single largest change in the history of this gate, and the reason the merged
row now clears it. Nothing else about the model changed.

Each layer was measured with its own run and its own output directory, so no
layer can overwrite another's report:

```bash
pnpm --filter @ses/api test:coverage:unit   # unit → coverage/unit-only (no Docker)
pnpm --filter @ses/api exec jest --config jest-integration.config.cjs \
  --coverage --coverageDirectory=coverage/integration   # needs Docker
pnpm --filter @ses/api exec jest --config jest-e2e.config.cjs \
  --coverage --coverageDirectory=coverage/e2e
```

The per-layer denominators differ because Jest enumerates “untested” files from
each project's own haste map (`roots`), not from the declared glob alone: only the
unit project (roots = `src`) enumerates files no suite imports, so
`tools/migrate.ts` and the other entrypoints appear in the unit report and not in
the e2e one; several `*.module.ts` files run the other way (loaded by the
integration and e2e projects, never enumerated by the unit project). The **merge
is the union of every layer's map** — 100 files with counters, per-file statement
totals equal to the maximum across layers (verified on all 100 files, no phantom
entries).

**File-set proof.** The declared universe on disk is 101 files. The merged report
contains 100 files and zero files outside that universe. The single absent file
is `src/infrastructure/database/schema.ts` — a `export * from "@ses/db-schema"`
re-export with no executable statements of its own, for which Istanbul produces no
counters in any layer, so its absence changes no metric. Every other declared file
is present, including the ones **no** suite executes: eight files sit in the
merged report at **0 covered lines** — `main.ts` (0/12), `worker.ts` (0/19),
`common/paths.ts` (0/7), `config/migration-env.ts` (0/9), `config/tool-env.ts`
(0/8), `tools/export-openapi.ts` (0/18), `tools/migrate.ts` (0/83) and
`tools/reset.ts` (0/20). A merge that dropped unloaded files would have inflated
every percentage above; this one counts them in the denominator.

### What closed it (T014's remediation)

The ruling from the first merged measurement held: the deficit was real unreached
production behaviour, concentrated in the persistence boundary, and the right
instrument was the **T034 Testcontainers stack**, not more assertions against
fakes. Five repository specs were added against real PostgreSQL 18, the real
17-migration chain, the real `UnitOfWork` and real RLS — no mocked driver, SQL,
transaction manager or cache:

| Adapter                             |    New tests |
| ----------------------------------- | -----------: |
| `member.repository.ts`              |           29 |
| `society.repository.ts`             |           18 |
| `apartment.repository.ts`           |           20 |
| `invitation.repository.ts`          |           11 |
| `building.repository.ts` (adjacent) |            9 |
| **integration suite**               | **20 → 107** |

They assert adapter _behaviour_: the directory's filters, search, ordering and
totals; the join queue and its claims; `create`/`update` where an absent field
means “column default” and `null` means “clear”; `createMany`'s savepoint-per-row
batch that skips a duplicate label and rolls the whole batch back on anything
else; the guard reads; the join/leave state machine; the invitation funnel and its
single-use acceptance; and every database refusal read as the module's own error
code, never as a driver message. The change, in covered counters:

| Metric     | Before | After | Gain |
| ---------- | -----: | ----: | ---: |
| Statements |  1,844 | 2,363 | +519 |
| Branches   |    727 | 1,069 | +342 |
| Functions  |    398 |   555 | +157 |
| Lines      |  1,754 | 2,248 | +494 |

**What is still uncovered, ranked, so the next task can pick it up honestly.**
Uncovered lines: `invitation.rows.ts` (33) and `member.rows.ts` (31) — error
translators only reached through the paths that happen to raise;
`tools/migrate.ts` (83, process shell), `building.repository.ts` (35),
`membership-cache.redis.ts` (31), `migrations/runner.ts` (27),
`tools/reset.ts` (20), `worker.ts` (19), `config/validation.schema.ts` (18),
`tools/export-openapi.ts` (18), then small remainders in `society.rows.ts` (16),
`society.repository.ts` (18) and `apartment.repository.ts` (13). Uncovered branches
follow the same shape — translators first, then the Redis and migration
infrastructure, then the process shell. None of it is a rule the gate needs
lowered to survive: the row passes, and a second campaign would be about running
_new_ infrastructure (Redis, the migration CLI) rather than turning assertions on
for their own sake.

### The unit-only measurement

`pnpm --filter @ses/api test:coverage:unit` runs the unit suite alone, against the
same declared file set, and is still what the three groups below describe. Its
numbers are **35.37 / 35.95 / 24.53 / 34.44**:

1. **The SAD §15.4 integration surface.** Repositories
   (`src/modules/*/infrastructure/*.repository.ts`, `*.rows.ts`),
   `src/infrastructure/database/unit-of-work.ts`, the Redis membership cache
   (`membership-cache.redis.ts`, `redis.service.ts`), `database.service.ts`, the
   migration runner and `src/config/**` validation. These need a real Postgres
   and a real Redis — the Testcontainers layer SAD §15.4 specifies and Roadmap
   **T034** owns (and which now exists and runs in the gate above). Mocking them
   would test the mock, which is why they are not unit-tested.
2. **The request pipeline's outer shell** — `main.ts`, `bootstrap.ts`,
   `worker.ts`, `swagger.ts`, `api-exception.filter.ts`,
   `request-context.interceptor.ts`, `ctx.decorator.ts`. These run once per
   process or once per request and are exercised end to end instead.
3. **Controllers, module operations and mappers**
   (`*.controller.ts`, `src/modules/*/application/*.operations.ts`,
   `*.mapper.ts`), covered by the 333-test e2e suite and the live matrix.

**What was deliberately not done:** no `collectCoverageFrom` narrowing, no
`/* istanbul ignore */`, no exclusion of the API from the gate, and no threshold
change.

### History of this gate

The gate was unit-only when T014 first wired it, which is why the earlier
iteration of this section read 35.37 and argued about reachability. T034 then
executed the integration suite and the unit + integration merge (**50.76 / 41.25 /
35.84 / 50.14**, 24 suites / 315 tests) and found two real defects in the merged
config, both fixed: Jest ignores project-level options the root must own, so (1)
the integration specs ran in parallel and truncated each other's fixtures — four
`rls` failures, a 52 s lock-contention run — until `maxWorkers: 1` sat at the
root, and (2) the denominator was “whatever the suites loaded”, which pulled six
`test/**` helpers in and omitted every source no test imports, until the same
`collectCoverageFrom` the unit gate uses was declared at the root. The first
merged figure (55.18) was measured before (2) and is not comparable with the gate.

T014 then added the e2e project to the same merge and made it the package's
authoritative `test:coverage` (and therefore the root command's API row). The
measured result was then 64.05 / 47.60 / 62.57 / 63.94 — red on the real number
rather than scoped to a suite the row was never about — and it stayed that way
until the repository-integration remediation above closed the gap with real
database tests. The row now reads **82.08 / 70.01 / 87.26 / 81.95** and the root
command exits 0.

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
| `**/payment-allocator*`                | `packages/domain/src/payment/` (T079's `allocator.service.ts`) | no `allocator.service.ts` yet        |
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

| Proof                    | Method                                                                                                               | Result                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `global` row             | `pnpm --filter @ses/domain exec jest --coverage --coverageThreshold='{"global":{...,"lines":95}}'` (domain is 91.23) | `Coverage for lines (92.37%) does not meet "global" threshold (95%)`              |
| path/glob row            | same command, adding `"./src/shared/result*": {"lines":100,"branches":100}` (result.ts is 22.22 lines / 0 branches)  | named the resolved absolute path of `result.ts`, both metrics                     |
| 100% package row         | a temporary uncovered `packages/split-engine/src/threshold-probe.ts` (deleted immediately after)                     | all four metrics reported against the 100% row                                    |
| real failure, raised bar | a temporary `statements: 95` in `apps/api/jest.config.cjs`, then `pnpm --filter @ses/api test:coverage`              | `Coverage for statements (82.07%) does not meet "global" threshold (95%)`, exit 1 |
| satisfied                | the real `test:coverage` runs for every package, and at the root                                                     | exit 0 with the thresholds in place                                               |

The `--coverageThreshold` flag overrides the config for one run only. The
temporary `statements: 95` edit was reverted immediately after the run, so the
row enforced today is the documented 80/70/80/80; `git diff` on the config is the
check. The planted split-engine file was the other single exception and is gone.

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
