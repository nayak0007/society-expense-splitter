# Local Setup

> Status: the API, the local Docker stack (Postgres, Redis, MinIO) and the mobile
> app all run locally as of Roadmap T006–T008. The Supabase dashboard steps in the
> next section are still per-environment manual work.

## Prerequisites

- Node ≥ 24.16.0 (`.nvmrc`)
- pnpm ≥ 11 (`corepack enable`)
- Docker Desktop (for the local stack: Postgres, Redis, MinIO)

## Mobile app

```bash
corepack enable
pnpm install
cp apps/mobile/.env.example apps/mobile/.env
pnpm --filter @ses/mobile dev
```

Open the Expo Go app / dev client, or press `a` (Android) / `i` (iOS).

> Expo Go is fine for UI work, but **not** for auth: deep links
> (`resident360://`), SecureStore and the Google sign-in sheet need a dev
> build (`pnpm exec expo run:android` / `run:ios`, or an EAS dev client).

## Supabase

Auth is Supabase Auth (SAD §2.2), and the profile mirror plus its RLS policies
live in `supabase/migrations/`. Nothing in this section can be done from code —
it is project configuration, once per environment.

### 1. Project

1. Create a project at <https://supabase.com/dashboard>.
2. Copy **Project URL** and **anon public key** into `apps/mobile/.env`:

   ```dotenv
   EXPO_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
   EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon key>
   ```

   The app validates these at module load and refuses to boot with a readable
   error if they are missing or malformed (SAD §19.2). The anon key is public by
   design — RLS, not secrecy, is the boundary.

### 2. Auth settings (Dashboard → Authentication)

| Setting                                          | Value                                                      | Why                                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirm email                                    | **on**                                                     | PRD §3.1: sign-up sends a verification link. With it off, sign-up signs the user straight in.                                               |
| Minimum password length                          | 8                                                          | Matches `passwordSchema`; the contract is the policy of record, this is a floor.                                                            |
| Site URL                                         | production web origin (e.g. `https://app.societysplit.in`) | Supabase's fallback redirect target.                                                                                                        |
| Redirect URLs                                    | `resident360://auth/callback`, `resident360://**`          | Email links and the Google sheet return here. Without these the links land on the Site URL in a browser and the app never sees the session. |
| Email templates (Confirm signup, Reset password) | token-hash form (below)                                    | Survives mail-client link rewriting; the app verifies it with `verifyOtp`.                                                                  |
| Providers → Google                               | enabled, with iOS/Android client IDs                       | Google sign-in (T025/T032).                                                                                                                 |
| SMTP                                             | configured for any non-test environment                    | Supabase's built-in SMTP is rate-limited and not for production.                                                                            |

Token-hash template body:

```
{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup&redirect_to=resident360://auth/callback
```

Use `type=recovery` in the _Reset password_ template. Supabase's default
fragment-based links also work (`#access_token=…&type=recovery` is handled
explicitly), but the token-hash form is the recommended one.

### 3. Migrations

```bash
pnpm db:migrate                 # apply supabase/migrations/*.sql via the project runner
pnpm db:status                  # verify what the project has applied
```

The same runner is used in CI and in the deploy pipeline (ADR-0008) — see
`supabase/README.md` for the naming, immutability, manual-fallback, **rollback**
and **troubleshooting** rules.

### 4. Verify

Run `docs/guides/AUTH_E2E_CHECKLIST.md` section 1 (prerequisites), then section 3
(SQL probes) against the fresh project. Those eight probes prove the trigger, the
RLS policies, the column grants and the anon-key denial before any device is
involved.

## Quality gates

These are the same commands CI runs, in the same order:

