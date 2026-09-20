# Local Setup

> Status: the mobile-only workflow below is complete and current. The full local
> stack (Docker Compose: Postgres, Redis, MinIO — Roadmap T007) and the API
> (T006) are still to come.

## Prerequisites

- Node ≥ 24.16.0 (`.nvmrc`)
- pnpm ≥ 11 (`corepack enable`)
- Docker Desktop (only needed once local infra lands)

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

```bash
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm test` currently exits after a message: the Jest presets exist in
`packages/config/jest-preset`, but no suite is wired up yet (Roadmap T014).

## Git hooks

Installed automatically by `pnpm install` (husky `prepare` script):

- `pre-commit`: lint-staged (eslint --fix + prettier on staged files)
- `commit-msg`: commitlint (Conventional Commits — types and scopes in
  commitlint.config.js; note the enumerable scope list, so auth changes use
  `auth`/`mobile`)

## API + local infrastructure

Not yet scaffolded (T006/T007). This section will document `pnpm dev:infra`,
seeded buckets, and the API env file.
