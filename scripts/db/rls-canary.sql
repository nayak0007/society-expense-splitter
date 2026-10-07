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
--   4. A settings patch is APPLIED rather than silently dropped (the
--      `society_update` regression a live database found).
--   5. The public join-preview resolves a live code.
--   6. Buildings (T042): an *active* member reads, an Admin writes, a pending
--      member does neither, `deleted_at` is unreachable by DML, and the soft
--      delete both hides the row and frees its name.
--   7. Apartments and wings (T043): the same shape one level down — reads are
--      member-scoped, writes are Admin-scoped, `society_id`/`building_id` are
--      not updatable, a wing from another building is refused, a duplicate live
--      flat number is refused, and `building_soft_delete` refuses while a live
--      flat points at the building (P0001/BUILDING_HAS_APARTMENTS) and succeeds
--      once it is removed.
--   8. Roles (T046): an active Admin CAN write another member's role (the
--      `members.role` UPDATE grant works at all), an ordinary member cannot write
--      anybody's (RLS refuses the row rather than erroring), nobody can write
--      their OWN role (P0001/MEMBER_ROLE_CHANGE_FORBIDDEN), PRD §2.2's caps hold
--      as counts — 2 active treasurers, 3 active admins — an *inactive* holder
--      frees a slot, a pending or removed membership cannot be given a role, and
--      the last active Admin cannot be demoted even by the service path (the
--      deferred `chk_admin_present()`), which is the database half of Roadmap
--      T046's acceptance.
--   9. Invitations (T047): the token hash is in no SELECT grant at all, an inviter
--      cannot hand out a role they do not hold (`member.invite` may invite a
--      Resident, only `member.role_change` reaches higher), an unaddressed link
--      may not carry a role at all, a duplicate live invitation and an address
--      that already has an account here are refused, a shadow member stays
--      invite-able and is LINKED rather than duplicated, and acceptance is a
--      recipient-matched, single-use, row-locking act whose refusals are ordered
--      (state, then clock, then identity).
--  10. Join requests (T049): the request IS a `pending` row — the narrowed
--      self-join policy refuses `is_primary`, a role or a status, and
--      `members_society_user_key` makes a second row for one account in one
--      society impossible; the flat list is code-keyed, definer and member-less
--      (and not anon's); both decisions resolve the reviewer from `auth.uid()`
--      and require an active Admin or Treasurer of the request's OWN society, so
--      a replay, a pending reviewer, an ordinary resident and another society's
--      Admin all lose; a rejection needs a reason, keeps it through a re-ask and
--      loses it to the next approval; and one flat's two claims are both
--      readable while `uq_primary_occupant` refuses the second primary one.
--  11. Expense categories (T062): the nineteen seeded rows with their flags, a read
--      that is member-scoped (an active Resident sees them, a pending applicant and a
--      stranger see none), a write that is manager-scoped rather than merely
--      authenticated, `deleted_at`/`deleted_by` and `DELETE` unreachable by DML, and
--      `expense_category_soft_delete()` refusing a non-member (P0002), a member whose
--      role is not enough (P0003) and a category an expense still references
--      (P0001/CATEGORY_HAS_EXPENSES) — while succeeding on an unreferenced one.
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
  -- Order matters, and T049 added the constraint that fixes it:
  --
  --   * invitations first — `invited_by` references `members` with no cascade,
  --     so a member who invited somebody cannot be hard-deleted while the row
  --     stands;
  --   * expenses, then their categories (T062) — added after invitations for the
  --     same shape of reason: both carry a `created_by` referencing `members(id)`,
  --     and every *seeded* category has one because `seed_society()` stamps the
  --     society's creator. A member delete ahead of them fails outright, which is
  --     how this ordering was found rather than reasoned about. Expenses precede
  --     their categories because `fk_expenses_category_society` has no cascade.
  --   * members next, by society *and* by account — before the flats, because
  --     `fk_members_apartment_society` is ON DELETE SET NULL and a member who is
  --     the flat's primary occupant cannot lose `apartment_id` while
  --     `is_primary` stays true (`chk_members_primary_requires_apartment`);
  --     deleting the members first is what makes a hard flat delete possible at
  --     all. Deleting them here rather than via the society cascade is also what
  --     removes *shadow* rows, whose `user_id` is NULL and which the account
  --     filter would leave behind.
  --   * then flats, wings and buildings: `apartments_building_id_fkey` is ON
  --     DELETE RESTRICT, so a building cannot go while any flat — live or
  --     removed — points at it.

  -- Attachments before members (T071): `fk_attachments_uploaded_by (uploaded_by)`
  -- references `members(id)`, so a member delete fails outright while one
  -- attachment row still names them. It is a single-column key rather than the
  -- composite `expenses.created_by` shape — `20261013120000_attachments_uploader_fk.sql`
  -- records why (the composite form depends on `uq_members_id_society` and blocks the
  -- #19 Down-block rehearsal). The rows are also deleted before `expenses` purely for
  -- readability — the polymorphic `(entity_type, entity_id)` pair carries no foreign
  -- key, which is exactly why the row is removed here by hand rather than by a
  -- cascade.
  DELETE FROM attachments        WHERE society_id IN (SELECT id FROM societies WHERE created_by IN (SELECT id FROM auth.users WHERE email LIKE '%@canary.ses.test'));
  DELETE FROM invitations WHERE society_id IN (SELECT id FROM societies WHERE created_by IN (SELECT id FROM auth.users WHERE email LIKE '%@canary.ses.test'));
  -- Expenses and their categories, before the members they name (T062). Both carry a
  -- `created_by` that references `members(id)` — and unlike a building or a flat, every
  -- seeded category has one, because `seed_society()` stamps the creator. So this order
  -- is load-bearing rather than tidy: the member delete below fails outright while a
  -- single `expense_categories` row still points at it. Expenses first, because
  -- `fk_expenses_category_society` is a composite key with no cascade.
  DELETE FROM expenses           WHERE society_id IN (SELECT id FROM societies WHERE created_by IN (SELECT id FROM auth.users WHERE email LIKE '%@canary.ses.test'));
  DELETE FROM expense_categories WHERE society_id IN (SELECT id FROM societies WHERE created_by IN (SELECT id FROM auth.users WHERE email LIKE '%@canary.ses.test'));
  DELETE FROM members
   WHERE society_id IN (SELECT id FROM societies WHERE created_by IN (SELECT id FROM auth.users WHERE email LIKE '%@canary.ses.test'))
      OR user_id    IN (SELECT id FROM auth.users WHERE email LIKE '%@canary.ses.test');
  DELETE FROM apartments  WHERE society_id IN (SELECT id FROM societies WHERE created_by IN (SELECT id FROM auth.users WHERE email LIKE '%@canary.ses.test'));
  DELETE FROM wings       WHERE society_id IN (SELECT id FROM societies WHERE created_by IN (SELECT id FROM auth.users WHERE email LIKE '%@canary.ses.test'));
  DELETE FROM buildings   WHERE society_id IN (SELECT id FROM societies WHERE created_by IN (SELECT id FROM auth.users WHERE email LIKE '%@canary.ses.test'));
  DELETE FROM societies   WHERE created_by IN (SELECT id FROM auth.users WHERE email LIKE '%@canary.ses.test');
  DELETE FROM profiles    WHERE email LIKE '%@canary.ses.test';
  DELETE FROM auth.users  WHERE email LIKE '%@canary.ses.test';
END;
$$;

CREATE OR REPLACE FUNCTION _canary_assert(condition boolean, message text)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- A NULL condition is refused rather than treated as false. `IF NOT NULL` is `IF NULL`,
  -- which PL/pgSQL runs as "do nothing" — so an assertion whose subquery read zero rows
  -- (an identity that was never restored after `invitation_accept()` cleared it, say)
  -- would pass having checked nothing at all. That happened once; this is the fix.
  IF condition IS NULL THEN
    RAISE EXCEPTION 'canary: % (the assertion evaluated to NULL — usually an invisible row)', message;
  END IF;
  IF NOT condition THEN
    RAISE EXCEPTION 'canary: %', message;
  END IF;
END;
$$;

-- Runs `command` and reports whether the database REFUSED it.
--
-- Deliberately **not** SECURITY DEFINER: the refusing is the point, and a
-- definer function would run as the owner and bypass every policy it is meant to
-- exercise. The `EXCEPTION` block is also load-bearing — it opens a subtransaction,
-- so a refusal does not abort the surrounding transaction and the assertions after
-- it still run.
CREATE OR REPLACE FUNCTION _canary_refuses(command text)
RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE command;
  RETURN false;
EXCEPTION WHEN others THEN
  RETURN true;
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
       )))->'society'->>'id' AS society_id
\gset

-- Guards the capture itself: this read `->>'id'` (i.e. the snapshot's top level,
-- where there is no `id`) and silently yielded NULL until section 4 became its
-- first consumer.
SELECT _canary_assert(:'society_id' <> '', 'society_create did not yield a society id');
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
-- 4. A settings patch is applied, not silently dropped
--
-- The live database found this one: `society_update` accepted nine settings
-- fields, applied three, and still answered 200 with the old value. The wire
-- contract and the application layer both carry all nine, so nothing above the
-- SQL can catch a recurrence — which is why the assertion belongs here and not
-- in the mocked-repository suite, where no SQL runs at all.
--
-- Asserted on the RPC's own return value, so a filter or a mapper cannot mask
-- the result; the transaction is rolled back, leaving the fixture untouched.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);

-- Every key the contract accepts, in one patch.
SELECT public.society_update(:'society_id'::uuid, jsonb_build_object(
         'billingDay',               5,
         'dueDay',                   20,
         'graceDays',                7,
         'approvalThresholdPaise',   250000,
         'billVacantFlats',          false,
         'allowPartialPayments',     false,
         'defaulterListPublic',      true,
         'financialYearStartMonth',  1,
         'timezone',                 'Europe/London'
       )) AS patched
\gset

SELECT _canary_assert((:'patched'::jsonb)->'settings'->>'billing_day'              = '5',   'billingDay was not applied');
SELECT _canary_assert((:'patched'::jsonb)->'settings'->>'due_day'                  = '20',  'dueDay was not applied');
SELECT _canary_assert((:'patched'::jsonb)->'settings'->>'grace_days'               = '7',   'graceDays was not applied');
SELECT _canary_assert((:'patched'::jsonb)->'settings'->>'approval_threshold_paise' = '250000', 'approvalThresholdPaise was not applied');
SELECT _canary_assert((:'patched'::jsonb)->'settings'->>'bill_vacant_flats'        = 'false', 'billVacantFlats was not applied');
SELECT _canary_assert((:'patched'::jsonb)->'settings'->>'allow_partial_payments'   = 'false', 'allowPartialPayments was not applied');
SELECT _canary_assert((:'patched'::jsonb)->'settings'->>'defaulter_list_public'    = 'true',  'defaulterListPublic was not applied');
SELECT _canary_assert((:'patched'::jsonb)->'settings'->>'financial_year_start_month' = '1',  'financialYearStartMonth was not applied');
SELECT _canary_assert((:'patched'::jsonb)->'society'->>'timezone'                  = 'Europe/London', 'timezone was not applied');

-- A one-field patch must leave every other field alone (COALESCE, not overwrite).
SELECT public.society_update(:'society_id'::uuid, jsonb_build_object('graceDays', 9)) AS patched_one
\gset