```bash
pnpm typecheck      # tsc --noEmit, every workspace
pnpm lint           # eslint, per workspace
pnpm exec eslint .  # the root flat config, which is the only one that reaches packages/*
pnpm lint:arch      # dependency-cruiser — layer boundaries (ADR-0001)
pnpm format:check   # prettier
pnpm test           # jest, every workspace that has tests
pnpm test:coverage  # the same suites with per-path coverage thresholds enforced
pnpm --filter @ses/api test:e2e   # boots the real Nest app (no database needed)
pnpm test:integration             # real Postgres + Redis via Testcontainers (needs Docker)
```

`pnpm test:integration` starts its own containers and applies the real migration
chain, so it needs a container runtime and nothing else — no database to start by
hand, no `.env` to fill in. It fails immediately and by name without Docker rather
than falling back to mocks; see `docs/guides/INTEGRATION_TESTS.md`.

`pnpm lint:arch` is the one to run deliberately rather than reflexively: it is a
resolved-module-graph check, so it catches things ESLint structurally cannot — a
package reaching a database driver three imports deep, or a cycle. Its rules are
deliberately narrow and each one was verified to actually fire on a planted
violation; a boundary rule that silently matches nothing looks identical to a
passing one.

Coverage gates are per path, not one global number (SAD §15.2): the financial core
is held to 100%, use cases to 90%, everything else to 80%. `pnpm test:coverage`
runs them in every package — `@ses/domain`, `@ses/application`, `@ses/split-engine`
and `@ses/api` — and **exits non-zero today**: the API's unit suite measures 35%
against its 80% global row, and its threshold is deliberately not lowered.
`docs/guides/TEST_COVERAGE.md` records every number, how the gate was proven to
fail, and the work that closes the API gap.

## Git hooks

Installed automatically by `pnpm install` (husky `prepare` script):

- `pre-commit`: lint-staged (eslint --fix + prettier on staged files)
- `commit-msg`: commitlint (Conventional Commits — types and scopes in
  commitlint.config.js; note the enumerable scope list, so auth changes use
  `auth`/`mobile`)

## API + local infrastructure

### 1. Bring up the stack

```bash
pnpm dev:infra       # postgres:15, redis:7, minio — waits for healthchecks
pnpm dev:infra:down  # stop; add -v by hand to also wipe the named volumes
```

| Service              | Port                      | Notes                                                                            |
| -------------------- | ------------------------- | -------------------------------------------------------------------------------- |
| Postgres 15 (alpine) | 5432                      | `infra/docker/postgres/init.sql` runs **once**, when the data directory is empty |
| Redis 7              | 6379                      |                                                                                  |
| MinIO                | 9000 (S3), 9001 (console) | console login `ses_minio` / `ses_minio_local`                                    |

> **MinIO image carries recorded replacement debt.** The local object store is
> pinned to `bitnamilegacy/minio:2025.7.23-debian-12-r5` — an archived build.
> Upstream no longer publishes anonymous server images (verified 2026-10-07:
> `docker.io/minio/minio` and `docker.io/minio/mc` both answer `object not found`,
> `quay.io/minio/minio` refuses anonymous pull, `dl.min.io` returns 410). The tag
> is immutable on purpose — never `:latest` — and the integration suite starts the
> same image so a broken pin fails a test rather than a developer's afternoon. See
> `infra/docker/docker-compose.dev.yml` and ADR-0012 §D1 for the measurements taken
> against it.
>
> **Local and test only — not a production recommendation.** Which S3-compatible
> server leaves a VPS deployment is a separate deployment decision (still open);
> the storage port and the single S3 adapter are provider-neutral, so it is a
> configuration choice rather than a code change. See ADR-0012's deployment note.
>
> The bucket is no longer created by a `createbuckets` companion service (its `mc`
> image is one of the two that no longer exists). Set
> `STORAGE_AUTO_CREATE_BUCKET=true` in `apps/api/.env` — see the storage section of
> `apps/api/.env.example` — and the API's own storage bootstrap creates the bucket
> at boot using the SDK the adapter already ships.

