# ADR-0008 · One migration system: the ordered SQL is the source of truth, applied by the project runner

**Status:** Accepted
**Date:** 2026-09-23
**Task:** closes the T016/T017 migration gap; the runtime half of T016 (Drizzle as query executor) stands
**Supersedes:** the "two migration paths" split described in `supabase/README.md` and SAD §4.5's Drizzle-migrator bullet. Builds on ADR-0007 (connection identity).

## Context

The repository had two migration mechanisms, and — the part that mattered — **neither was authoritative**:

| Path                                                  | What was supposed to happen     | What actually happened                                                                                                                              |
| ----------------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supabase/migrations/*.sql`                           | "Applied by `supabase db push`" | Applied only by a developer with a linked CLI and a hosted project. **1,631 lines of hand-written, reviewed SQL never executed by any automation.** |
| `apps/api/drizzle.config.ts` → `apps/api/migrations/` | "Applied by `pnpm db:migrate`"  | The journal directory **did not exist**; `drizzle-kit` was not even a dependency. `db:migrate` printed "No migrations to apply" and **exited 0**.   |

Three consequences, each found while building this ADR:

1. **The readiness probe could not fail.** `MigrationsIndicator` counted Drizzle's journal against Drizzle's migrations table — neither existed — so `/health/ready` reported `migrations: up` in every environment, including one with no schema at all. A probe that cannot fail launders the exact deployment failure it exists to catch.
2. **The history was not self-sufficient.** It silently assumed its host had provided the `authenticated`/`anon`/`service_role` roles, the `auth` schema and `auth.uid()` — true on hosted Supabase, true locally only because `init.sql` ran once on an empty data directory. Anywhere else the policies failed as `permission denied for schema public`.
3. **The SQL had never run, and it showed.** The first end-to-end execution (this ADR's verification) found a real bug: `20260920130100` revokes all privileges on `gen_join_code()` from `authenticated`, but `society_create` → `prepare_society()` (a SECURITY **INVOKER** trigger) calls it as the invoking user — so **society creation failed with `permission denied for function gen_join_code`**. Fixed in `20260923162920_society_gen_join_code_grant.sql`; on hosted Supabase the failure would have been identical.

## Decision

**The ordered SQL in `supabase/migrations/` is the single source of truth for the database schema, and one project-owned runner applies it in every environment.** Drizzle remains the runtime **query executor** (typed queries over postgres.js — genuinely load-bearing in `DatabaseService`/`UnitOfWork`) and stops being the schema owner and migrator. Types follow SQL, never the reverse.

The runner (`apps/api/src/infrastructure/database/migrations/runner.ts`) provides:

1. **A checksum ledger** (`ses_meta.migrations`, private schema): sha256 of every applied file, verified before every run. An edited-after-apply migration is fatal — the database does not match the repository, and proceeding would fork the schema. Neither Drizzle's relative-hash journal nor Supabase's timestamp table detects this.
2. **Prefix discipline**: the applied set must be a prefix of the sorted file list. Renames and deletions are errors, not silent re-applies.
3. **Per-file transactions**: a failed migration leaves earlier files applied and itself not applied — the next run retries exactly it. (Files needing `CONCURRENTLY` are unsupported; none exist and the scaffold header warns against one.)
4. **A single-writer advisory lock**, so racing deploy pipelines serialise instead of interleaving DDL.
5. **Owner-connection only** (`MIGRATION_DATABASE_URL`), never the runtime role (ADR-0007's privilege split), with no statement timeout — DDL is unbounded by design.

The CLI surface (`apps/api/src/tools/migrate.ts`): `apply` (default), `status`, `check` (CI/deploy gate: exit 1 unless the database exactly matches HEAD), `new <slug>` (scaffold), and `reset` (dev-only drop + re-apply).

### Where each environment applies migrations

| Environment        | Mechanism                                                                                                     | Notes                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Local dev          | `pnpm db:migrate` (the runner)                                                                                | The compose shim (`init.sql`) is no longer load-bearing for roles/policies — the bootstrap migration creates them. |
| CI                 | The runner, in the `test-db` job, + the committed RLS canary                                                  | First automated execution of the schema; `db:check` then asserts database == HEAD.                                 |
| Staging/production | The runner, in the `migrate` stage of the API image, run by `api-deploy.yml` **before** the new version rolls | The image ships its own SQL (`MIGRATIONS_DIR=/app/migrations`), so schema and code cannot diverge.                 |

**Self-sufficiency**: `20260919120000_bootstrap.sql` (the history's first file) creates the extensions, the Supabase role model and — on stock hosts only, gated on `supabase_auth_admin` not existing — the `auth` shim (`auth.users`, `auth.uid()`, `auth.role()`, `create_local_user`). On hosted Supabase every shim statement is skipped. `infra/docker/postgres/init.sql` retains only what Docker _requires_ of it (database/user creation); it is no longer referenced by any policy.

## Alternatives considered

**Adopt the Supabase CLI everywhere (`supabase db push` in local, CI, prod).** Defensible, rejected: it puts a vendor binary in every environment including the deploy pipeline, requires a linked project + platform credentials in CI, and its ledger records timestamps rather than content hashes — the edited-after-apply failure stays invisible. The direct-connection runner needs only a Postgres URL, which is also what keeps the self-managed-Postgres exit (the reason the API exists at all) real.

**Keep Drizzle as the schema owner and generate migrations from `packages/db-schema`.** Rejected: it is the status quo that produced the inert tooling, and it structurally cannot satisfy SAD §8.7 — the tenancy predicate is raw SQL against Supabase-provided roles (`auth.uid()`, `TO authenticated`) that an ORM's migration emitter cannot express, and SAD §8.8's tested-`down` requirement has no Drizzle equivalent. Generating SQL from ORM metadata and then hand-editing it produces a schema whose source of truth is "the last person who edited either file".

**Delete the SQL and start from Drizzle.** Rejected: the SQL is the most-reviewed artifact in the repository (CODEOWNERS-owned, SAD-annotated, RLS-policied). Destroying reviewed work to satisfy tooling is backwards.

**Coexist** (Supabase for `auth.*`, Drizzle for tenant tables). Rejected: this WAS the status quo. Two runners writing to one database means two ledgers that cannot see each other — a partially-applied state (schema half-migrated through each) is undetectable, which is precisely the failure the readiness probe must catch.

## Consequences

**What this buys**

- `pnpm db:migrate` applies the actual schema — verified, not claimed.
- One ledger answers "what does this database believe?" in every environment; `db:check` makes drift a failed CI run instead of a 2am incident.
- The deploy is deterministic: migrate-before-deploy runs the image's own SQL; the rewritten readiness probe (ledger count vs shipped-file count) gates traffic on real migration state.
- The history runs on any Postgres 15+ — CI container, local volume, self-managed RDS — because the bootstrap migration states its assumptions instead of inheriting them.

**What it costs**

- Forward-only: the runner has no down. Every migration documents its reverse in a comment block (SAD §8.8), applied by hand when a release must be reverted.
- Migration files are immutable after apply (checksum-enforced). Fix the bug forward with a new migration — which is exactly what the `gen_join_code` fix models.
- The checksum ledger makes trivial "one-word comment" edits to applied files fatal. That is deliberate: it forces the history to match what actually ran.
- `supabase/README.md`'s `supabase db push` instructions are now the _manual fallback_ (paste-into-SQL-editor equivalent), not the primary mechanism.

## Verification

Performed against a throwaway Postgres 18 instance on this machine, through the runner itself:

1. Fresh database → `pnpm db:migrate` → all 7 migrations applied (bootstrap included), ledger rows recorded `by postgres`.
2. `db:status` → 7 applied, 0 pending. `db:check` → `OK: database matches HEAD`. Re-`apply` → "nothing pending" (idempotent).
3. `scripts/db/rls-canary.sql` (committed; runs in CI): mints two users via the shim, creates a society through the real `society_create` RPC under the ADR-0007 preamble, asserts `auth.uid()` resolves, the member sees exactly their society, a stranger sees none, and the public join-preview resolves. **Found the `gen_join_code` bug** on its first run — the exact silent-vs-loud failure this ADR exists to force. Passes idempotently (3 consecutive runs).
4. The ADR-0007 "unobserved" caveat is thereby closed at the shim level: the identity bridge, the policies and the RPCs are observed against a real Postgres. The hosted-Supabase `auth.uid()` GUC check remains a one-time dashboard-side probe (ADR-0007 §Verification).