SELECT _canary_assert((:'patched_one'::jsonb)->'settings'->>'grace_days' = '9',   'a single-field patch did not apply graceDays');
SELECT _canary_assert((:'patched_one'::jsonb)->'settings'->>'due_day'    = '20',  'a single-field patch reset an unrelated setting');
SELECT _canary_assert((:'patched_one'::jsonb)->'society'->>'timezone'    = 'Europe/London', 'a single-field patch reset the timezone');
ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. The public join-preview resolves the live code (no identity required)
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
-- 6. Buildings (T042) — three different gates on one table
--
-- The SELECT policy (an *active* member), the INSERT policy (an Admin), and the
-- column GRANT that keeps `deleted_at` out of every client's reach. A canary that
-- checked only the first would pass on a table every member could write.
--
-- The second identity joins through the real client path: the
-- `members_insert_self_pending` policy pins the row to `pending`/`resident`, and
-- `role` is not in the UPDATE grant, so this is the state every applicant is in
-- until T046's role RPC exists. That is exactly the membership the read policy
-- must exclude.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT auth.create_local_user('applicant@canary.ses.test', 'Canary Applicant') AS applicant_uid
\gset

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'applicant_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'applicant_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'applicant_uid', true);

INSERT INTO public.members (society_id, user_id, occupancy)
VALUES (:'society_id'::uuid, :'applicant_uid'::uuid, 'owner_occupied');

SELECT _canary_assert(
  (SELECT status FROM public.members WHERE user_id = :'applicant_uid'::uuid) = 'pending',
  'a self-insert did not land as pending — the join path is not the one asserted below'
);
COMMIT;

-- A building that exists for the assertions below, created as the OWNER so that
-- the id can be captured before any identity is in play (an applicant cannot read
-- one, by design).
INSERT INTO public.buildings (society_id, name, total_floors, display_order)
VALUES (:'society_id'::uuid, 'Canary Block', 4, 1)
RETURNING id AS building_id
\gset

-- ── a pending member: no read, no write ──────────────────────────────────────
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'applicant_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'applicant_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'applicant_uid', true);

SELECT _canary_assert(
  (SELECT count(*) FROM public.buildings) = 0,
  'a pending member can read buildings — the select policy should require an ACTIVE membership'
);
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.buildings (society_id, name) VALUES (%L, %L)',
    :'society_id', 'Applicant Block'
  )),
  'a pending member inserted a building — the insert policy is not Admin-scoped'
);
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.building_soft_delete(%L::uuid, %L::uuid)', :'building_id', :'society_id'
  )),
  'a pending member soft-deleted a building — the function does not check the Admin role'
);
ROLLBACK;

-- ── the Admin: reads, writes, and is still stopped by three rules ────────────
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);

SELECT _canary_assert(
  (SELECT count(*) FROM public.buildings) = 1,
  'the Admin cannot read the society building'
);

-- 1. a duplicate name among live buildings
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.buildings (society_id, name) VALUES (%L, %L)',
    :'society_id', 'Canary Block'
  )),
  'uq_buildings_society_name did not refuse a duplicate live name'
);
-- 2. the range check, so a typo cannot become a floor count downstream
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.buildings (society_id, name, total_floors) VALUES (%L, %L, 0)',
    :'society_id', 'Zero Floors'
  )),
  'total_floors = 0 was accepted — chk_buildings_total_floors is not enforcing'
);
-- 3. `deleted_at` is not a grantable column, so only the function can remove
SELECT _canary_assert(
  _canary_refuses(format(
    'UPDATE public.buildings SET deleted_at = now() WHERE society_id = %L',
    :'society_id'
  )),
  'a client set deleted_at directly — the column grant is not what this migration claims'
);

-- The function removes it, the row leaves every read path, and the name it held
-- becomes available again — which is why the uniqueness above is a PARTIAL index.
SELECT public.building_soft_delete(:'building_id'::uuid, :'society_id'::uuid);
SELECT _canary_assert(
  (SELECT count(*) FROM public.buildings) = 0,
  'a soft-deleted building is still readable — the select policy does not filter deleted_at'
);
INSERT INTO public.buildings (society_id, name) VALUES (:'society_id'::uuid, 'Canary Block');
SELECT _canary_assert(
  (SELECT count(*) FROM public.buildings) = 1,
  'the soft delete did not free the name — uq_buildings_society_name is not partial'
);
-- And the same id cannot be removed twice: it is no longer in that society.
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.building_soft_delete(%L::uuid, %L::uuid)', :'building_id', :'society_id'
  )),
  'a second soft delete of the same building succeeded'
);
ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Apartments and wings (T043)
--
-- Fixtures are created as the OWNER, because the ids have to be captured before
-- any identity is in play — and because a flat has to be COMMITTED for the
-- pending/stranger sections below to be asserting something rather than nothing.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO public.buildings (society_id, name) VALUES (:'society_id'::uuid, 'Canary Tower')
RETURNING id AS tower_id
\gset
INSERT INTO public.buildings (society_id, name) VALUES (:'society_id'::uuid, 'Canary Annexe')
RETURNING id AS annexe_id
\gset
INSERT INTO public.wings (society_id, building_id, name)
VALUES (:'society_id'::uuid, :'tower_id'::uuid, 'Wing R')
RETURNING id AS wing_r
\gset
INSERT INTO public.wings (society_id, building_id, name)
VALUES (:'society_id'::uuid, :'annexe_id'::uuid, 'Wing S')
RETURNING id AS wing_s
\gset

-- ── the Admin: reads, writes, and is stopped by four rules ──────────────────
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);

-- The wing policy exists although no route writes wings, so it is asserted here:
-- it is what makes the column grant below safe the day a route arrives.
INSERT INTO public.wings (society_id, building_id, name)
VALUES (:'society_id'::uuid, :'annexe_id'::uuid, 'Wing T');

INSERT INTO public.apartments (society_id, building_id, wing_id, apartment_number, floor, bhk, carpet_area_sqft, builtup_area_sqft)
VALUES (:'society_id'::uuid, :'tower_id'::uuid, :'wing_r'::uuid, 'R-101', 1, 2, 900, 1100)
RETURNING id AS flat_id
\gset

SELECT _canary_assert(
  (SELECT count(*) FROM public.apartments) = 1,
  'the Admin cannot read back the flat it just created'
);

-- 1. one live flat per number per building (`uq_apartments_building_number`)
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.apartments (society_id, building_id, apartment_number) VALUES (%L, %L, %L)',
    :'society_id', :'tower_id', 'R-101'
  )),
  'uq_apartments_building_number did not refuse a duplicate live flat number'
);
-- 2. `deleted_at` is not a grantable column: only the function removes a flat
SELECT _canary_assert(
  _canary_refuses(format(
    'UPDATE public.apartments SET deleted_at = now() WHERE society_id = %L',
    :'society_id'
  )),
  'a client set apartments.deleted_at directly — the column grant is not what this migration claims'
);
-- 3. a flat cannot be moved to another building (or another society): its members,
--    dues and history would cross a tenant boundary
SELECT _canary_assert(
  _canary_refuses(format(
    'UPDATE public.apartments SET building_id = %L WHERE id = %L',
    :'annexe_id', :'flat_id'
  )),
  'a client moved a flat to another building — building_id is not supposed to be updatable'
);
-- 4. a wing from a DIFFERENT building, which the composite FK is what refuses
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.apartments (society_id, building_id, wing_id, apartment_number) VALUES (%L, %L, %L, %L)',
    :'society_id', :'tower_id', :'wing_s', 'R-999'
  )),
  'fk_apartments_wing accepted a wing belonging to another building'
);
-- 5. the building cannot be removed while a live flat points at it — the typed
--    refusal, checked BEFORE the update so nothing is half-done
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.building_soft_delete(%L::uuid, %L::uuid)', :'tower_id', :'society_id'
  )),
  'building_soft_delete removed a building that still had a live flat'
);
COMMIT;

-- ── a pending member: no read of the structure, no flat, no wing ─────────────
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'applicant_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'applicant_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'applicant_uid', true);

SELECT _canary_assert(
  (SELECT count(*) FROM public.apartments) = 0,
  'a pending member can read apartments — the select policy should require an ACTIVE membership'
);
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.apartments (society_id, building_id, apartment_number) VALUES (%L, %L, %L)',
    :'society_id', :'tower_id', 'P-1'
  )),
  'a pending member inserted an apartment — the insert policy is not Admin-scoped'
);
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.wings (society_id, building_id, name) VALUES (%L, %L, %L)',
    :'society_id', :'tower_id', 'Applicant Wing'
  )),
  'a pending member inserted a wing — the wings insert policy is not Admin-scoped'
);
ROLLBACK;

-- ── a stranger: nothing at all, to the last function ─────────────────────────
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'stranger_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'stranger_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'stranger_uid', true);

SELECT _canary_assert(
  (SELECT count(*) FROM public.apartments) = 0,
  'a stranger can read a society apartment'
);
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.apartment_soft_delete(%L::uuid, %L::uuid)', :'flat_id', :'society_id'
  )),
  'a stranger soft-deleted an apartment — the function does not check membership'
);
ROLLBACK;

-- ── removing the flat frees its number and unblocks the building ────────────
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);

SELECT public.apartment_soft_delete(:'flat_id'::uuid, :'society_id'::uuid);
SELECT _canary_assert(
  (SELECT count(*) FROM public.apartments) = 0,
  'a soft-deleted apartment is still readable — the select policy does not filter deleted_at'
);
-- The number is free again, which is what makes the uniqueness a PARTIAL index.
INSERT INTO public.apartments (society_id, building_id, apartment_number)
VALUES (:'society_id'::uuid, :'tower_id'::uuid, 'R-101');
SELECT _canary_assert(
  (SELECT count(*) FROM public.apartments) = 1,
  'the soft delete did not free the flat number — uq_apartments_building_number is not partial'
);
-- …and the building is still not removable, because the replacement is live.
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.building_soft_delete(%L::uuid, %L::uuid)', :'tower_id', :'society_id'
  )),
  'building_soft_delete ignored a replacement flat'
);
-- Remove it too, and now the building goes — the rule is about the CURRENT
-- structure, not about history.
SELECT public.apartment_soft_delete(
  (SELECT id FROM public.apartments WHERE building_id = :'tower_id'::uuid),
  :'society_id'::uuid
);
SELECT public.building_soft_delete(:'tower_id'::uuid, :'society_id'::uuid);
SELECT _canary_assert(
  (SELECT count(*) FROM public.buildings WHERE id = :'tower_id'::uuid) = 0,
  'the building survived a soft delete that should have succeeded'
);
-- And the wing it held is untouched: nothing cascades from a soft delete.
SELECT _canary_assert(
  (SELECT count(*) FROM public.wings WHERE id = :'wing_r'::uuid) = 1,
  'a soft delete of the building removed its wing'
);
ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- T046 · Roles: the write, the caps, and the escalation refusals
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Every statement below runs under the same preamble the repositories issue, as
-- the identity a client would have: `SET LOCAL ROLE authenticated` plus the JWT
-- claims. The point is that these are the database's own refusals — no API, no
-- guard, no use case in the way.

-- ── an active Admin writes a role; the caps hold as counts ───────────────────
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);

-- Four active shadow members, through the real direct-add path (this also proves
-- the `members_insert_admin` policy still pins an insert to resident/active).
INSERT INTO public.members (society_id, display_name, phone, status) VALUES
  (:'society_id'::uuid, 'Canary S1', '+919800000901', 'active'),
  (:'society_id'::uuid, 'Canary S2', '+919800000902', 'active'),
  (:'society_id'::uuid, 'Canary S3', '+919800000903', 'active'),
  (:'society_id'::uuid, 'Canary S4', '+919800000904', 'active');