`init.sql` creates the database and roles bootstrap. The schema itself —
extensions, the Supabase-compatible roles, the `auth` shim and every table and
policy — now comes from the migration history's own bootstrap file
(`20260919120000_bootstrap.sql`), applied by `pnpm db:migrate` (ADR-0008). A
stale local volume is therefore no longer load-bearing: even if `init.sql` did
not run, `pnpm db:migrate` prepares the whole surface. If you started the stack
before that file existed, delete the volume and bring it up again anyway so the
container matches the documented shape.

### 2. Configure and run the API

```bash
cp apps/api/.env.example apps/api/.env
pnpm --filter @ses/api dev      # nest start --watch on http://localhost:3000/v1
```

The process **refuses to start** on a missing or malformed variable and prints
every problem at once rather than the first one it reaches. Two traps worth
knowing:

- `PORT=` in your shell overrides `.env` (dotenv does not overwrite an existing
  variable). If the API refuses to bind, check `echo $PORT`.
- Copying `.env.example` unchanged works: blank values are treated as absent, so
  the optional vendor keys do not need to be filled in to boot.

The `.env.example` explains the two database URLs, which are not interchangeable:
`DATABASE_URL` is the runtime connection and must use the `authenticator` role, so
that each transaction can switch to `authenticated` and have the policies apply;
`MIGRATION_DATABASE_URL` is the owner connection used only for DDL. Production and
staging refuse to start if both name the same role, because an API holding owner
credentials silently disables every policy (ADR-0007).

### 3. Verify

```bash
curl -i localhost:3000/v1/health/live    # 200 — the process is up
curl -i localhost:3000/v1/health/ready   # 200 when postgres, redis and migrations are ready
```

`/v1/health/ready` returns **503 with a per-component breakdown** when something
is missing, which is what you want during setup: it names the component rather
than just reporting unready. `live` must stay green while `ready` is red — that
distinction is what stops a rolling deploy from restarting a process that is
merely waiting on a dependency.

Interactive docs: <http://localhost:3000/v1/docs>.

### 4. Database

```bash
pnpm db:migrate   # apply the schema history (uses MIGRATION_DATABASE_URL)
pnpm db:status    # applied vs pending, straight from the ledger
pnpm db:check     # exit 1 unless the database matches HEAD
pnpm db:migrate:new <slug>   # scaffold the next migration file
pnpm db:reset     # drop + re-apply — dev only, refuses in staging/production
```

There is exactly **one** migration history — `supabase/migrations/`, applied by
the project runner (ADR-0008) in local, CI and production alike. Its first file
(`20260919120000_bootstrap.sql`) creates the extensions, the Supabase-compatible
roles and the `auth` shim the RLS policies call, so a fresh Postgres needs no
manual preparation beyond an empty database. Applied migrations are immutable
(checksum-enforced) — fix forward with a new file, never edit an applied one.

To prove your local database is correctly wired, run the RLS canary:

```bash
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/rls-canary.sql
# → "RLS canary passed: auth.uid() resolves, member sees own society, stranger sees none…"
```

This is the same assertion CI runs in its `test-db` job. A wrong GUC name or a
broken policy fails here loudly instead of as an app that "works" but sees an
empty database.

> The canary is **local-only**. It writes `auth.users` through
> `auth.create_local_user`, which the bootstrap migration's `auth` shim provides;
> hosted Supabase has neither (its `auth` schema is real and owned by
> `supabase_auth_admin`), and the shim deliberately skips itself when it detects
> that. On hosted, prove the same thing with real Auth users —
> `scripts/verification/hosted-verify.mjs` (below) — never by weakening policies.

#### Hosted Supabase (staging / production)

The authoritative command is the **same** one as locally: `pnpm db:migrate`
(ADR-0008). There is no dashboard SQL editor step and no `supabase db push`; the
ledger in `ses_meta.migrations` is the one history in every environment, so local
and hosted can be diffed name-by-name and checksum-by-checksum.

Required variables (names only — never commit or print values):

