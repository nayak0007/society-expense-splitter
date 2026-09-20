# Supabase — auth, RLS and database migrations

This directory holds the **Supabase-native** SQL for this project: the profile
mirror of Supabase Auth identity, its triggers, and the Row Level Security
policies that protect it.

## Why a separate migration path from Drizzle

The SAD picks **Drizzle** for the API schema (SAD §2.2, `packages/db-schema`,
T017+). Drizzle owns the tenant tables.

Auth is different in one decisive way: it must **modify schemas Drizzle cannot
and must not manage** — `auth.users` triggers, `auth.uid()` policies, and the
`authenticated`/`anon` role grants. Postgres triggers on `auth.users` exist only
on Supabase, and Supabase's own migration runner is the supported way to apply
them. So:

| Concern                                                               | Owner                                                |
| --------------------------------------------------------------------- | ---------------------------------------------------- |
| `auth.*` triggers, `public.profiles`, RLS for auth-owned tables       | **this directory** (Supabase CLI)                    |
| Tenant tables (`societies`, `members`, `expenses`, …), Drizzle schema | `packages/db-schema` + `apps/api` migrations (T017+) |

Both write to the same database; they are applied by different runners. The
`profiles` table is deliberately the only table here — as Phase 3 lands, the
tenant tables move to Drizzle and only their **RLS policies** stay Supabase-side
(that mirrors SAD §8.7, where RLS is written as SQL, not as ORM metadata).

## Naming

`<UTC timestamp>_<subject>.sql`, the Supabase CLI convention. Never edit an
applied migration; add a new one (SAD §8.8: forward-only, expand → migrate →
contract, every migration ships with a tested `down`).

## Applying

```bash
# one-off
npx supabase login
npx supabase link --project-ref <your-project-ref>

# apply everything not yet applied
npx supabase db push

# inspect what would run, without touching the project
npx supabase db push --dry-run
```

Without the CLI, paste each file's contents into **Dashboard → SQL Editor** in
filename order. The SQL is idempotent (`IF NOT EXISTS` / `CREATE OR REPLACE` /
`DROP POLICY IF EXISTS`), so re-running is safe.

Every migration ends with a commented `down` block. Supabase has no automatic
rollback (`db push` is forward-only), so the `down` is applied by hand when a
release has to be reverted.