-- Counted by name rather than as "everything in the society": the creator and the
-- pending applicant are already rows here, and the assertion is about the fixtures.
SELECT _canary_assert(
  (SELECT count(*) FROM public.members
    WHERE society_id = :'society_id'::uuid
      AND display_name LIKE 'Canary S%') = 4,
  'the four role fixtures were not inserted — the admin insert policy refused them'
);

-- 1. The write itself. Before T046 `role` was not in any GRANT, so this UPDATE
--    affected zero rows and the assertion below would fail.
UPDATE public.members SET role = 'treasurer' WHERE display_name = 'Canary S1';
SELECT _canary_assert(
  (SELECT role FROM public.members WHERE display_name = 'Canary S1') = 'treasurer',
  'an Admin could not assign a role — members.role has no UPDATE grant'
);

-- 2. The treasurer cap (PRD §2.2). Two is the limit, so the second succeeds…
UPDATE public.members SET role = 'treasurer' WHERE display_name = 'Canary S2';
-- …and the third is refused.
SELECT _canary_assert(
  _canary_refuses(format(
    'UPDATE public.members SET role = %L::public.member_role WHERE display_name = %L',
    'treasurer', 'Canary S3'
  )),
  'a third active treasurer was accepted — chk_role_caps() is not enforcing PRD §2.2'
);

-- 3. An *inactive* holder does not occupy a slot: suspend one Treasurer and the
--    appointment the cap just refused goes through. This is the rule that keeps a
--    society able to replace an officer it has suspended.
UPDATE public.members SET status = 'inactive' WHERE display_name = 'Canary S2';
UPDATE public.members SET role = 'treasurer' WHERE display_name = 'Canary S3';
SELECT _canary_assert(
  (SELECT role FROM public.members WHERE display_name = 'Canary S3') = 'treasurer',
  'a suspended treasurer kept a slot — the cap counted a member who cannot act'
);

-- 4. The admin cap: the society's creator is admin #1, so two more are allowed…
UPDATE public.members SET role = 'admin' WHERE display_name = 'Canary S1';
UPDATE public.members SET role = 'admin' WHERE display_name = 'Canary S3';
SELECT _canary_assert(
  _canary_refuses(format(
    'UPDATE public.members SET role = %L::public.member_role WHERE display_name = %L',
    'admin', 'Canary S4'
  )),
  'a fourth active admin was accepted — the 3-admin cap is not enforced'
);
-- …while an inactive member may hold the role without occupying a slot.
UPDATE public.members SET role = 'admin' WHERE display_name = 'Canary S2';
SELECT _canary_assert(
  (SELECT count(*) FROM public.members WHERE role = 'admin' AND status = 'active')
    = 3,
  'the active admin count is not 3 after the cap checks'
);

-- 5. A membership that is not active cannot be given a role (P0001).
UPDATE public.members SET status = 'removed' WHERE display_name = 'Canary S4';
SELECT _canary_assert(
  _canary_refuses(format(
    'UPDATE public.members SET role = %L::public.member_role WHERE display_name = %L',
    'treasurer', 'Canary S4'
  )),
  'a removed member was given a role'
);

-- 6. Nobody changes their OWN role — the trigger, not the grant (PRD §13's
--    escalation threat, and Roadmap T046's "the caller cannot self-assign admin").
SELECT _canary_assert(
  _canary_refuses(format(
    'UPDATE public.members SET role = %L::public.member_role WHERE user_id = %L::uuid',
    'resident', :'member_uid'
  )),
  'an Admin demoted themselves — chk_member_self_change() is not refusing a self role change'
);
SELECT _canary_assert(
  (SELECT role FROM public.members WHERE user_id = :'member_uid'::uuid) = 'admin',
  'the self role change went through'
);
ROLLBACK;

-- ── an ordinary member cannot write a role at all ────────────────────────────
--
-- Two different refusals, and both matter: RLS **filters** somebody else's row
-- (an UPDATE that matches nothing, so the assertion is on the value rather than
-- on an error), while a self-write reaches `chk_member_self_change()` and raises.
-- The applicant is made active first, through the same admin update the approval
-- step will use — which is also why this block proves that an approval is a status
-- write rather than a role write.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);
INSERT INTO public.members (society_id, display_name, phone, status) VALUES
  (:'society_id'::uuid, 'Canary S5', '+919800000905', 'active');
UPDATE public.members SET status = 'active' WHERE user_id = :'applicant_uid'::uuid;
SELECT _canary_assert(
  (SELECT status FROM public.members WHERE user_id = :'applicant_uid'::uuid) = 'active',
  'an Admin could not activate a pending membership'
);

-- Now as that ordinary (active, resident) member.
SELECT set_config('app.user_id',           :'applicant_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'applicant_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'applicant_uid', true);

UPDATE public.members SET role = 'treasurer' WHERE display_name = 'Canary S5';
SELECT _canary_assert(
  (SELECT role FROM public.members WHERE display_name = 'Canary S5') = 'resident',
  'a non-admin member changed somebody else''s role — the update policy let the row through'
);

SELECT _canary_assert(
  _canary_refuses(format(
    'UPDATE public.members SET role = %L::public.member_role WHERE user_id = %L::uuid',
    'admin', :'applicant_uid'
  )),
  'a member promoted themselves to admin'
);
SELECT _canary_assert(
  (SELECT role FROM public.members WHERE user_id = :'applicant_uid'::uuid) = 'resident',
  'the self-promotion went through'
);
ROLLBACK;

-- ── the last Admin cannot be demoted, at the database level ──────────────────
--
-- Run as the OWNER (no JWT claims), which is also the service/repair path: there is
-- no `auth.uid()`, so `chk_member_self_change()` deliberately stands aside and the
-- only thing standing between a society and having no Admin is the deferred
-- `chk_admin_present()`. `SET CONSTRAINTS ALL IMMEDIATE` makes that deferred
-- constraint fire at the statement rather than at COMMIT, so the refusal is
-- observable here.
BEGIN;
SET CONSTRAINTS ALL IMMEDIATE;
INSERT INTO public.members (society_id, display_name, phone, status, role) VALUES
  (:'society_id'::uuid, 'Canary Second Admin', '+919800000906', 'active', 'admin');
-- Suspending the *other* admin is allowed while this one is active…
-- By name, not by `user_id <> creator`: a shadow member's `user_id` is NULL, and
-- `NULL <> uuid` is NULL, so a user_id filter would silently match nothing and
-- leave two admins standing — a block that tests nothing.
UPDATE public.members
   SET status = 'inactive'
 WHERE society_id = :'society_id'::uuid
   AND display_name = 'Canary Second Admin';
SELECT _canary_assert(
  (SELECT count(*) FROM public.members
    WHERE society_id = :'society_id'::uuid
      AND role = 'admin'
      AND status = 'active') = 1,
  'the second Admin was not suspended — the demotion below would not be a last-admin case'
);
SELECT _canary_assert(
  _canary_refuses(format(
    'UPDATE public.members SET role = %L::public.member_role WHERE user_id = %L::uuid',
    'resident', :'member_uid'
  )),
  'the last active Admin was demoted — chk_admin_present() did not fire on a role write'
);
ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- T047 · Invitations: a credential nobody can read back, and an acceptance
--        nobody else can perform
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Why each assertion lives here rather than above the SQL:
--
--   * `token_hash` is in **no** SELECT grant — the row is readable and the
--     credential is not, which is what "the token never leaks through a normal
--     response" has to mean at the layer that owns the column;
--   * the inviter's power is read from the matrix, not from a role name in the
--     trigger: a Treasurer holds `member.invite` but not `member.role_change`, so
--     they may invite a Resident and nothing above it;
--   * acceptance checks the **state, then the clock, then the identity**, and the
--     second attempt loses — that ordering is visible in the refusals below;
--   * a shadow member is linked, not duplicated (PRD §3.3's "linked when that phone
--     signs up");
--   * and a preview is public, masked, and opens the funnel exactly once.
--
-- Two identities are minted for the block: `invitee@` is the intended recipient of
-- the targeted invitations, and `linkee@` has a phone patched onto their profile so
-- the phone-keyed shadow path is reachable at all.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT auth.create_local_user('invitee@canary.ses.test', 'Canary Invitee') AS invitee_uid,
       auth.create_local_user('linkee@canary.ses.test',  'Canary Linkee')  AS linkee_uid
\gset

-- The phone lives on the profile (SAD §8.1 mirrors it there), and patching it is an
-- owner act — the same thing an operator would do for a number that arrived before
-- the account did.
UPDATE public.profiles SET phone = '+919800000908' WHERE id = :'linkee_uid'::uuid;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);

-- Deterministic reference hashes. The API hashes at its edge with sha256; the column
-- asks only for the shape, so two md5s are a valid stand-in for a fixture.
SELECT md5('canary invite email') || md5('canary invite email #2') AS email_hash,
       md5('canary invite link')  || md5('canary invite link #2')  AS link_hash,
       md5('canary invite stale') || md5('canary invite stale #2') AS stale_hash,
       md5('canary invite officer') || md5('canary invite officer #2') AS officer_hash,
       md5('canary invite gone')  || md5('canary invite gone #2')  AS gone_hash,
       md5('canary invite neighbour') || md5('canary invite neighbour #2') AS neighbour_hash,
       md5('canary invite phone') || md5('canary invite phone #2') AS phone_hash
\gset

-- ── the Admin invites: the row is written, and the credential is not readable ──
INSERT INTO public.invitations (society_id, apartment_id, channel, email, role, token_hash, expires_at)
VALUES (:'society_id'::uuid, :'flat_id'::uuid, 'email', 'invitee@canary.ses.test', 'resident', :'email_hash', now() + interval '14 days')
RETURNING id AS email_invitation_id, invited_by AS inviter_id
\gset

SELECT _canary_assert(
  :'inviter_id'::uuid = (SELECT id FROM public.members WHERE user_id = :'member_uid'::uuid),
  'invited_by was not resolved from the caller''s own membership'
);
SELECT _canary_assert(
  _canary_refuses('SELECT token_hash FROM public.invitations'),
  'a client can read invitations.token_hash — the credential is inside a SELECT grant'
);

-- ── four refusals, each one a rule ────────────────────────────────────────────
-- 1. a token that is not a digest: the shape CHECK, so a truncated paste cannot
--    become a row that some later lookup hashes against
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.invitations (society_id, channel, email, token_hash, expires_at) VALUES (%L, %L, %L, %L, now() + interval ''7 days'')',
    :'society_id', 'email', 'shape@canary.ses.test', 'not-a-digest'
  )),
  'chk_invitations_token_hash accepted a value that is not a sha256 hex digest'
);
-- 2. a second LIVE invitation for the same address — and in capitals, so it is the
--    citext index refusing it rather than a case-sensitive comparison
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.invitations (society_id, channel, email, token_hash, expires_at) VALUES (%L, %L, %L, %L, now() + interval ''7 days'')',
    :'society_id', 'email', 'INVITEE@canary.ses.test', :'stale_hash'
  )),
  'uq_invitations_live_email accepted a second live invitation for the same address'
);
-- 3. somebody who already has an account in this society
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.invitations (society_id, channel, email, token_hash, expires_at) VALUES (%L, %L, %L, %L, now() + interval ''7 days'')',
    :'society_id', 'email', 'member@canary.ses.test', :'stale_hash'
  )),
  'an invitation was created for somebody who already has an account in this society'
);
-- 4. an unaddressed link above Resident: whoever holds the link would hold the role
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.invitations (society_id, channel, role, token_hash, expires_at) VALUES (%L, %L, %L, %L, now() + interval ''7 days'')',
    :'society_id', 'link', 'admin', :'link_hash'
  )),
  'a shareable link invitation was created at the Admin role'
);
-- …while the same link at Resident is exactly what the rule permits, and an Admin
-- may appoint through an invitation (the matrix gives them `member.role_change`).
INSERT INTO public.invitations (society_id, channel, token_hash, expires_at)
VALUES (:'society_id'::uuid, 'link', :'link_hash', now() + interval '14 days')
RETURNING id AS link_invitation_id
\gset
INSERT INTO public.invitations (society_id, channel, email, role, token_hash, expires_at)
VALUES (:'society_id'::uuid, 'email', 'officer@canary.ses.test', 'treasurer', :'officer_hash', now() + interval '14 days')
RETURNING id AS officer_invitation_id
\gset