| Variable                    | Role                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `MIGRATION_DATABASE_URL`    | Owner connection, used **only** for DDL and `db:*`. On hosted: the pooler in session mode (`:5432`) as `postgres.<project-ref>`. |
| `DATABASE_URL`              | Runtime connection, pooler in transaction mode (`:6543`), and **never** the owner role (ADR-0007 refuses to start otherwise).    |
| `SUPABASE_URL`              | Project URL; the JWT issuer is derived from it (`/auth/v1`).                                                                     |
| `SUPABASE_JWT_ISSUER`       | Expected `iss`; the API also checks `aud` and verifies against the live JWKS.                                                    |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side only: Supabase Admin API (verification harness), never shipped to the mobile app.                                    |
| `REDIS_URL`                 | Cache/queue; `/v1/health/ready` reports it independently of postgres, so a red Redis does not mean the database is unreachable.  |

Procedure for a hosted project:

```bash
pnpm db:status   # audit first: applied vs pending, from the hosted ledger
pnpm db:migrate  # apply ONLY the pending files, one transaction per file
pnpm db:check    # exit 0 only when the hosted database matches HEAD
```

`db:status` has to run with the working directory inside `apps/api` (the CLI
loads `apps/api/.env` relative to it). It is always safe and read-only, so run it
before and after any migration.

Environment differences worth knowing before you write a migration:

- **Version.** Hosted Supabase tracks the managed Postgres major (currently 17.x)
  while local is newer (18.x). Migrations must not depend on a PG18-only feature;
  if one does, it belongs behind a version check or a different formulation.
- **`postgres` has `BYPASSRLS`.** The managed superuser bypasses row-level
  security by design, which is why the request path is load-bearing: `UnitOfWork`
  pins the transaction to the `authenticated` role and sets the `auth.uid()`
  claims, and nothing else may query business tables. A direct owner connection
  will see every row and is not evidence that the policies are wrong.
- **Soft deletes are not hidden by RLS.** The policies deliberately do not filter
  `deleted_at` (the business layer does), so a creator keeps seeing their own
  soft-deleted societies. That is intended; do not "fix" it in a policy.

Hosted round-trips take a few seconds each, so a long serial verification run can
look stalled while it is merely slow — check progress before concluding a hang.

To verify a hosted project end-to-end (real Auth users, real JWTs, RLS A–G, the
Phase 3 smoke path), run the harness with the API environment file:

```bash
VERIFY_RUN_ID=<short-id> PORT=3010 node scripts/verification/hosted-verify.mjs --env-file=apps/api/.env
```

It creates throwaway users on a `@…verify.ses.test` domain and societies named
`ZZ-VERIFY-<run-id> …`, exercises the API against hosted, then soft-deletes its own
business rows. Auth users are left in place for manual cleanup (they are listed at
the end of the run) because the task forbids resetting Auth.

Recovery: applied migrations are immutable (checksum-enforced) — **fix forward**
with a new file, never edit one that has been applied. `pnpm db:reset` drops and
re-applies and deliberately refuses to run outside local development.

### 5. The contract

`docs/api/OPENAPI.yaml` is generated from the running code, committed, and diffed
in CI:

```bash
pnpm openapi              # regenerate it after changing any route or DTO
pnpm contract:drift       # regenerate and fail if the committed copy was stale
pnpm contract:breaking    # diff two specs for breaking changes
```

A route change is not finished until `pnpm openapi` has been run and the result is
part of the same commit — otherwise the spec silently describes an API that no
longer exists, and client code generated from it compiles against a lie.

### 6. Whole stack in Docker

`api` and `worker` are defined in the same compose file behind the `api` profile,
so the container image can be exercised without a local Node toolchain:

```bash
docker compose -f infra/docker/docker-compose.dev.yml --profile api up --build
```

There is no Docker on every development machine (and none in the environment this
foundation was built in), so the image is verified in CI rather than assumed to
work locally.
