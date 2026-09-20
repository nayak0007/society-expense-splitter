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
> (`societyexpense://`), SecureStore and the Google sign-in sheet need a dev
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
| Redirect URLs                                    | `societyexpense://auth/callback`, `societyexpense://**`    | Email links and the Google sheet return here. Without these the links land on the Site URL in a browser and the app never sees the session. |
| Email templates (Confirm signup, Reset password) | token-hash form (below)                                    | Survives mail-client link rewriting; the app verifies it with `verifyOtp`.                                                                  |
| Providers → Google                               | enabled, with iOS/Android client IDs                       | Google sign-in (T025/T032).                                                                                                                 |
| SMTP                                             | configured for any non-test environment                    | Supabase's built-in SMTP is rate-limited and not for production.                                                                            |

Token-hash template body:

```
{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup&redirect_to=societyexpense://auth/callback
```

Use `type=recovery` in the _Reset password_ template. Supabase's default
fragment-based links also work (`#access_token=…&type=recovery` is handled
explicitly), but the token-hash form is the recommended one.

### 3. Migrations

```bash
npx supabase login
npx supabase link --project-ref <ref>
npx supabase db push            # apply supabase/migrations/*.sql
npx supabase db push --dry-run  # to preview first
```

Without the CLI, paste each file from `supabase/migrations/` into the SQL editor
in filename order — they are idempotent. See `supabase/README.md` for why auth
SQL is applied by Supabase rather than Drizzle.

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
pnpm --filter @ses/api test:e2e   # boots the real Nest app (no database needed)
```

`pnpm lint:arch` is the one to run deliberately rather than reflexively: it is a
resolved-module-graph check, so it catches things ESLint structurally cannot — a
package reaching a database driver three imports deep, or a cycle. Its rules are
deliberately narrow and each one was verified to actually fire on a planted
violation; a boundary rule that silently matches nothing looks identical to a
passing one.

Coverage gates are per path, not one global number (SAD §15.2): the financial core
is held to 100%, use cases to 90%, everything else to 80%. `@ses/api` enforces its
thresholds today. `@ses/domain` does not yet, because `money.ts` is still the
`Paise` placeholder that T012 replaces — a 100% gate on it now would fail for a
reason unrelated to whoever broke the build.

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

`init.sql` creates the three extensions, the Supabase-compatible roles
(`authenticator`, `authenticated`, `anon`) and the `auth` schema shim that the
committed RLS policies call. **Without it every policy evaluates false and the API
appears to work while seeing an empty database.** If you started the stack before
that file existed, the init script will not re-run — delete the volume and bring
it up again.

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
pnpm db:migrate   # apply migrations (uses MIGRATION_DATABASE_URL)
pnpm db:reset     # drop and re-apply — local only
```

The API's own schema lives in `apps/api/drizzle.config.ts`; the Supabase-side auth
and RLS SQL is applied by Supabase (see the section above), which is why there are
two migration histories.

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