-- ── an ordinary member: no read, no invite. A Treasurer: invite without appoint ──
--
-- The applicant is still `pending` at this point, which makes the first half a real
-- ordinary-member case: `member.invite` is not a capability a resident holds, and a
-- pending membership holds no capabilities at all.
SELECT set_config('app.user_id',           :'applicant_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'applicant_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'applicant_uid', true);

SELECT _canary_assert(
  (SELECT count(*) FROM public.invitations) = 0,
  'a pending member can read the society''s invitations — the select policy is not manager-scoped'
);
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.invitations (society_id, channel, email, token_hash, expires_at) VALUES (%L, %L, %L, %L, now() + interval ''7 days'')',
    :'society_id', 'email', 'anyone@canary.ses.test', :'stale_hash'
  )),
  'a pending member created an invitation — the insert policy is not manager-scoped'
);

-- The same person as a Treasurer, in the two writes reality needs: activate first,
-- then appoint (a role cannot be given to a membership that is not active — T046,
-- one section up).
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);
UPDATE public.members SET status = 'active' WHERE user_id = :'applicant_uid'::uuid;
UPDATE public.members SET role = 'treasurer' WHERE user_id = :'applicant_uid'::uuid;

SELECT set_config('app.user_id',           :'applicant_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'applicant_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'applicant_uid', true);

SELECT _canary_assert(
  (SELECT count(*) FROM public.invitations) = 3,
  'a Treasurer cannot read the society''s invitations — member.invite is not what the policy reads'
);
SELECT _canary_assert(
  NOT _canary_refuses(format(
    'INSERT INTO public.invitations (society_id, channel, email, token_hash, expires_at) VALUES (%L, %L, %L, %L, now() + interval ''7 days'')',
    :'society_id', 'email', 'neighbour@canary.ses.test', :'neighbour_hash'
  )),
  'a Treasurer was refused a Resident invitation — the trigger is not reading member.invite'
);
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.invitations (society_id, channel, email, role, token_hash, expires_at) VALUES (%L, %L, %L, %L, %L, now() + interval ''7 days'')',
    :'society_id', 'email', 'second-officer@canary.ses.test', 'treasurer', :'gone_hash'
  )),
  'a Treasurer invited somebody at the Treasurer role — the trigger is not reading member.role_change'
);

-- ── the preview: public, masked, and the funnel''s second step exactly once ──────
SELECT set_config('app.user_id',           :'stranger_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'stranger_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'stranger_uid', true);

SELECT _canary_assert(
  (SELECT count(*) FROM public.invitations) = 0,
  'a non-member can read a society''s invitations'
);

SELECT public.invitation_preview(:'email_hash') AS preview
\gset
SELECT _canary_assert((:'preview'::jsonb)->>'status' = 'opened',
  'the first preview did not move the invitation to opened');
SELECT _canary_assert((:'preview'::jsonb)->>'invitee_hint' = 'in***@canary.ses.test',
  'the preview did not mask the intended recipient');
SELECT _canary_assert((:'preview'::jsonb)->>'requires_account_match' = 'true',
  'the preview lost the account-match requirement');
SELECT _canary_assert((:'preview'::jsonb)->>'society_name' = 'Canary Court',
  'the preview did not name the society');

-- A guessed token is a nonexistent invitation, and a malformed one never reaches a
-- lookup at all.
SELECT _canary_assert(
  _canary_refuses(format('SELECT public.invitation_preview(%L)', repeat('f', 64))),
  'a guessed token resolved an invitation'
);
SELECT _canary_assert(
  _canary_refuses('SELECT public.invitation_preview(''not-a-token'')'),
  'a malformed token produced a preview instead of a refusal'
);

-- Step 2 of the funnel happens once: the Admin reads the row (the stranger cannot),
-- previews again, and `opened_at` has not moved.
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);
SELECT opened_at AS opened_once FROM public.invitations WHERE id = :'email_invitation_id'::uuid
\gset
SELECT public.invitation_preview(:'email_hash');
SELECT _canary_assert(
  (SELECT opened_at FROM public.invitations WHERE id = :'email_invitation_id'::uuid) = :'opened_once'::timestamptz,
  'a second preview re-stamped opened_at — the funnel step is not idempotent'
);

-- ── acceptance: the wrong account is refused, then the right one wins once ────
SELECT set_config('app.user_id',           :'stranger_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'stranger_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'stranger_uid', true);

SELECT _canary_assert(
  _canary_refuses(format('SELECT public.invitation_accept(%L, %L::uuid)', :'email_hash', :'stranger_uid')),
  'the wrong account accepted somebody else''s invitation'
);

SELECT set_config('app.user_id',           :'invitee_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'invitee_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'invitee_uid', true);

SELECT public.invitation_accept(:'email_hash', :'invitee_uid'::uuid) AS accepted
\gset
SELECT _canary_assert((:'accepted'::jsonb)->>'role' = 'resident',
  'acceptance returned the wrong role');
SELECT _canary_assert((:'accepted'::jsonb)->>'society_id' = :'society_id',
  'acceptance returned the wrong society');
SELECT (:'accepted'::jsonb)->>'member_id' AS accepted_member_id
\gset

-- `invitation_accept()` clears the identity GUCs before writing the membership — by
-- then it is the system acting, not the invitee — so every statement after a
-- successful accept has to restore the claims it wants to act under. The clearing
-- is transaction-local by construction, which is why it is safe to do at all.
SELECT set_config('app.user_id',           :'invitee_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'invitee_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'invitee_uid', true);

-- The replay, which is the single-use rule: a row lock, not a read.
SELECT _canary_assert(
  _canary_refuses(format('SELECT public.invitation_accept(%L, %L::uuid)', :'email_hash', :'invitee_uid')),
  'the same invitation was accepted twice'
);

-- The membership it created, read back as the new member themself: active, at the
-- invited role, on the invited flat, with the join stamped. The member select policy
-- is "self or Admin", so this is the new member''s own view of their own row.
SELECT _canary_assert(
  (SELECT status FROM public.members WHERE id = :'accepted_member_id'::uuid) IS NOT DISTINCT FROM 'active'::public.member_status,
  'acceptance did not leave an active membership'
);
SELECT _canary_assert(
  (SELECT role FROM public.members WHERE id = :'accepted_member_id'::uuid) IS NOT DISTINCT FROM 'resident'::public.member_role,
  'acceptance did not assign the invited role'
);
SELECT _canary_assert(
  (SELECT apartment_id FROM public.members WHERE id = :'accepted_member_id'::uuid) IS NOT DISTINCT FROM :'flat_id'::uuid,
  'acceptance did not attach the invited flat'
);
SELECT _canary_assert(
  (SELECT joined_at FROM public.members WHERE id = :'accepted_member_id'::uuid) IS NOT NULL,
  'acceptance did not stamp joined_at'
);

-- ── expired, revoked, and the ordering of the two refusals ───────────────────
--
-- An already-expired invitation cannot be created through the API and is not
-- supposed to be: `expires_at > created_at` holds, and `created_at` is not a
-- writable column. So the fixture is inserted as the owner — with the claims still
-- set, because the inviter trigger has to resolve a real member either way.
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);
RESET ROLE;
INSERT INTO public.invitations (society_id, channel, email, token_hash, expires_at, created_at)
VALUES (:'society_id'::uuid, 'email', 'stale@canary.ses.test', :'stale_hash', now() - interval '6 days', now() - interval '20 days')
RETURNING id AS stale_invitation_id
\gset
SET LOCAL ROLE authenticated;

-- A revoked invitation, through the API''s own path (one UPDATE of `status`), with
-- the stamps the trigger owns.
INSERT INTO public.invitations (society_id, channel, email, token_hash, expires_at)
VALUES (:'society_id'::uuid, 'email', 'withdrawn@canary.ses.test', :'gone_hash', now() + interval '14 days')
RETURNING id AS revoked_invitation_id
\gset
UPDATE public.invitations SET status = 'revoked' WHERE id = :'revoked_invitation_id'::uuid;
SELECT _canary_assert(
  (SELECT revoked_at FROM public.invitations WHERE id = :'revoked_invitation_id'::uuid) IS NOT NULL,
  'revoking an invitation did not stamp revoked_at'
);
SELECT _canary_assert(
  (SELECT revoked_by FROM public.invitations WHERE id = :'revoked_invitation_id'::uuid) = (SELECT id FROM public.members WHERE user_id = :'member_uid'::uuid),
  'revoked_by was not the member who revoked it'
);
-- The state machine is one-way, and a terminal state is terminal.
SELECT _canary_assert(
  _canary_refuses(format(
    'UPDATE public.invitations SET status = %L WHERE id = %L::uuid',
    'accepted', :'revoked_invitation_id'
  )),
  'a revoked invitation moved to accepted — chk_invitation_transition() is not one-way'
);
SELECT _canary_assert(
  _canary_refuses('UPDATE public.invitations SET created_at = now()'),
  'a client rewrote invitations.created_at — the column is inside an UPDATE grant'
);

SELECT set_config('app.user_id',           :'stranger_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'stranger_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'stranger_uid', true);

SELECT public.invitation_preview(:'stale_hash') AS stale_preview
\gset
SELECT _canary_assert((:'stale_preview'::jsonb)->>'status' = 'expired',
  'an expired invitation did not preview as expired');
SELECT _canary_assert((:'stale_preview'::jsonb)->>'expired' = 'true',
  'an expired invitation did not set the expired flag');
SELECT _canary_assert(
  _canary_refuses(format('SELECT public.invitation_accept(%L, %L::uuid)', :'stale_hash', :'stranger_uid')),
  'an expired invitation was accepted'
);
-- The state is checked before the clock, and before the identity: a revoked
-- invitation is revoked even if its recipient is the right one.
SELECT _canary_assert(
  _canary_refuses(format('SELECT public.invitation_accept(%L, %L::uuid)', :'gone_hash', :'stranger_uid')),
  'a revoked invitation was accepted'
);
-- The aftermath is read as the OWNER, then the client identity is restored.
-- `invitations_select_manager` is the only SELECT policy on `invitations`, so the
-- stranger genuinely cannot see this row: asserting its state through the stranger's
-- eyes would test the invisibility that section 3 already asserts, and an invisible
-- row makes the comparison NULL rather than false. Read as the owner, the comparison
-- separates the two failures that matter — a row that is gone, and a row that moved.
-- The role is restored immediately: the shadow-link section below must run as
-- `authenticated`, or it would prove nothing against a superuser.
RESET ROLE;
SELECT _canary_assert(
  (SELECT status FROM public.invitations WHERE id = :'revoked_invitation_id'::uuid)
    IS NOT DISTINCT FROM 'revoked',
  'a refused acceptance changed the invitation''s state'
);
SET LOCAL ROLE authenticated;

