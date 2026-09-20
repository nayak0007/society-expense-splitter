-- ═════════════════════════════════════════════════════════════════════════════
-- Local Postgres bootstrap — Roadmap T007
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Runs ONCE, on an empty data directory, as the `postgres` superuser.
--
-- ## Why this file is not just `CREATE EXTENSION`
--
-- T007 asks for `pgcrypto`, `citext` and `pg_trgm`, and it would be tempting to
-- stop there. But the migrations in `supabase/migrations/` are written for
-- Supabase, and they depend on three things that a stock Postgres image does not
-- have:
--
--   1. `auth.uid()` — called by 24 policy expressions.
--   2. `auth.users` — the table `public.profiles.id` references, with triggers on
--      INSERT and UPDATE.
--   3. The roles `anon` and `authenticated` — every policy is `TO authenticated`,
--      and the RLS migrations `REVOKE ... FROM anon`, which fails outright if the
--      role does not exist.
--
-- Without them, `pnpm db:migrate` fails on the first statement — or worse, in a
-- version of the schema where the grants succeed and the policies silently match
-- nothing, which presents as "the API returns empty lists".
--
-- ## This is a shim, and it is local-only
--
-- It reproduces Supabase's *interface*, not its implementation. Supabase's
-- `auth.uid()` reads the `request.jwt.claims` GUC that PostgREST sets per request;
-- this one reads the same GUC — which is precisely why the API's Unit of Work sets
-- it (see `apps/api/src/infrastructure/database/unit-of-work.ts`). That identity
-- bridge is therefore exercised locally against the same mechanism production
-- uses, rather than against a local-only shortcut.
--
-- Nothing here is applied to the hosted project: Supabase creates `auth.users` and
-- these roles itself. This file only ever runs inside the compose container.

-- ─────────────────────────────────────────────────────────────────────────────
-- Extensions (T007)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid, digest
CREATE EXTENSION IF NOT EXISTS citext;    -- case-insensitive email columns
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- trigram search on member names

-- ─────────────────────────────────────────────────────────────────────────────
-- Supabase's role model
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Supabase splits identity in two, and the split is what makes the API's
-- connection work:
--
--   authenticator   LOGIN. Can connect and nothing else. Switches into a
--                   request-scoped role per transaction.
--   authenticated   NOLOGIN. What `SET LOCAL ROLE authenticated` selects, and the
--                   role every policy and grant in the migrations names.
--   anon            NOLOGIN. The unauthenticated surface. Must exist because the
--                   RLS migrations revoke from it.
--   service_role    NOLOGIN, BYPASSRLS. Admin operations only. Never used by the
--                   request path — see `SUPABASE_SERVICE_ROLE_KEY` in the API's
--                   env schema, and why it is separate from `DATABASE_URL`.
--
-- Two logins would be a mistake to add later: the runtime connection must not be
-- able to read rows it was not authorised for, so `authenticator` is the *only*
-- role with LOGIN, and it holds no privileges of its own.
DO $$
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
    -- Password matches `DATABASE_URL` in apps/api/.env.example. Local only.
    CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD 'authenticator';
  END IF;
END
$$;

-- This single grant is what lets the API's transaction perform
-- `SET LOCAL ROLE authenticated`. Without it every request fails with
-- "permission denied to set role", which is a confusing error for a missing
-- membership.
GRANT anon, authenticated, service_role TO authenticator;

-- ─────────────────────────────────────────────────────────────────────────────
-- Schemas
-- ─────────────────────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS auth;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
-- The login role needs no privileges of its own — only the ability to switch into
-- a role that has them. USAGE on `public` is granted anyway so that a mistake
-- (running a query without `SET ROLE`) fails on the table privilege, which is a
-- legible error, rather than on the schema, which reads as a permissions bug.
GRANT USAGE ON SCHEMA public TO authenticator;

-- ─────────────────────────────────────────────────────────────────────────────
-- The `auth` schema shim
-- ─────────────────────────────────────────────────────────────────────────────

