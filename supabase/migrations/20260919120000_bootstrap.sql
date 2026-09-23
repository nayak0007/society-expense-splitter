-- 20260919120000_bootstrap.sql
--
-- The history's self-sufficiency base (ADR-0008): everything the rest of the
-- migration set assumes about its host, stated here so the set applies to a
-- *stock* Postgres — CI containers, a self-managed RDS, a fresh local volume —
-- and not only to a database Supabase's CLI has already touched.
--
-- HOW IT DECIDES WHAT TO RUN: the `is_supabase` check looks for the
-- `supabase_auth_admin` role, which exists only on hosted Supabase (the
-- platform's auth service owns `auth.users` and `auth.uid()` there, under a
-- role a migration connection must not and cannot take over). On a hosted
-- project the platform-specific branch is skipped entirely; on a stock host it
-- recreates just enough of Supabase's *interface* for the committed policies
-- to run.
--
-- Every statement is guarded (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DO $$…$$`)
-- so the same history applies in both places without forking, and re-running a
-- partially-applied file after a failed migration is safe.
--
-- Down (run by hand; runner is forward-only). On a stock host only:
--   DROP FUNCTION IF EXISTS auth.create_local_user(text, text, boolean);
--   DROP FUNCTION IF EXISTS auth.role();
--   DROP FUNCTION IF EXISTS auth.uid();
--   DROP TABLE IF EXISTS auth.users;
--   -- roles, schemas and extensions are intentionally left: dropping them is
--   -- destructive on hosted Supabase and harmless in a disposable container.

-- ─────────────────────────────────────────────────────────────────────────────
-- Extensions (T007) — before any migration that needs them
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid, digest
CREATE EXTENSION IF NOT EXISTS citext;    -- case-insensitive email columns
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- trigram search on member names

-- ─────────────────────────────────────────────────────────────────────────────
-- The Supabase role model
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The whole RLS set is `TO authenticated` and `REVOKE ... FROM anon`, so these
-- roles must exist before the first policy statement.
DO $$
DECLARE
  is_supabase boolean :=
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT;
    -- Password only when THIS file created the role, i.e. never on hosted
    -- Supabase (where the platform owns the role and its password). Matches
    -- DATABASE_URL in apps/api/.env.example. Local and CI only.
    IF NOT is_supabase THEN
      ALTER ROLE authenticator PASSWORD 'authenticator';
    END IF;
  END IF;
END
$$;

-- The role-switch chain: the API logs in as `authenticator`, then each
-- transaction does `SET LOCAL ROLE authenticated` (ADR-0007). Without this
-- grant every request fails with "permission denied to set role". Idempotent:
-- GRANT to an already-granted member is a notice, not an error.
GRANT anon, authenticated, service_role TO authenticator;

-- ─────────────────────────────────────────────────────────────────────────────
-- Schema grants — the grants every later migration assumes
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The committed RLS files previously depended on the *host* to have granted
-- USAGE on `public` and `auth` (true on Supabase, true locally only because
-- init.sql had run on an empty data directory). Stated here so the history is
-- self-contained. Object privileges stay per-migration; DDL remains owner-only.
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth   TO anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- The `auth` shim — stock-Postgres hosts only
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Recreates the Supabase *interface* the committed policies call:
-- `auth.users` (for the profiles triggers), `auth.uid()` (24 policy
-- expressions), `auth.role()`. The whole block is skipped on hosted Supabase:
-- the platform owns these objects under `supabase_auth_admin`, and a
-- `CREATE OR REPLACE FUNCTION auth.uid()` from the migration connection would
-- fail with "must be owner of function" — a platform-internal replaced by a
-- migration would be worse than the failure.
DO $$
DECLARE
  is_supabase boolean :=
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin');
BEGIN
  IF is_supabase THEN
    RAISE NOTICE 'Supabase host detected: skipping the auth shim (platform owns auth.*).';
    RETURN;
  END IF;

  CREATE TABLE IF NOT EXISTS auth.users (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email              citext UNIQUE,
    phone              text UNIQUE,
    raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    raw_app_meta_data  jsonb NOT NULL DEFAULT '{}'::jsonb,
    email_confirmed_at timestamptz,
    phone_confirmed_at timestamptz,
    is_anonymous       boolean NOT NULL DEFAULT false,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    last_sign_in_at    timestamptz
  );

  -- Heal a stale shim: local volumes created by older init.sql revisions lack
  -- columns this history depends on (the email column among them — the
  -- profiles backfill reads u.email and fails without it). `CREATE TABLE IF
  -- NOT EXISTS` cannot evolve an existing table; these ADDs bring any earlier
  -- shape up to date. No-ops on a fresh host and on Supabase (skipped above).
  EXECUTE 'ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email citext';
  EXECUTE 'ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone text';
  EXECUTE 'ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS raw_user_meta_data jsonb NOT NULL DEFAULT ''{}''::jsonb';
  EXECUTE 'ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS raw_app_meta_data jsonb NOT NULL DEFAULT ''{}''::jsonb';
  EXECUTE 'ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz';
  EXECUTE 'ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS phone_confirmed_at timestamptz';
  EXECUTE 'ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT false';
  EXECUTE 'ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()';
  EXECUTE 'ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()';
  EXECUTE 'ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS last_sign_in_at timestamptz';
  -- The unique constraint on email may also be missing on a stale shim (the
  -- old shape had none); IF NOT EXISTS guards re-runs.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_email_key' AND conrelid = 'auth.users'::regclass
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON auth.users (email)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_phone_key' AND conrelid = 'auth.users'::regclass
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS users_phone_key ON auth.users (phone)';
  END IF;

  EXECUTE 'COMMENT ON TABLE auth.users IS ''LOCAL/CI SHIM for Supabase auth.users. Supabase owns this table on hosted projects.''';

  -- `auth.uid()` — the function every RLS policy calls. Read order matches
  -- Supabase's own implementation; both GUCs are read because the two Supabase
  -- versions differ and the API sets both (ADR-0007 `applyIdentity`).
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION auth.uid()
    RETURNS uuid LANGUAGE sql STABLE
    AS $body$
      SELECT coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
      )::uuid
    $body$;
  $fn$;

  -- Not used by any committed policy today; present so a policy written
  -- against it fails for the right reason locally (NULL) rather than
  -- "function does not exist".
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION auth.role()
    RETURNS text LANGUAGE sql STABLE
    AS $body$
      SELECT coalesce(
        nullif(current_setting('request.jwt.claim.role', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
      )
    $body$;
  $fn$;

  EXECUTE 'GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role';
END
$$;

-- Default privileges for tables the later migrations create: reachable by
-- `authenticated`, then filtered by whichever policy the same PR adds. `anon`
-- is deliberately excluded — there is no anon-facing table in this project
-- (the mobile app always carries a session), and a forgotten REVOKE leaks
-- while a forgotten GRANT returns an obvious error.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Local helper: create a user without Supabase
-- ─────────────────────────────────────────────────────────────────────────────
--
-- On a stock host, users have to be minted by hand to exercise the
-- `handle_new_user()` trigger; nothing in the API may write to `auth.users`,
-- and rightly so. Not granted to `authenticated` or `anon` on purpose — a
-- function that mints identities is a backdoor if any request role can call
-- it. Invoke as the owner:
--
--   psql "$MIGRATION_DATABASE_URL" -c "select auth.create_local_user('a@b.test', 'Asha')"
--
-- Returns the new user's id — the value to pass as `app.user_id` /
-- `request.jwt.claims.sub` when probing policies by hand.
DO $$
DECLARE
  is_supabase boolean :=
    EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin');
BEGIN
  IF is_supabase THEN RETURN; END IF;

  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION auth.create_local_user(
      user_email text,
      full_name  text DEFAULT NULL,
      confirmed  boolean DEFAULT true
    )
    RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = ''
    AS $body$
    DECLARE
      new_id uuid;
    BEGIN
      -- The cast must be spelled `::public.citext`: with `search_path=''` (the
      -- hardening above) an unqualified `::citext` fails with `type "citext"
      -- does not exist` — pg_catalog is implicit but `public` is not. (Found
      -- by actually calling this function; it errored on first use.)
      INSERT INTO auth.users (email, raw_user_meta_data, email_confirmed_at)
      VALUES (
        user_email::public.citext,
        jsonb_strip_nulls(jsonb_build_object('full_name', full_name)),
        CASE WHEN confirmed THEN now() ELSE NULL END
      )
      RETURNING id INTO new_id;

      RETURN new_id;
    END;
    $body$;
  $fn$;

  EXECUTE 'COMMENT ON FUNCTION auth.create_local_user(text, text, boolean) IS ''LOCAL/CI ONLY. Creates an auth.users row for testing the profiles trigger without Supabase.''';
END
$$;