-- ── a shadow member is linked, never duplicated (PRD §3.3) ───────────────────
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);

SELECT _canary_assert(
  (SELECT status FROM public.invitations WHERE id = :'email_invitation_id'::uuid) = 'accepted'
    AND (SELECT accepted_by FROM public.invitations WHERE id = :'email_invitation_id'::uuid) = :'invitee_uid'::uuid
    AND (SELECT accepted_at FROM public.invitations WHERE id = :'email_invitation_id'::uuid) IS NOT NULL,
  'the accepted invitation does not record who accepted it, and when'
);

INSERT INTO public.members (society_id, display_name, phone, status)
VALUES (:'society_id'::uuid, 'Canary Shadow Link', '+919800000908', 'active')
RETURNING id AS shadow_id
\gset
-- The number now belongs to a shadow row AND to an account (patched onto the
-- profile above): the invitation is allowed because a shadow row is not an account,
-- and acceptance links it instead of recording the person twice.
INSERT INTO public.invitations (society_id, channel, phone, role, token_hash, expires_at)
VALUES (:'society_id'::uuid, 'whatsapp', '+919800000908', 'tenant', :'phone_hash', now() + interval '14 days')
RETURNING id AS phone_invitation_id
\gset

SELECT set_config('app.user_id',           :'linkee_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'linkee_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'linkee_uid', true);