-- A subset of Supabase's `auth.users`, with exactly the columns the committed
-- migrations touch: `handle_new_user()` reads id, email, phone,
-- raw_user_meta_data, email_confirmed_at and phone_confirmed_at, and
-- `handle_user_updated()` writes those last two back into `public.profiles`.
--
-- `email` is `citext` to match `profiles.email`: a case-sensitive column here and
-- a case-insensitive one there would let `User@x.com` and `user@x.com` both
-- insert, then collide on the profile's unique index.
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

COMMENT ON TABLE auth.users IS
  'LOCAL DEVELOPMENT SHIM for Supabase auth.users. Supabase owns this table in every hosted environment.';

-- `auth.uid()` — the function every RLS policy calls.
--
-- Read order matches Supabase's own implementation, and both GUCs are read because
-- the two Supabase versions differ and the API sets both (see `applyIdentity`):
--
--   request.jwt.claim.sub   the legacy single-claim setting
--   request.jwt.claims      the whole claims document, as JSON
--
-- `current_setting(..., true)` returns NULL rather than raising when unset, so an
-- unauthenticated transaction yields NULL — and every policy compares against it
-- with `=`, which is false for NULL. That is the intended default-deny: a request
-- with no identity sees no rows, rather than all of them.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$$;

COMMENT ON FUNCTION auth.uid() IS
  'Reads the request-scoped JWT subject from the GUCs PostgREST and the API set. Local shim; Supabase provides its own.';

-- `auth.role()` is not used by any committed policy today. It is here because
-- Supabase exposes it, and a policy written against it should fail for the right
-- reason locally (a NULL role) rather than "function does not exist".
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )
$$;

GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Privileges for tables the migrations create later
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The migrations grant per table (`GRANT SELECT ON public.profiles TO
-- authenticated`), and that remains the source of truth. These defaults exist so a
-- table added without its own grant is reachable by `authenticated` — and then
-- filtered by whichever policy the same PR adds. The failure mode they prevent is
-- a new table that returns "permission denied" to every member.
--
-- `anon` is deliberately excluded, unlike on Supabase, which grants it broadly and
-- relies on RLS alone. There is no anon-facing table in this project: the mobile
-- app always carries a session. Granting the weakest role by default and then
-- needing a REVOKE to close it is the wrong default for a financial system — a
-- forgotten REVOKE leaks, whereas a forgotten GRANT returns an obvious error.
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
-- In hosted environments users arrive through Supabase Auth, which inserts into
-- `auth.users` and fires `on_auth_user_created` to create the `profiles` row. To
-- exercise that trigger locally there has to be a way to insert the row at all:
-- nothing in the API may write to `auth.users`, and rightly so.
--
-- Not granted to `authenticated` or `anon` on purpose — a function that mints
-- identities is a backdoor if any request role can call it. Invoke it as the owner:
--
--   psql "$MIGRATION_DATABASE_URL" -c "select auth.create_local_user('a@b.test', 'Asha')"
--
-- Returns the new user's id, which is the value to pass as `app.user_id` /
-- `request.jwt.claims.sub` when probing policies by hand.
CREATE OR REPLACE FUNCTION auth.create_local_user(
  user_email text,
  full_name  text DEFAULT NULL,
  confirmed  boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
-- SECURITY DEFINER so the caller does not need rights on `auth.users`, with a
-- pinned empty search_path — the Supabase-documented hardening for definer
-- functions, and the same pattern the committed migrations use.
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  new_id uuid;
BEGIN
  INSERT INTO auth.users (email, raw_user_meta_data, email_confirmed_at)
  VALUES (
    user_email::citext,
    jsonb_strip_nulls(jsonb_build_object('full_name', full_name)),
    CASE WHEN confirmed THEN now() ELSE NULL END
  )
  RETURNING id INTO new_id;

  RETURN new_id;
END;
$$;

COMMENT ON FUNCTION auth.create_local_user(text, text, boolean) IS
  'LOCAL DEVELOPMENT ONLY. Creates an auth.users row for testing the profiles trigger without Supabase.';
