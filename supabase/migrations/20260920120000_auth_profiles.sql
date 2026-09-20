-- 20260920120000_auth_profiles.sql
--
-- Auth module — the profile mirror of Supabase Auth identity.
--
-- WHY A MIRROR: Supabase Auth owns identity in `auth.users` (SAD §2.2: "Supabase
-- Auth's auth.uid() integrates natively with Postgres RLS policies"). `auth.*`
-- is Supabase-managed: it cannot be extended with our own columns, it is not
-- exposed through PostgREST, and it must never be read with the anon key. So the
-- app-facing half of a user lives in `public.profiles`, kept in sync by triggers.
--
-- Relationship to SAD §8.2 (`users` table): this is that table. It is named
-- `profiles` and it drops `password_hash`, because Supabase Auth already owns
-- credentials — duplicating a password column next to a managed auth schema is
-- how two sources of truth are born. Everything else in the SAD's `users`
-- definition (email, phone, status, timestamps, soft delete) is present, and
-- `auth_identities` / `devices` arrive with the OAuth and push modules (T025).
--
-- Down (run by hand — Supabase db push is forward-only):
--   DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
--   DROP FUNCTION IF EXISTS public.handle_user_updated();
--   DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
--   DROP FUNCTION IF EXISTS public.handle_new_user();
--   DROP TABLE IF EXISTS public.profiles;
--   DROP FUNCTION IF EXISTS public.touch_updated_at();
--   DROP TYPE IF EXISTS public.user_status;

-- ─────────────────────────────────────────────────────────────────────────────
-- Shared helpers (SAD §8.1)
-- ─────────────────────────────────────────────────────────────────────────────

-- SAD §8.1 defines this as the uniform `updated_at` trigger. The version bump
-- is guarded so the same function can be attached to tables that carry a
-- `version` column (optimistic locking) and those that do not.
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  IF to_jsonb(NEW) ? 'version' THEN
    NEW.version = OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.touch_updated_at() IS
  'Sets updated_at and (when the table has one) bumps version. Attached to every table carrying updated_at — SAD §8.1.';

-- Status of an account. Deliberately minimal: the states the auth module can
-- actually reach. `ALTER TYPE ... ADD VALUE` extends it when the users module
-- needs more (T017/T021) — enums can grow, they cannot shrink.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_status') THEN
    CREATE TYPE public.user_status AS ENUM ('active', 'inactive', 'deleted');
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- profiles
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.profiles (
  -- 1:1 with auth.users; deleting the auth user removes the profile.
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,

  -- Mirrored from auth.users for cheap reads and RLS. NOT the uniqueness
  -- authority: `auth.users.email` is (a second unique constraint here would
  -- break legitimate email-change flows, where the old and new value coexist
  -- briefly).
  email text,
  phone text,

  full_name text,
  avatar_url text,
  locale text NOT NULL DEFAULT 'en',

  status public.user_status NOT NULL DEFAULT 'active',

  -- Mirrors auth.users.email_confirmed_at / phone_confirmed_at so verification
  -- state is readable in one query (including inside RLS policies) rather than
  -- joining into a schema the app role should not read.
  email_verified_at timestamptz,
  phone_verified_at timestamptz,

  -- The server's answer to "is this account finished?" (SAD §5.2 routes on
  -- `user.profileComplete`). Computed in the database so the API, the RLS
  -- layer and the client cannot disagree about what "complete" means.
  -- Email OR phone satisfies the identity half: PRD §3.1 allows both, and a
  -- phone-only account must be able to complete onboarding.
  is_profile_complete boolean
    GENERATED ALWAYS AS (
      full_name IS NOT NULL
      AND length(btrim(full_name)) >= 2
      AND (email IS NOT NULL OR phone IS NOT NULL)
    ) STORED,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,

  CONSTRAINT chk_profiles_full_name CHECK (
    full_name IS NULL OR length(btrim(full_name)) BETWEEN 2 AND 120
  ),
  -- E.164 only (PRD §3.1: +91 default, 10 digits). Storing anything else makes
  -- MSG91 dispatch and WhatsApp invites guesswork.
  CONSTRAINT chk_profiles_phone_e164 CHECK (
    phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'
  ),
  CONSTRAINT chk_profiles_email_shape CHECK (
    email IS NULL OR email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  )
);

COMMENT ON TABLE public.profiles IS
  'App-facing profile mirroring auth.users. Never stores credentials — Supabase Auth owns those.';
COMMENT ON COLUMN public.profiles.is_profile_complete IS
  'Generated: full_name set and at least one identity (email/phone). SAD §5.2 routes on this.';

-- The society members list and invites search by phone (PRD §3.2); email lookup
-- happens on auth, so only phone gets an index here.
CREATE INDEX IF NOT EXISTS idx_profiles_phone
  ON public.profiles (phone) WHERE phone IS NOT NULL AND deleted_at IS NULL;

DROP TRIGGER IF EXISTS set_profiles_updated_at ON public.profiles;
CREATE TRIGGER set_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- Sync from auth.users
-- ─────────────────────────────────────────────────────────────────────────────

-- Every signup path (email/password, Google, Apple, phone OTP) inserts into
-- auth.users, so this trigger is the single place a profile comes into being —
-- including the `raw_user_meta_data.full_name` that signUp() forwards.
--
-- SECURITY DEFINER because the inserting role is `supabase_auth_admin`, which
-- has no rights on public.profiles. `SET search_path = ''` + fully-qualified
-- names is the Supabase-documented hardening for definer functions: without it a
-- caller-controlled search_path could redirect an unqualified name.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, phone, full_name, email_verified_at, phone_verified_at)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.phone,
    NULLIF(btrim(COALESCE(NEW.raw_user_meta_data ->> 'full_name', '')), ''),
    NEW.email_confirmed_at,
    NEW.phone_confirmed_at
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_new_user() IS
  'Creates the public.profiles row for a new auth.users row. ON CONFLICT keeps it idempotent for backfills.';

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Verification and email/phone changes happen on auth.users AFTER the profile
-- exists (confirming an email, changing it, verifying a phone). Mirrored here so
-- RLS and the API read one table.
CREATE OR REPLACE FUNCTION public.handle_user_updated()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.profiles
     SET email = NEW.email,
         phone = NEW.phone,
         email_verified_at = NEW.email_confirmed_at,
         phone_verified_at = NEW.phone_confirmed_at
   WHERE id = NEW.id
     AND (
       email IS DISTINCT FROM NEW.email
       OR phone IS DISTINCT FROM NEW.phone
       OR email_verified_at IS DISTINCT FROM NEW.email_confirmed_at
       OR phone_verified_at IS DISTINCT FROM NEW.phone_confirmed_at
     );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
CREATE TRIGGER on_auth_user_updated
  AFTER UPDATE ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_user_updated();

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill
-- ─────────────────────────────────────────────────────────────────────────────

-- Profiles created before this migration (or by a dashboard "add user" while the
-- trigger was absent). Idempotent, so it is safe to re-run.
INSERT INTO public.profiles (id, email, phone, full_name, email_verified_at, phone_verified_at)
SELECT
  u.id,
  u.email,
  u.phone,
  NULLIF(btrim(COALESCE(u.raw_user_meta_data ->> 'full_name', '')), ''),
  u.email_confirmed_at,
  u.phone_confirmed_at
FROM auth.users u
ON CONFLICT (id) DO NOTHING;