SELECT public.invitation_accept(:'phone_hash', :'linkee_uid'::uuid) AS linked
\gset
-- The identity is restored here for the same reason as above, and the assertions below
-- compare with `IS NOT DISTINCT FROM` rather than `=`: after an accept, a claim that was
-- NOT restored makes every row invisible and every `= comparison NULL — and a NULL
-- condition is *false* to PL/pgSQL, so the assertion would pass having checked nothing.
SELECT set_config('app.user_id',           :'linkee_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'linkee_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'linkee_uid', true);

SELECT _canary_assert((:'linked'::jsonb)->>'linked_shadow' = 'true',
  'acceptance did not report linking the shadow member');
SELECT _canary_assert((:'linked'::jsonb)->>'member_id' = :'shadow_id',
  'acceptance created a second membership instead of linking the shadow row');
SELECT _canary_assert(
  (SELECT user_id FROM public.members WHERE id = :'shadow_id'::uuid) IS NOT DISTINCT FROM :'linkee_uid'::uuid,
  'the shadow row was not linked to the account'
);
SELECT _canary_assert(
  (SELECT role FROM public.members WHERE id = :'shadow_id'::uuid) IS NOT DISTINCT FROM 'tenant'::public.member_role,
  'the linked membership did not take the invited role'
);
SELECT _canary_assert(
  (SELECT count(*) FROM public.members WHERE society_id = :'society_id'::uuid AND phone = '+919800000908') = 1,
  'linking a shadow member left two rows for one number'
);
ROLLBACK;

-- ── a stranger: nothing at all ───────────────────────────────────────────────
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'stranger_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'stranger_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'stranger_uid', true);

SELECT _canary_assert(
  (SELECT count(*) FROM public.buildings) = 0,
  'a stranger can read a society building'
);
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.buildings (society_id, name) VALUES (%L, %L)',
    :'society_id', 'Stranger Block'
  )),
  'a stranger inserted a building into someone else''s society'
);
ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- T049 · Join requests: the pending row *is* the request, and a decision is one
--        locked write
-- ─────────────────────────────────────────────────────────────────────────────
--
-- What each group of assertions is here to prove:
--
--   * the request itself is an INSERT on `members` through the narrowed
--     self-join policy — `pending`, `resident`, `user_id = auth.uid()` and (new
--     in T049) never `is_primary`, so a requester cannot pre-claim the flat's
--     primary occupancy and have an approval merely confirm it;
--   * a duplicate request is impossible: `members_society_user_key` is the
--     per-society, per-account key, and asking again after a rejection is a
--     *transition* of the same row (`rejected → pending`), not a second row;
--   * the flat list the requester chooses from is code-keyed, definer and
--     member-less — not a policy on `apartments`, which needs an active member;
--   * both decisions resolve the reviewer from `auth.uid()` (never from the
--     caller's argument), require an active Admin or Treasurer of the request's
--     OWN society, and consume the request exactly once — a replay, a pending
--     reviewer, an ordinary resident, another society's Admin and anon all lose;
--   * the two claims on one flat are both readable to a reviewer before the
--     decision, and `uq_primary_occupant` — not an auto-rejection — is what
--     refuses the second primary claim;
--   * a rejection is stamped with its reason and its author, a re-ask keeps the
--     previous decision visible, and the next approval clears it.
-- ─────────────────────────────────────────────────────────────────────────────
SELECT auth.create_local_user('joiner@canary.ses.test',    'Canary Joiner')       AS joiner_uid,
       auth.create_local_user('rival@canary.ses.test',     'Canary Rival')        AS rival_uid,
       auth.create_local_user('outsider@canary.ses.test',  'Canary Outsider')     AS outsider_uid,
       auth.create_local_user('claimant@canary.ses.test',  'Canary Claimant')     AS claimant_uid,
       auth.create_local_user('claimant2@canary.ses.test', 'Canary Claimant Two') AS claimant2_uid
\gset

-- The phone the Admin already has on file for the joiner: the profile patch is an
-- owner act, and the shadow row below is what the join path must refuse against.
UPDATE public.profiles SET phone = '+919800000910' WHERE id = :'joiner_uid'::uuid;

-- The code the requester already holds (a WhatsApp share, a notice-board photo).
SELECT join_code AS join_code FROM public.societies WHERE id = :'society_id'::uuid
\gset

-- A second society owned by somebody who is nobody in the first: the composite FK
-- and the reviewer resolution are both asserted against it.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'outsider_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'outsider_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'outsider_uid', true);
SELECT (public.society_create(jsonb_build_object(
         'name',  'Canary Court Two',
         'type',  'apartment',
         'city',  'Pune',
         'state', 'MH'
       )))->'society'->>'id' AS society2_id
\gset
COMMIT;

-- A flat that is created and then soft-deleted: "a live flat" has a case the
-- composite FK cannot catch, because a removed flat's row is still there.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);
INSERT INTO public.apartments (society_id, building_id, apartment_number, floor)
VALUES (:'society_id'::uuid, :'building_id'::uuid, 'R-102', 2)
RETURNING id AS flat2_id
\gset
SELECT public.apartment_soft_delete(:'flat2_id'::uuid, :'society_id'::uuid);
COMMIT;

-- ── the request, as the person making it ─────────────────────────────────────
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'joiner_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'joiner_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'joiner_uid', true);

-- 1. the flat list a code unlocks: seven selector fields, nothing billable
SELECT public.society_join_options(:'join_code') AS join_options
\gset
SELECT _canary_assert((:'join_options'::jsonb)->>'society_id' = :'society_id',
  'the join options did not resolve the code''s own society');
SELECT _canary_assert((:'join_options'::jsonb)->>'total' = '1',
  'the join options did not report exactly the one live flat');
SELECT _canary_assert((:'join_options'::jsonb)->'flats'->0->>'id' = :'flat_id',
  'the join options did not list the society''s live flat');
SELECT _canary_assert((:'join_options'::jsonb)->>'truncated' = 'false',
  'the join options reported truncation for a one-flat society');
SELECT _canary_assert(
  (SELECT count(*) FROM jsonb_object_keys((:'join_options'::jsonb)->'flats'->0)) = 7,
  'a flat in the join options exposes more than the selector''s seven fields'
);
-- a shape-valid code matching nothing, and something that is not a code at all
SELECT _canary_assert(
  _canary_refuses(format('SELECT public.society_join_options(%L)', 'ZZZZZZ')),
  'a join code matching no society produced a flat list'
);
SELECT _canary_assert(
  _canary_refuses(format('SELECT public.society_join_options(%L)', 'not-a-code')),
  'a malformed join code produced a flat list'
);
-- and anon holds no EXECUTE on the venue
SET LOCAL ROLE anon;
SELECT _canary_assert(
  _canary_refuses(format('SELECT public.society_join_options(%L)', :'join_code')),
  'anon read a society''s flats through the join options'
);
SET LOCAL ROLE authenticated;

-- 2. the request: flat, occupancy and note on a pending row. `role` is not in
--    the INSERT grant at all (the policy pins it and the default supplies it),
--    so a request cannot name the role it will hold — the approver does.
INSERT INTO public.members (society_id, user_id, status, occupancy, apartment_id, request_note)
VALUES (:'society_id'::uuid, :'joiner_uid'::uuid, 'pending', 'tenant', :'flat_id'::uuid, 'Tenant of R-101 from March')
RETURNING id AS joiner_member_id
\gset
SELECT _canary_assert(
  (SELECT status FROM public.members WHERE id = :'joiner_member_id'::uuid) = 'pending',
  'a join request did not land as pending'
);
SELECT _canary_assert(
  (SELECT request_note FROM public.members WHERE id = :'joiner_member_id'::uuid) = 'Tenant of R-101 from March',
  'the request note was not stored'
);
SELECT _canary_assert(
  (SELECT joined_at FROM public.members WHERE id = :'joiner_member_id'::uuid) IS NULL
  AND (SELECT approved_by FROM public.members WHERE id = :'joiner_member_id'::uuid) IS NULL,
  'a pending request already carried an approval stamp'
);

-- 3. a second request for the same account in the same society: the unique key
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.members (society_id, user_id, occupancy) VALUES (%L, %L, %L)',
    :'society_id', :'joiner_uid', 'tenant'
  )),
  'members_society_user_key accepted a second row — two pending requests are possible'
);

-- 4. one refusal per rule on the self-insert path
--    a) primacy is not a request field — the narrowed policy
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.members (society_id, user_id, occupancy, apartment_id, is_primary) VALUES (%L, %L, %L, %L, true)',
    :'society_id', :'rival_uid', 'owner_occupied', :'flat_id'
  )),
  'a requester flagged their own pending row as the flat''s primary occupant'
);
--    b) a self-insert cannot name a role — `members.role` is in no INSERT
--       grant, and the self-policy pins `resident` underneath that
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.members (society_id, user_id, role) VALUES (%L, %L, %L)',
    :'society_id', :'rival_uid', 'admin'
  )),
  'a requester inserted their own membership at the Admin role'
);
--    c) … to pending …
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.members (society_id, user_id, status) VALUES (%L, %L, %L)',
    :'society_id', :'rival_uid', 'active'
  )),
  'a requester inserted their own membership as active'
);
--    d) … and to themselves
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.members (society_id, user_id, occupancy) VALUES (%L, %L, %L)',
    :'society_id', :'rival_uid', 'tenant'
  )),
  'a requester inserted a membership for somebody else'
);
--    e) the note is a note, not a dossier
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.members (society_id, user_id, occupancy, request_note) VALUES (%L, %L, %L, %L)',
    :'society_id', :'rival_uid', 'tenant', repeat('x', 501)
  )),
  'chk_members_request_note_length accepted a 501-character note'
);
--    f) the flat must belong to *this* society — the composite FK, not the policy
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.members (society_id, user_id, occupancy, apartment_id) VALUES (%L, %L, %L, %L)',
    :'society2_id', :'joiner_uid', 'tenant', :'flat_id'
  )),
  'a join request claimed a flat belonging to another society'
);

-- 5. "is this a live flat of this society" answers all three cases
SELECT _canary_assert(
  public.is_live_society_apartment(:'flat_id'::uuid, :'society_id'::uuid),
  'is_live_society_apartment said no to a live flat of its own society'
);
SELECT _canary_assert(
  NOT public.is_live_society_apartment(:'flat_id'::uuid, :'society2_id'::uuid),
  'is_live_society_apartment said yes to a flat through another society'
);
SELECT _canary_assert(
  NOT public.is_live_society_apartment(:'flat2_id'::uuid, :'society_id'::uuid),
  'is_live_society_apartment said yes to a soft-deleted flat'
);

-- 6. the shadow guard: the number the Admin already recorded, and nobody else's
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);
INSERT INTO public.members (society_id, display_name, phone, status)
VALUES (:'society_id'::uuid, 'Canary Shadow Joiner', '+919800000910', 'active')
RETURNING id AS shadow_joiner_id
\gset
SELECT _canary_assert(
  public.join_request_blocking_shadow(:'society_id'::uuid, :'joiner_uid'::uuid) = :'shadow_joiner_id'::uuid,
  'join_request_blocking_shadow did not find the shadow member recorded for the caller''s number'
);
SELECT _canary_assert(
  public.join_request_blocking_shadow(:'society_id'::uuid, :'rival_uid'::uuid) IS NULL,
  'join_request_blocking_shadow named a shadow member for a number nobody holds'
);
COMMIT;

-- ── the decisions, as the people entitled to make them ───────────────────────
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);

SELECT id AS admin_member_id FROM public.members WHERE user_id = :'member_uid'::uuid
\gset
SELECT id AS applicant_member_id FROM public.members WHERE user_id = :'applicant_uid'::uuid
\gset

-- 1. a *pending* member cannot decide anything, not even their own request: the
--    reviewer resolution requires an active Admin or Treasurer.
SELECT set_config('app.user_id',           :'applicant_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'applicant_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'applicant_uid', true);
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.member_approve_join(%L::uuid, %L::uuid, %L::uuid, %L::jsonb)',
    :'joiner_member_id', :'society_id', :'applicant_uid', '{}'
  )),
  'a pending member approved a join request'
);

-- 2. a Treasurer may admit, but not above Resident — the same asymmetry the
--    invitation path enforces. First appoint the applicant, as the Admin.
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);
UPDATE public.members SET status = 'active' WHERE user_id = :'applicant_uid'::uuid;
UPDATE public.members SET role = 'treasurer' WHERE user_id = :'applicant_uid'::uuid;
SELECT _canary_assert(
  (SELECT role FROM public.members WHERE user_id = :'applicant_uid'::uuid) = 'treasurer',
  'the Treasurer reviewer fixture was not appointed'
);

SELECT set_config('app.user_id',           :'applicant_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'applicant_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'applicant_uid', true);
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.member_approve_join(%L::uuid, %L::uuid, %L::uuid, %L::jsonb)',
    :'joiner_member_id', :'society_id', :'applicant_uid', '{"role":"admin"}'
  )),
  'a Treasurer admitted somebody at the Admin role'
);

-- 3. the approval itself: one write that activates, assigns the requested role
--    and flat, stamps the reviewer, and consumes the request.
SELECT public.member_approve_join(
         :'joiner_member_id'::uuid, :'society_id'::uuid, :'applicant_uid'::uuid, '{}'::jsonb
       ) AS approved
\gset
SELECT _canary_assert((:'approved'::jsonb)->>'status' = 'active',
  'approval did not report an active membership');
SELECT _canary_assert(
  (SELECT status  FROM public.members WHERE id = :'joiner_member_id'::uuid) = 'active'
  AND (SELECT role      FROM public.members WHERE id = :'joiner_member_id'::uuid) = 'resident'
  AND (SELECT occupancy FROM public.members WHERE id = :'joiner_member_id'::uuid) = 'tenant'
  AND (SELECT apartment_id FROM public.members WHERE id = :'joiner_member_id'::uuid) = :'flat_id'::uuid,
  'approval did not activate the request with the requested role, occupancy and flat'
);
SELECT _canary_assert(
  (SELECT joined_at FROM public.members WHERE id = :'joiner_member_id'::uuid) IS NOT NULL
  AND (SELECT approved_by FROM public.members WHERE id = :'joiner_member_id'::uuid) = :'applicant_member_id'::uuid,
  'approval did not stamp the reviewer and the join'
);
SELECT _canary_assert(
  (SELECT is_primary FROM public.members WHERE id = :'joiner_member_id'::uuid) = false,
  'approval confirmed a primary flag the request never carried'
);

-- 4. the replay: the row lock re-reads the status, so the request is consumed once
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.member_approve_join(%L::uuid, %L::uuid, %L::uuid, %L::jsonb)',
    :'joiner_member_id', :'society_id', :'applicant_uid', '{}'
  )),
  'a join request was approved twice'
);

-- 5. the actor argument is checked against auth.uid(), never trusted
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.member_approve_join(%L::uuid, %L::uuid, %L::uuid, %L::jsonb)',
    :'joiner_member_id', :'society_id', :'applicant_uid', '{}'
  )),
  'a decision ran on behalf of somebody who is not the caller'
);

-- 6. anon: the functions are not theirs (no EXECUTE at all)
SET LOCAL ROLE anon;
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.member_approve_join(%L::uuid, %L::uuid, %L::uuid, %L::jsonb)',
    :'joiner_member_id', :'society_id', :'member_uid', '{}'
  )),
  'anon approved a join request'
);
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.member_reject_join(%L::uuid, %L::uuid, %L::uuid, %L)',
    :'joiner_member_id', :'society_id', :'member_uid', 'because'
  )),
  'anon rejected a join request'
);
SET LOCAL ROLE authenticated;

-- 7. the next request: the ordinary resident (the joiner, just admitted) cannot
--    decide it, and neither can an Admin of another society.
SELECT set_config('app.user_id',           :'rival_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'rival_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'rival_uid', true);
INSERT INTO public.members (society_id, user_id, occupancy, apartment_id, request_note)
VALUES (:'society_id'::uuid, :'rival_uid'::uuid, 'owner_occupied', :'flat_id'::uuid, 'Owner of R-101')
RETURNING id AS rival_member_id
\gset

-- a pending member reads their own row, and nothing else of the society's
SELECT _canary_assert(
  (SELECT status FROM public.members WHERE user_id = :'rival_uid'::uuid) = 'pending',
  'a requester cannot read their own pending state'
);
SELECT _canary_assert(
  (SELECT count(*) FROM public.apartments) = 0,
  'a pending member read the society''s flats'
);
SELECT _canary_assert(
  (SELECT count(*) FROM public.buildings) = 0,
  'a pending member read the society''s buildings'
);
SELECT _canary_assert(
  (SELECT count(*) FROM public.members WHERE society_id = :'society_id'::uuid) = 1,
  'a pending member read the roster — the select policy is not active-scoped'
);

SELECT set_config('app.user_id',           :'joiner_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'joiner_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'joiner_uid', true);
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.member_approve_join(%L::uuid, %L::uuid, %L::uuid, %L::jsonb)',
    :'rival_member_id', :'society_id', :'joiner_uid', '{}'
  )),
  'an ordinary resident approved a join request — the reviewer resolution is not role-scoped'
);

SELECT set_config('app.user_id',           :'outsider_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'outsider_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'outsider_uid', true);
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.member_approve_join(%L::uuid, %L::uuid, %L::uuid, %L::jsonb)',
    :'rival_member_id', :'society_id', :'outsider_uid', '{}'
  )),
  'an Admin of another society approved a join request'
);

-- 8. what an approval may not do: an occupancy outside the enum, a foreign flat,
--    and primacy with no flat at all
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.member_approve_join(%L::uuid, %L::uuid, %L::uuid, %L::jsonb)',
    :'rival_member_id', :'society_id', :'member_uid', '{"occupancy":"landlord"}'
  )),
  'an approval accepted an occupancy outside the enum'
);
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.member_approve_join(%L::uuid, %L::uuid, %L::uuid, %L::jsonb)',
    :'rival_member_id', :'society_id', :'member_uid',
    format('{"apartment_id":"%s"}', gen_random_uuid())
  )),
  'an approval moved a member into a flat that is not of this society'
);
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.member_approve_join(%L::uuid, %L::uuid, %L::uuid, %L::jsonb)',
    :'rival_member_id', :'society_id', :'member_uid', '{"is_primary":true,"apartment_id":""}'
  )),
  'an approval marked a primary occupant with no flat'
);
-- the table''s own constraint says the same thing if a writer skips the function
SELECT _canary_assert(
  _canary_refuses(format(
    'UPDATE public.members SET apartment_id = NULL, is_primary = true WHERE id = %L::uuid',
    :'rival_member_id'
  )),
  'chk_members_primary_requires_apartment accepted primacy without a flat'
);

-- 9. rejection: the reason is required, stamped, and single-use — then the
--    requester corrects the claim and asks again (T049''s one new transition).
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.member_reject_join(%L::uuid, %L::uuid, %L::uuid, %L)',
    :'rival_member_id', :'society_id', :'member_uid', 'no'
  )),
  'a rejection with no usable reason was accepted'
);
SELECT public.member_reject_join(
         :'rival_member_id'::uuid, :'society_id'::uuid, :'member_uid'::uuid,
         'R-101 belongs to another owner — verify with the society office.'
       ) AS rejected
\gset
SELECT _canary_assert((:'rejected'::jsonb)->>'status' = 'rejected',
  'rejection did not report a rejected membership');
SELECT _canary_assert(
  (SELECT status FROM public.members WHERE id = :'rival_member_id'::uuid) = 'rejected'
  AND (SELECT rejection_reason FROM public.members WHERE id = :'rival_member_id'::uuid) IS NOT NULL
  AND (SELECT rejected_at FROM public.members WHERE id = :'rival_member_id'::uuid) IS NOT NULL
  AND (SELECT rejected_by FROM public.members WHERE id = :'rival_member_id'::uuid) = :'admin_member_id'::uuid,
  'a rejection did not store its reason, its time and its author'
);
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.member_reject_join(%L::uuid, %L::uuid, %L::uuid, %L)',
    :'rival_member_id', :'society_id', :'member_uid', 'and again'
  )),
  'a join request was rejected twice'
);

-- the re-ask, as the requester: one allowed transition, the previous decision kept
SELECT set_config('app.user_id',           :'rival_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'rival_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'rival_uid', true);
SELECT rejection_reason AS rival_prior_reason, rejected_at AS rival_prior_at
  FROM public.members WHERE id = :'rival_member_id'::uuid
\gset
UPDATE public.members
   SET status = 'pending',
       request_note = 'Corrected claim: I am the tenant of R-101, not the owner.'
 WHERE id = :'rival_member_id'::uuid;
SELECT _canary_assert(
  (SELECT status FROM public.members WHERE id = :'rival_member_id'::uuid) = 'pending',
  'a rejected requester could not ask again'
);
SELECT _canary_assert(
  (SELECT rejection_reason FROM public.members WHERE id = :'rival_member_id'::uuid) IS NOT DISTINCT FROM :'rival_prior_reason'
  AND (SELECT rejected_at FROM public.members WHERE id = :'rival_member_id'::uuid) IS NOT DISTINCT FROM :'rival_prior_at'::timestamptz,
  'the re-ask erased the previous decision — the next reviewer cannot see it'
);
SELECT _canary_assert(
  _canary_refuses(format(
    'UPDATE public.members SET status = %L WHERE id = %L::uuid',
    'active', :'rival_member_id'
  )),
  'a requester approved themselves on the re-ask'
);

-- 10. the next decision overrides the last one: approval clears the refusal
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);
SELECT public.member_approve_join(
         :'rival_member_id'::uuid, :'society_id'::uuid, :'member_uid'::uuid,
         '{"occupancy":"tenant"}'::jsonb
       ) AS rival_approved
\gset
SELECT _canary_assert((:'rival_approved'::jsonb)->>'status' = 'active',
  'the corrected claim was not approved');
SELECT _canary_assert(
  (SELECT rejection_reason FROM public.members WHERE id = :'rival_member_id'::uuid) IS NULL
  AND (SELECT rejected_at FROM public.members WHERE id = :'rival_member_id'::uuid) IS NULL
  AND (SELECT rejected_by FROM public.members WHERE id = :'rival_member_id'::uuid) IS NULL,
  'an approval kept the previous rejection''s stamps'
);

-- 11. two claims on one flat: both visible to the reviewer, and the second
--     primary claim refused by the flat''s own uniqueness — never auto-rejected
SELECT set_config('app.user_id',           :'claimant_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'claimant_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'claimant_uid', true);
INSERT INTO public.members (society_id, user_id, occupancy, apartment_id, request_note)
VALUES (:'society_id'::uuid, :'claimant_uid'::uuid, 'owner_occupied', :'flat_id'::uuid, 'I own R-101')
RETURNING id AS claimant_member_id
\gset

SELECT set_config('app.user_id',           :'claimant2_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'claimant2_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'claimant2_uid', true);
INSERT INTO public.members (society_id, user_id, occupancy, apartment_id, request_note)
VALUES (:'society_id'::uuid, :'claimant2_uid'::uuid, 'owner_occupied', :'flat_id'::uuid, 'I own R-101 too')
RETURNING id AS claimant2_member_id
\gset

-- the reviewer sees both rows before deciding anything
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);
SELECT _canary_assert(
  (SELECT count(*) FROM public.members
    WHERE society_id = :'society_id'::uuid
      AND status = 'pending'
      AND apartment_id = :'flat_id'::uuid) = 2,
  'the two claims on one flat are not both readable — the queue could not show them'
);

-- one primary occupant is what a flat has; the second claim is refused at the
-- index, with the first decision standing
SELECT public.member_approve_join(
         :'claimant_member_id'::uuid, :'society_id'::uuid, :'member_uid'::uuid,
         '{"is_primary":true}'::jsonb
       ) AS claim_first
\gset
SELECT _canary_assert((:'claim_first'::jsonb)->>'status' = 'active',
  'the first primary claim was not approved');
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.member_approve_join(%L::uuid, %L::uuid, %L::uuid, %L::jsonb)',
    :'claimant2_member_id', :'society_id', :'member_uid', '{"is_primary":true}'
  )),
  'a second primary occupant of one flat was admitted — uq_primary_occupant did not refuse'
);
-- …and the same claim without primacy is an ordinary admission, because the
-- collision is about the flag, not the person
SELECT public.member_approve_join(
         :'claimant2_member_id'::uuid, :'society_id'::uuid, :'member_uid'::uuid,
         '{"is_primary":false}'::jsonb
       ) AS claim_second
\gset
SELECT _canary_assert((:'claim_second'::jsonb)->>'status' = 'active',
  'the second claim was refused outright instead of being admitted without primacy');
SELECT _canary_assert(
  (SELECT count(*) FROM public.members WHERE apartment_id = :'flat_id'::uuid AND is_primary) = 1,
  'the flat ended with two primary occupants'
);
COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. Expense categories (T062) — a member-scoped read, a manager-scoped write,
--     and a tombstone only the definer function can write
--
-- Four different gates on one table, and a canary that checked only the first would
-- pass on a vocabulary every member could rewrite. The seeded set is asserted first
-- because everything below reads it: nineteen rows per society is what
-- `seed_society()` promises, and a count is the cheapest way to notice that a
-- migration stopped seeding it.
--
-- `deleted_at` is the interesting column. It is in no INSERT or UPDATE grant and
-- `DELETE` is granted to nobody, so the only reachable tombstone is
-- `expense_category_soft_delete()` — which is why this section exercises that
-- function rather than a DELETE statement.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── the seed ─────────────────────────────────────────────────────────────────
SELECT _canary_assert(
  (SELECT count(*) FROM public.expense_categories WHERE society_id = :'society_id'::uuid) = 19,
  'society_create did not seed the nineteen expense categories'
);
SELECT _canary_assert(
  (SELECT count(*) FROM public.expense_categories
    WHERE society_id = :'society_id'::uuid AND display_order BETWEEN 1 AND 19) = 19,
  'the seeded display_order is not 1..19 — the picker would show an arbitrary order'
);
SELECT _canary_assert(
  (SELECT count(*) FROM public.expense_categories
    WHERE society_id = :'society_id'::uuid AND (is_owner_only OR is_capital)) = 2,
  'is_owner_only/is_capital do not land on exactly the two funds'
);
SELECT _canary_assert(
  (SELECT bool_and(default_split_strategy = 'equal'
                   AND default_apartment_basis IS NULL
                   AND is_active
                   AND gst_applicable = false)
     FROM public.expense_categories WHERE society_id = :'society_id'::uuid),
  'a seeded category did not take the column defaults the PRD leaves open'
);

-- The two categories this section acts on, captured AS THE OWNER: a referenced one and
-- a free one, so both answers of the delete rule are asserted. The admin''s member id
-- is captured with them — `expenses.created_by` is NOT NULL and half of a composite FK.
SELECT (SELECT id FROM public.expense_categories
         WHERE society_id = :'society_id'::uuid AND name = 'Plumbing')  AS referenced_category_id,
       (SELECT id FROM public.expense_categories
         WHERE society_id = :'society_id'::uuid AND name = 'Painting')  AS free_category_id,
       (SELECT id FROM public.members
         WHERE society_id = :'society_id'::uuid AND user_id = :'member_uid'::uuid) AS canary_admin_member_id
\gset

-- An expense that names `Plumbing`, written as the owner. `expenses` has no
-- `deleted_at` (SAD §8.1 — never deleted, voided instead), so this one row is what makes
-- the category undeletable for good. `draft` keeps clear of the deferred split-total
-- constraint, which only a `published` row has to satisfy.
INSERT INTO public.expenses (
  society_id, category_id, title, amount_paise, expense_date, split_strategy, status, created_by
) VALUES (
  :'society_id'::uuid, :'referenced_category_id'::uuid, 'Canary plumbing',
  10000::bigint, current_date, 'equal', 'draft', :'canary_admin_member_id'::uuid
);

-- ── the pending identity, through the real self-join path ────────────────────
-- `members_insert_self_pending` pins the row to `pending`/`resident` and `role` is not in
-- the UPDATE grant, so this is the state every applicant is in until a reviewer decides.
-- Minted here rather than reusing `applicant_uid` because that account is promoted to an
-- active Treasurer later in this file, and this section needs a membership that is *not*
-- active.
SELECT auth.create_local_user('pendingcat@canary.ses.test', 'Canary Pending') AS pending_cat_uid
\gset

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'pending_cat_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'pending_cat_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'pending_cat_uid', true);

INSERT INTO public.members (society_id, user_id, occupancy)
VALUES (:'society_id'::uuid, :'pending_cat_uid'::uuid, 'owner_occupied');

SELECT _canary_assert(
  (SELECT count(*) FROM public.expense_categories WHERE society_id = :'society_id'::uuid) = 0,
  'a pending member read the expense categories — can_view_expenses requires active'
);
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.expense_categories (society_id, name) VALUES (%L::uuid, %L)',
    :'society_id', 'Pending Category'
  )),
  'a pending member wrote an expense category'
);
COMMIT;

-- ── the role the read must admit and the write must refuse ───────────────────
-- An active Resident. Inserted by the owner because the self-join path cannot reach
-- `active` without a reviewer''s decision, and this section is about categories.
SELECT auth.create_local_user('catresident@canary.ses.test', 'Canary Resident') AS cat_resident_uid
\gset
INSERT INTO public.members (society_id, user_id, display_name, role, status, occupancy)
VALUES (:'society_id'::uuid, :'cat_resident_uid'::uuid, 'Canary Resident',
        'resident', 'active', 'owner_occupied')
RETURNING id AS cat_resident_member_id
\gset

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'cat_resident_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'cat_resident_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'cat_resident_uid', true);

SELECT _canary_assert(
  (SELECT count(*) FROM public.expense_categories WHERE society_id = :'society_id'::uuid) = 19,
  'an active Resident cannot read the expense categories — expense.view is theirs'
);
-- `INSERT` and not `UPDATE`: a WITH CHECK *raises*, while a USING clause merely filters
-- rows, so an insert is the write whose refusal is observable at the SQLSTATE.
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.expense_categories (society_id, name) VALUES (%L::uuid, %L)',
    :'society_id', 'Resident Category'
  )),
  'a Resident wrote an expense category — the manager policy did not refuse it'
);
COMMIT;

-- ── a non-member: no read, no write, no function ─────────────────────────────
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'stranger_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'stranger_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'stranger_uid', true);

SELECT _canary_assert(
  (SELECT count(*) FROM public.expense_categories WHERE society_id = :'society_id'::uuid) = 0,
  'a non-member read another society''s expense categories'
);
SELECT _canary_assert(
  _canary_refuses(format(
    'INSERT INTO public.expense_categories (society_id, name) VALUES (%L::uuid, %L)',
    :'society_id', 'Stranger Category'
  )),
  'a non-member wrote an expense category'
);
-- The function''s own 404-before-403: `assert_society_membership` runs first, so a
-- stranger cannot tell another tenant''s society from a non-existent one (PRD T041).
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.expense_category_soft_delete(%L::uuid, %L::uuid)',
    :'free_category_id', :'society_id'
  )),
  'a non-member reached the category soft-delete function'
);
COMMIT;

-- ── a manager: create, rename, and the columns no client may write ───────────
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);

SELECT _canary_assert(
  (SELECT count(*) FROM public.expense_categories WHERE society_id = :'society_id'::uuid) = 19,
  'an active Admin cannot read the society''s expense categories'
);
INSERT INTO public.expense_categories (society_id, name, display_order)
VALUES (:'society_id'::uuid, 'Canary Amenity', 20);
SELECT _canary_assert(
  (SELECT count(*) FROM public.expense_categories WHERE society_id = :'society_id'::uuid) = 20,
  'an Admin could not create an expense category'
);
UPDATE public.expense_categories SET name = 'Canary Amenity Renamed'
 WHERE society_id = :'society_id'::uuid AND name = 'Canary Amenity';
SELECT _canary_assert(
  (SELECT count(*) FROM public.expense_categories
    WHERE society_id = :'society_id'::uuid AND name = 'Canary Amenity Renamed') = 1,
  'an Admin could not rename an expense category'
);

-- The tombstone columns are in no grant and DELETE is granted to nobody, so a client
-- that skipped the capability check still cannot remove a category by DML.
SELECT _canary_assert(
  _canary_refuses(format(
    'UPDATE public.expense_categories SET deleted_at = now() WHERE id = %L::uuid',
    :'free_category_id'
  )),
  '`deleted_at` is writable by a client — the soft delete is not function-only'
);
SELECT _canary_assert(
  _canary_refuses(format(
    'DELETE FROM public.expense_categories WHERE id = %L::uuid', :'free_category_id'
  )),
  'a client hard-deleted an expense category'
);
COMMIT;

-- ── the soft delete: a Resident, a reference, and a free category ────────────
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'cat_resident_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'cat_resident_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'cat_resident_uid', true);
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.expense_category_soft_delete(%L::uuid, %L::uuid)',
    :'free_category_id', :'society_id'
  )),
  'a Resident removed an expense category — only an Admin or Treasurer may'
);
COMMIT;

BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);

-- A category an expense still names is not removable, whatever the caller''s role —
-- the refusal is about the row''s references rather than about the caller.
SELECT _canary_assert(
  _canary_refuses(format(
    'SELECT public.expense_category_soft_delete(%L::uuid, %L::uuid)',
    :'referenced_category_id', :'society_id'
  )),
  'a category an expense references was removed — the reference check did not fire'
);
SELECT _canary_assert(
  (SELECT deleted_at IS NULL FROM public.expense_categories WHERE id = :'referenced_category_id'::uuid),
  'the refused removal left a tombstone behind'
);

-- …and an unreferenced one is removable, by the function rather than by DML.
SELECT public.expense_category_soft_delete(:'free_category_id'::uuid, :'society_id'::uuid);
SELECT _canary_assert(
  (SELECT count(*) FROM public.expense_categories
    WHERE society_id = :'society_id'::uuid AND name = 'Painting' AND deleted_at IS NULL) = 0,
  'the soft-deleted category is still in the live set'
);
SELECT _canary_assert(
  (SELECT deleted_at IS NOT NULL FROM public.expense_categories WHERE id = :'free_category_id'::uuid),
  'the soft delete left no tombstone — the row was not kept for its history'
);
-- The index is partial on live rows, so the freed name is usable again.
INSERT INTO public.expense_categories (society_id, name) VALUES (:'society_id'::uuid, 'Painting');
SELECT _canary_assert(
  (SELECT count(*) FROM public.expense_categories
    WHERE society_id = :'society_id'::uuid AND name = 'Painting' AND deleted_at IS NULL) = 1,
  'the removed name was not freed — the unique index is not partial on live rows'
);
COMMIT;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. Attachments (T071): the table cannot be forged, and the size gate lives
--     in the storage layer, not here
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The attachment table is the one place T071's security posture is *structural*
-- rather than procedural. Three of its properties are unreachable from an API test,
-- because an API test goes through the API:
--
--   a. `authenticated` has no UPDATE grant on any column except `completed_at` and
--      `updated_at`, so "a client cannot rewrite a verified checksum" is a privilege
--      rather than a rule somebody has to remember to apply;
--   b. `scan_status`, `completed_at`, `checksum`, `size_bytes` and `storage_key` are
--      not INSERT-able at all, so a client cannot declare its own upload clean,
--      already verified, or bound to an object of its own choosing;
--   c. the insert policy ties the storage key to the row's own society and entity, so
--      a row cannot point at another tenant's prefix — the forgery that would make
--      the SAD §10.3 layout cosmetic;
--   d. `id` **is** INSERT-able, and that is the counterweight to (c) rather than an
--      exception to it: the layout puts the id inside the key, so the row has to
--      carry the uuid the API already minted for the URL. An id is not a capability
--      anywhere in this design — and the canary asserts the invariant that makes the
--      grant worth having, that a row's id *is* the uuid in its own storage key.

-- (a) and (b) are grants, so they are asserted from the catalogue, as the owner.
SELECT _canary_assert(
  (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class
    WHERE oid = 'public.attachments'::regclass),
  'attachments is not RLS-enabled AND forced — the table owner would bypass its own policies'
);
SELECT _canary_assert(
  (SELECT array_agg(DISTINCT column_name) FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND table_name = 'attachments'
      AND grantee = 'authenticated' AND privilege_type = 'UPDATE')
    = ARRAY['completed_at', 'updated_at'],
  'attachments grants UPDATE on a column other than completed_at/updated_at — a verified checksum or size would be client-writable'
);
SELECT _canary_assert(
  NOT EXISTS (
    SELECT 1 FROM information_schema.column_privileges
     WHERE table_schema = 'public' AND table_name = 'attachments'
       AND grantee = 'authenticated' AND privilege_type = 'INSERT'
       AND column_name IN ('scan_status', 'completed_at', 'checksum', 'size_bytes', 'storage_key')
  ),
  'attachments lets a client INSERT scan_status, completed_at, checksum, size_bytes or storage_key — a row could claim to be verified before any bytes exist, or name an object of its own choosing'
);

-- `id` *is* insertable, and the two halves of why are asserted together, because on
-- their own each is misleading. It must be: SAD §10.3 puts the attachment id inside
-- the storage key, the key is `NOT NULL` and `UNIQUE` in the same statement, and the
-- API has already minted the id for the presigned URL before the row exists — so a
-- column default here mints a second uuid and every key names a row that does not
-- exist (#34 records the correction). And it is not an authority: the id decides
-- nothing in this design, reads are gated by RLS and the society predicate, and the
-- HTTP contract refuses a client-supplied `attachmentId` outright.
SELECT _canary_assert(
  (SELECT count(*) FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND table_name = 'attachments'
      AND grantee = 'authenticated' AND privilege_type = 'INSERT'
      AND column_name = 'id') = 1,
  'attachments does not grant INSERT on `id` — the row cannot carry the id its own storage key is built from, so the key and the row's primary key silently diverge'
);

-- The parent expense the refusals below point at: the draft this file already
-- created for the category-reference section.
SELECT (SELECT id FROM public.expenses
         WHERE society_id = :'society_id'::uuid AND title = 'Canary plumbing') AS canary_expense_id
\gset

-- (c) and the cross-society refusal need an identity, so they run under the exact
-- preamble `UnitOfWork` issues.
BEGIN;
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           :'member_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'member_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'member_uid', true);

-- A key that names the *other* society is refused by the insert policy even though
-- the caller is an Admin of their own: the prefix is checked against the row's own
-- `society_id` and `entity_id`, not against anything the caller can choose.
SELECT _canary_refuses(format(
  $sql$INSERT INTO public.attachments
          (society_id, entity_type, entity_id, storage_key, original_filename,
           mime_type, size_bytes, checksum, uploaded_by)
        VALUES (%L::uuid, 'expense', %L::uuid, %L, 'bill.jpg', 'image/jpeg', 10, %L, %L::uuid)$sql$,
  :'society_id', :'canary_expense_id',
  'societies/' || :'stranger_uid' || '/expenses/' || :'canary_expense_id' || '/x.jpg',
  repeat('a', 64), :'canary_admin_member_id'
));

-- The declared scan status is not in the INSERT grant at all, so a caller cannot
-- choose it — which is what keeps the future serving gate's one trusted value out of
-- a client's hands.
SELECT _canary_refuses(format(
  $sql$INSERT INTO public.attachments
          (society_id, entity_type, entity_id, storage_key, original_filename,
           mime_type, size_bytes, checksum, uploaded_by, scan_status)
        VALUES (%L::uuid, 'expense', %L::uuid, %L, 'bill.jpg', 'image/jpeg', 10, %L, %L::uuid, 'clean')$sql$,
  :'society_id', :'canary_expense_id',
  'societies/' || :'society_id' || '/expenses/' || :'canary_expense_id' || '/clean.jpg',
  repeat('a', 64), :'canary_admin_member_id'
));

-- The honest insert, by the Admin themselves, still works — so the refusals above are
-- a boundary and not a table nobody can write. It writes the id explicitly, the way
-- the API's own adapter does, because the key it is about to store was built from it.
SELECT gen_random_uuid() AS canary_attachment_id
\gset
INSERT INTO public.attachments (
  id, society_id, entity_type, entity_id, storage_key, original_filename,
  mime_type, size_bytes, checksum, uploaded_by
) VALUES (
  :'canary_attachment_id'::uuid,
  :'society_id'::uuid, 'expense', :'canary_expense_id'::uuid,
  'societies/' || :'society_id' || '/expenses/' || :'canary_expense_id' || '/' || :'canary_attachment_id' || '.jpg',
  'bill.jpg', 'image/jpeg', 10, repeat('a', 64), :'canary_admin_member_id'::uuid
);
SELECT _canary_assert(
  (SELECT count(*) FROM public.attachments
    WHERE society_id = :'society_id'::uuid AND entity_id = :'canary_expense_id'::uuid) = 1,
  'an Admin of the society could not write their own attachment row'
);

-- The row's id and the uuid in its own storage key are one value. This is the
-- assertion the wider grant exists for: without it the SAD §10.3 layout is cosmetic
-- and a bucket is un-auditable, because no stored key resolves to a stored row.
SELECT _canary_assert(
  (SELECT count(*) FROM public.attachments
    WHERE id = :'canary_attachment_id'::uuid
      AND storage_key = 'societies/' || society_id::text || '/expenses/' || entity_id::text
                        || '/' || id::text || '.jpg') = 1,
  'an attachment row''s id is not the uuid in its own storage key — the SAD §10.3 layout would name a row that does not exist'
);

-- The scan status is still server-written: the honest insert left it at the column
-- default, and the extra assertion is that nothing in the request path could say
-- otherwise.
SELECT _canary_assert(
  (SELECT scan_status = 'pending' FROM public.attachments
    WHERE id = :'canary_attachment_id'::uuid),
  'a newly written attachment row did not start `pending` — the serving gate''s one trusted value would be client-influenced'
);

-- A stranger sees none of it: the read policy is the `expense.view` population, so a
-- non-member reads zero rows rather than being refused.
RESET ROLE;
SELECT set_config('app.user_id',           :'stranger_uid', true);
SELECT set_config('request.jwt.claims',    jsonb_build_object('sub', :'stranger_uid', 'role', 'authenticated')::text, true);
SELECT set_config('request.jwt.claim.sub', :'stranger_uid', true);
SET LOCAL ROLE authenticated;
SELECT _canary_assert(
  (SELECT count(*) FROM public.attachments) = 0,
  'a stranger can read another society''s attachments'
);
ROLLBACK;

-- ─────────────────────────────────────────────────────────────────────────────
-- Cleanup: leave no fixture rows behind
-- ─────────────────────────────────────────────────────────────────────────────
SELECT _canary_reset();
DROP FUNCTION IF EXISTS _canary_reset();
DROP FUNCTION IF EXISTS _canary_assert(boolean, text);
DROP FUNCTION IF EXISTS _canary_refuses(text);

\echo 'RLS canary passed: auth.uid() resolves, member sees own society, stranger sees none, join preview resolves, buildings and apartments read/write/delete are member-, Admin- and function-scoped, a building with live flats refuses removal, the role writes are Admin-only with the 2-treasurer/3-admin caps, no self-change and no last-admin demotion, an invitation''s token hash is unreadable while its acceptance is recipient-matched, state-ordered and single-use (with a shadow member linked rather than duplicated), and a join request is a pending row — narrowed self-insert, no duplicate for one account, code-keyed options, one locked reviewer-resolved decision consumed once, a reason on every rejection, and one flat''s two claims both visible; and the expense categories are seeded nineteen per society with their two flags, readable by every active member and by nobody else, writable only by an Admin or Treasurer through policies whose `deleted_at` and DELETE are unreachable, with the soft delete a definer function that refuses a non-member, a Resident and any category an expense still names; and the attachments table is RLS-enabled and forced, grants UPDATE on `completed_at`/`updated_at` and nothing else, cannot have its `scan_status`, `completed_at`, `checksum`, `size_bytes` or `storage_key` written by a client at all, admits `id` only so the API''s row can carry the very uuid its storage key is built from (asserted, not assumed), refuses a storage key that names another tenant while accepting the caller''s own, and is invisible to a stranger.'
