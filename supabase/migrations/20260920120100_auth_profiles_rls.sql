-- 20260920120100_auth_profiles_rls.sql
--
-- Row Level Security for the auth module (SAD §8.7: "Applied to every tenant
-- table without exception"; SAD §2.2 principle 2: "RLS is enabled on every
-- tenant table… the application connects as a role that cannot bypass RLS").
--
-- Threat model this closes: the anon key ships in the APK. Anyone can take it
-- out of the bundle and call PostgREST directly, bypassing every guard the app
-- or the API has. RLS is therefore not defence in depth — for a Supabase-backed
-- client it is the *primary* boundary. `auth.uid()` is derived from the JWT that
-- only Supabase Auth can issue, so a client cannot claim another user's id.
--
-- Down (run by hand):
--   DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
--   DROP POLICY IF EXISTS profiles_insert_self ON public.profiles;
--   DROP POLICY IF EXISTS profiles_select_self ON public.profiles;
--   ALTER TABLE public.profiles NO FORCE ROW LEVEL SECURITY;
--   ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
-- FORCE matters: without it the table owner (the role migrations run as) skips
-- its own policies, which silently turns RLS off for anything that connects as
-- owner — the most common way an RLS setup fails open.
ALTER TABLE public.profiles FORCE ROW LEVEL SECURITY;

-- The service role (API server, admin jobs) bypasses RLS by design: it is the
-- server-side path that has already authenticated the caller. Nothing else may.

-- `(SELECT auth.uid())` rather than a bare `auth.uid()`: Postgres hoists the
-- subquery into an InitPlan and evaluates it once per statement instead of once
-- per row. This is the difference between a usable and an unusable policy on a
-- large table, and it is Supabase's own documented pattern.

DROP POLICY IF EXISTS profiles_select_self ON public.profiles;
CREATE POLICY profiles_select_self
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (id = (SELECT auth.uid()));

-- Bootstrap fallback: if the auth trigger ever fails to fire (restore from a
-- partial backup, a user created before this migration ran), the client inserts
-- its own row on first launch. The WITH CHECK pins the row to the caller, so this
-- cannot be used to create profiles for other users.
DROP POLICY IF EXISTS profiles_insert_self ON public.profiles;
CREATE POLICY profiles_insert_self
  ON public.profiles
  FOR INSERT
  TO authenticated
  WITH CHECK (id = (SELECT auth.uid()));

-- Both USING and WITH CHECK: USING decides which rows may be updated, WITH CHECK
-- re-validates the row afterwards, so an update cannot move a row to another id.
DROP POLICY IF EXISTS profiles_update_self ON public.profiles;
CREATE POLICY profiles_update_self
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (id = (SELECT auth.uid()))
  WITH CHECK (id = (SELECT auth.uid()));

-- Deliberately NO delete policy. Erasure is an account-level operation (PRD
-- §3.1 account deletion: soft-delete the user, anonymise PII, retain financial
-- rows). It runs server-side through the service role, never from a client.

-- ─────────────────────────────────────────────────────────────────────────────
-- Privileges
-- ─────────────────────────────────────────────────────────────────────────────

-- RLS filters rows; GRANTs decide which columns a client can touch at all. A
-- column-level UPDATE grant is what stops a client from writing
-- `email_verified_at`, `status` or `is_profile_complete` and marking itself
-- verified — a row-level policy alone would happily allow it.
REVOKE ALL ON public.profiles FROM anon;
REVOKE ALL ON public.profiles FROM authenticated;

GRANT SELECT ON public.profiles TO authenticated;

-- Client-editable fields only. `email`/`phone` are NOT updatable: changing an
-- identifier must go through Supabase Auth (confirmation emails, OTP) or it
-- becomes a way to take over an account. The trigger mirrors the new value once
-- Auth has verified it.
GRANT INSERT (id, email, phone, full_name, locale) ON public.profiles TO authenticated;
GRANT UPDATE (full_name, locale, avatar_url) ON public.profiles TO authenticated;

-- No DELETE for either role: the auth.users cascade is the only deletion path.
REVOKE DELETE ON public.profiles FROM authenticated;
REVOKE DELETE ON public.profiles FROM anon;
