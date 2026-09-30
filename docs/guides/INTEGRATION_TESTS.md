# Integration tests — real Postgres and Redis, via Testcontainers

Roadmap **T034** · SAD **§15.4** ("Jest + Supertest + Testcontainers (real Postgres,
real Redis, real migrations). No mocked database — a mocked database cannot catch
a broken constraint, and constraints are load-bearing here.").

## 1. Running it

```bash
pnpm --filter @ses/api test:integration     # one package
pnpm test:integration                       # turbo, every package that has one
```

The suite owns its containers: **you never start Postgres yourself**, and no
ambient `DATABASE_URL` is read. If Docker is not available it fails immediately,
by name, and does not fall back to mocks:

```
[integration:postgres] Could not find a working container runtime strategy
The container runtime is not reachable. This suite needs a working Docker …
it deliberately does NOT fall back to mocks …
```

A _unit_ run stays container-free and fast: `pnpm --filter @ses/api test`.

## 2. What is real, and what is not

| Layer                                     | Real?    | Why                                                                                                                                                              |
| ----------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL 18 (`postgres:18-alpine`)      | **real** | the same image CI's `test-db` job applies the history to; local development ran 18 too                                                                           |
| Redis 7 (`redis:7-alpine`)                | **real** | matches `infra/docker/docker-compose.dev.yml`; the membership cache runs its Redis path, not the in-memory one                                                   |
| the migration chain                       | **real** | applied by the same `withMigrations` + `applyMigrations` pair `pnpm db:migrate` calls, from `supabase/migrations`                                                |
| RLS policies, constraints, triggers, RPCs | **real** | this is the suite's whole purpose                                                                                                                                |
| `UnitOfWork`'s identity bridge            | **real** | `SET LOCAL ROLE authenticated` + the GUCs `auth.uid()` reads                                                                                                     |
| the Nest application graph                | **real** | `createTestApp({ realInfrastructure: true })` — the production `AppModule`, no repository overrides                                                              |
| Supabase **Auth**                         | no       | tokens are signed locally (`test/utils/supabase-auth.ts`); the verifier under test is the real one (issuer/audience/alg pinning), only the key material is local |
| hosted Supabase                           | no       | deliberately: the hosted project remains the platform-compatibility proof, this remains the repeatable one (§6)                                                  |

**There is no test-only schema and no compatibility fixture in this directory.**
The Supabase compatibility layer is committed production SQL:
`supabase/migrations/20260919120000_bootstrap.sql` recreates the _interface_ the
policies are written against — `auth.users`, `auth.uid()`, `auth.role()`,
`auth.create_local_user(...)`, and the `anon` / `authenticated` / `service_role` /
`authenticator` roles — behind an `is_supabase` guard that skips the whole block on
a hosted project. Because it is the history's first migration, the container runs
the identical code path a developer's `pnpm db:migrate` runs, and a stock Postgres
needs no special image.

## 3. Lifecycle

```
jest --config jest-integration.config.cjs
  └─ globalSetup (once, parent process)
       1. start postgres:18-alpine, then redis:7-alpine   ← fails by stage name
       2. apply the real migration chain under the real advisory lock
       3. write connection strings + container ids to test/.integration-env.json (gitignored)
  └─ each test file (serial)
       setupFiles → test/integration/setup-env.ts reads that file into process.env
       specs run through the real AppModule
  └─ globalTeardown → stop and remove both containers, by id
```

**Measured** (2026-09-30, `pnpm --filter @ses/api test:integration`, warm images):
postgres ready ~3–4 s · redis ready 0.4 s · 18 migrations applied 0.4 s · **115 tests
in ~40 s** · containers removed 0.7 s · **wall clock ~48 s** — the “under 3 minutes”
budget still has ample headroom with the repository specs added. A cold run adds
the image pulls (the first run ever measured `postgres ready in 23.5s`, pull
included).

Two details are load-bearing:

- **The state file, not `process.env`, crosses the process boundary.** `globalSetup`
  runs in Jest's parent process; each test file runs in a worker with its own
  environment, so mutating `process.env` in the parent reaches nobody — the
  failure would look like a flaky container (`ECONNREFUSED` against the
  placeholder URL). A file read by `setupFiles` cannot have that bug.
- **`setupFiles`, not `beforeAll`.** `ConfigModule` validates the environment at
  import time and `DatabaseService` builds its pool from `DATABASE_URL` at
  construction, so a `beforeAll` would be too late.
- **`globalTeardown`, not a teardown returned from `globalSetup`.** Jest does not
  call a function _returned_ by `globalSetup` — `@jest/core`'s `runGlobalHook`
  awaits the exported function and discards its return value, which an earlier
  revision of this suite discovered the hard way (the returned closure never ran;
  removal was silently left to Ryuk). The ids are written to the state file and
  `test/integration/global-teardown.ts` stops exactly those containers. Ryuk stays
  enabled as the crash safety net.

`maxWorkers: 1` is not a performance choice: isolation is **destructive**
(`resetData` truncates between tests), so parallel files would clear each other's
fixtures mid-test. In a multi-project run (the merged coverage command) this must be
set at the **root** — Jest ignores a project-level `maxWorkers` and warns — which is
why `apps/api/jest-coverage.config.cjs` declares it too.

## 4. Data isolation

One container per **run**, one schema, and each test starts from empty:
`resetData` truncates `auth.users` and every `public` table dynamically (so a
migration that adds a table cannot silently stop being cleared). Fixtures are
created by the owner connection — RLS-exempt by definition — and every _assertion_
runs through `UnitOfWork` as a real identity. That division is the point: a row
seeded as the owner and then asserted visible would prove nothing about a policy,
so the specs assert **absence** and **refusal** under an identity and use the owner
only for preconditions. Order-independence follows: no test depends on another's
rows, because none of them survive.

