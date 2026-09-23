-- rls-canary.sql — the ADR-0007 identity bridge, asserted end to end.
--
-- Run AFTER the history is applied, as the database OWNER:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/rls-canary.sql
--   (CI: docker exec -i <pg-container> psql ... -q < scripts/db/rls-canary.sql)
--
-- Proves, in order:
--   1. The bootstrap shim's create_local_user mints users.
--   2. The real `society_create` RPC works under the identity preamble.
--   3. The preamble resolves auth.uid() and filters rows per membership —
--      a wrong GUC name would fail to a SILENTLY EMPTY result, not an error.
--   4. The public join-preview resolves a live code.
--
-- MECHANICS THAT MATTER:
--   * Fixture ids are captured by psql (\gset) while connected as the OWNER,
--     before any identity transaction. Statements running as `authenticated`
--     must never reference `auth.users` directly — the role has no grant on
--     it, and the failure would masquerade as a policy bug.
--   * psql variables persist across BEGIN/COMMIT, so :'member_uid' works
--     inside every identity transaction below.
--
-- Exit semantics: any failed assertion raises; ON_ERROR_STOP exits non-zero.
-- Idempotent: fixtures are scoped to the @canary.ses.test email domain.

\set ON_ERROR_STOP on

-- ─────────────────────────────────────────────────────────────────────────────
-- Fixture helper (owner-only): remove this canary's rows, identified by email
-- domain — never real data.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION _canary_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM members    WHERE user_id    IN (SELECT id FROM auth.users WHERE email LIKE '%@canary.ses.test');
  DELETE FROM societies  WHERE created_by IN (SELECT id FROM auth.users WHERE email LIKE '%@canary.ses.test');
  DELETE FROM profiles   WHERE email LIKE '%@canary.ses.test';
  DELETE FROM auth.users WHERE email LIKE '%@canary.ses.test';
END;
$$;

SELECT _canary_reset();

-- Mint the two identities and capture their ids AS THE OWNER.
SELECT auth.create_local_user('member@canary.ses.test',   'Canary Member')   AS member_uid,
       auth.create_local_user('stranger@canary.ses.test', 'Canary Stranger') AS stranger_uid
\gset

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. auth.uid() resolves under the exact preamble the UnitOfWork issues
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);

DO $canary$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'canary: auth.uid() is NULL under the identity preamble — GUC names do not match';
  END IF;
END
$canary$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The member creates a society through the real RPC (committed row)
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);

SELECT (public.society_create(jsonb_build_object(
         'name',  'Canary Court',
         'type',  'apartment',
         'city',  'Pune',
         'state', 'MH'
       )))->>'id' AS society_id
\gset
COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Tenancy assertions — member sees exactly one, stranger sees none
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);

DO $canary$
DECLARE
  total  int;
  canary int;
BEGIN
  SELECT count(*) INTO total  FROM societies;
  SELECT count(*) INTO canary FROM societies WHERE name = 'Canary Court';
  IF total <> 1 OR canary <> 1 THEN
    RAISE EXCEPTION 'canary: member sees % societies (% canary) — expected exactly 1', total, canary;
  END IF;
END
$canary$;

SELECT set_config('app.user_id',           :'stranger_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'stranger_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'stranger_uid', true);

DO $canary$
DECLARE
  total int;
BEGIN
  SELECT count(*) INTO total FROM societies;
  IF total <> 0 THEN
    RAISE EXCEPTION 'canary: stranger sees % societies — expected 0', total;
  END IF;
END
$canary$;
ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The public join-preview resolves the live code (no identity required)
-- ─────────────────────────────────────────────────────────────────────────────
DO $canary$
DECLARE
  ok boolean;
BEGIN
  SELECT public.society_join_preview(
    (SELECT join_code FROM societies WHERE name = 'Canary Court')
  ) IS NOT NULL INTO ok;
  IF NOT ok THEN
    RAISE EXCEPTION 'canary: society_join_preview returned NULL for a live code';
  END IF;
END
$canary$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Cleanup: leave no fixture rows behind
-- ─────────────────────────────────────────────────────────────────────────────
SELECT _canary_reset();
DROP FUNCTION IF EXISTS _canary_reset();

\echo 'RLS canary passed: auth.uid() resolves, member sees own society, stranger sees none, join preview resolves.'