Fixtures are domain-aware rather than SQL dumps: `createLocalUser()` mints an
account through the shim's own `auth.create_local_user(...)`, and societies are
created through the real `public.society_create(...)` RPC as the user who will own
them.

## 5. What the suite covers today

| Spec                                        | Subject                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema.integration-spec.ts`                | the chain applied cleanly: nothing pending/edited/missing, one ledger row per file, filenames ordered, re-apply a no-op, the Supabase interface present, RLS enabled on every tenant table                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `unit-of-work.integration-spec.ts`          | the identity bridge (`auth.uid()` resolves; anonymous has none; system actor does not switch roles), commit persists, a thrown error rolls back, a database error rolls back, no identity leaks into the next pooled transaction, the connection returns after a failure                                                                                                                                                                                                                                                                                                                                                                 |
| `rls.integration-spec.ts`                   | member sees only its own society, stranger sees none (an empty set, never a refusal that confirms existence), anonymous sees none, a cross-tenant UPDATE matches zero rows, a pending membership is excluded, `invitations.token_hash` is unreadable while the row is readable                                                                                                                                                                                                                                                                                                                                                           |
| `member-repository.integration-spec.ts`     | the member adapter: shadow create and the column defaults, the directory's filters/search/ordering/paging-with-total, the write patch's “absent means leave, `null` means clear”, suspend/reactivate without restamping the join date, the role spelling round trip, soft removal, the join queue and its claims, approval at the requested or any corrected role (the `chk_role_caps` admission regression the spec carried as `it.failing`), the cap refusal on that path, the reviewer's own grant, cross-society refusal, the membership-cache version bump and the concurrent-approval race, and the translated constraint refusals |
| `society-repository.integration-spec.ts`    | the society adapter: the RPC-backed create (settings + creator Admin), read scoping (`null` for a non-member, never an empty roster), join preview/options over a live join code, update/rotate/soft-delete, and the join/leave state machine incl. the re-ask and the last-admin guard                                                                                                                                                                                                                                                                                                                                                  |
| `apartment-repository.integration-spec.ts`  | the flat adapter: floor/number ordering with nulls last, the assembled create/update column lists, duplicate-label conflict translation, policy refusals, soft delete, and `createMany`'s duplicate-skipping savepoints with batch rollback                                                                                                                                                                                                                                                                                                                                                                                              |
| `invitation-repository.integration-spec.ts` | the invitation adapter: the sent row with its unjoined labels, role spelling, RLS on the manager reads, revoke and its terminal state, the public preview's mask and `sent → opened` funnel step, and atomic single-use acceptance incl. expiry and recipient mismatch                                                                                                                                                                                                                                                                                                                                                                   |
| `building-repository.integration-spec.ts`   | the building adapter (adjacent, same module): display-order listing, `coalesce` patching, the per-society name conflict, floors-bound translation, policy refusals and soft delete                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

The repository specs that were the gap are now written; `docs/guides/
TEST_COVERAGE.md` §4 records what the suite still does not reach (the error
translators' rarer branches, the Redis and migration infrastructure, the process
shell).

## 6. Relationship to the other suites, and to the hosted project

Three suites, three jobs, no overlap by accident:

| Suite       | Command                                   | Seam                                          |
| ----------- | ----------------------------------------- | --------------------------------------------- |
| unit        | `pnpm --filter @ses/api test`             | everything faked, no infrastructure           |
| e2e         | `pnpm --filter @ses/api test:e2e`         | the real HTTP pipeline, **fake repositories** |
| integration | `pnpm --filter @ses/api test:integration` | the real pipeline **and** the real database   |

Hosted Supabase is a fourth thing and is not replaced by any of them. It remains
the platform-compatibility proof (real Auth, the pooler, PostgreSQL 17); this suite
is the deterministic CI proof (PostgreSQL 18, one image, no secrets, no network).
Neither substitutes for the other, and routine coverage must not depend on the
development project — see `docs/guides/TEST_COVERAGE.md` §4.

## 7. Verified, and not

**Verified by execution (2026-09-30).** The suite has run against real containers
repeatedly. It started at 3 suites / 20 tests green (14–20 s wall clock); the
repository-integration remediation added five specs, so it now stands at **8 suites
/ 115 tests green, ~46 s wall clock** (Postgres ready 3.1–4.0 s warm, Redis 0.4 s,
the migration chain 0.4–0.5 s, teardown 0.6–0.8 s). A stock
`postgres:18-alpine` image served PostgreSQL 18.6; the committed migration chain
was applied by the project runner; the teardown removed the containers and no
leftovers were observed. The same suite runs in CI (`test-integration`) and
inside the unified API coverage gate (`docs/guides/TEST_COVERAGE.md` §4).

Also verified in the environment that wrote this suite:

- `pnpm --filter @ses/api typecheck` clean, `eslint` clean;
- the config discovers exactly the eight specs
  (`jest --config jest-integration.config.cjs --listTests`);
- the multi-project coverage config resolves all three projects (8 integration +
  21 unit + 11 e2e test files);
- the no-Docker failure path was _executed_ and prints the staged message above
  instead of falling back to mocks.

**Not verified:** the suite against a hosted Supabase project. It is deliberately
runnable without one — no secret, no network dependency — and the hosted project
remains the platform-compatibility proof rather than a routine gate.
