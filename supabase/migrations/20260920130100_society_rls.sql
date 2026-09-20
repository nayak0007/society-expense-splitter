-- 20260920130100_society_rls.sql
--
-- Row Level Security for the society module (SAD §8.7: "Applied to every tenant
-- table without exception").
--
-- WHY THIS IS THE PRIMARY BOUNDARY, NOT DEFENCE IN DEPTH: the anon key ships in
-- the app bundle. Anyone can extract it and call PostgREST directly, so the
-- policies here — not the app, not a Nest guard — decide whether a request sees
-- or writes a society's data. `auth.uid()` comes from the JWT only Supabase Auth
-- can mint, so a client cannot claim another member's id.
--
-- The SAD expresses the same rules against `app_role` + `SET LOCAL
-- app.user_id`; that is the self-hosted API path (T038). For the PostgREST path
-- the identity source is `auth.uid()`, and the policies below are the SAD's
-- predicates restated against it — same shape, same intent.
--
-- Two rules from the PRD are load-bearing and easy to get wrong:
--   * a non-member must learn *nothing*: reads return no rows (→ `not_found`),
--     never an error that confirms the society exists (T041);
--   * a member who simply lacks the role is a different case, and must be told so
--     (`forbidden`), or a Treasurer sees "not found" for their own society.
--     The RPC layer in the next migration draws that line; RLS enforces the
--     write either way.
--
-- Down (run by hand):
--   DROP FUNCTION IF EXISTS public.is_society_admin(uuid);
--   DROP FUNCTION IF EXISTS public.is_society_member(uuid, boolean);
--   plus the DROP POLICY statements for all eight policies below.

-- ─────────────────────────────────────────────────────────────────────────────
-- Membership predicates
-- ─────────────────────────────────────────────────────────────────────────────

-- SECURITY DEFINER for two reasons, and both matter:
--   1. a policy on `members` that reads `members` would recurse — Postgres
--      refuses the query outright ("infinite recursion detected in policy");
--   2. the predicate must be identical everywhere it is used. One definition
--      means the members policy, the societies policy and the settings policy
--      cannot drift apart.
-- `p_require_active` encodes the one legitimate difference: a *pending* member
-- may see the society they asked to join (the app renders "waiting for
-- approval" with its name) but not its roster, settings history or join code.
CREATE OR REPLACE FUNCTION public.is_society_member(
  p_society_id uuid,
  p_require_active boolean DEFAULT true
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.members m
     WHERE m.society_id = p_society_id
       AND m.user_id = (SELECT auth.uid())
       AND m.status <> 'removed'
       AND (NOT p_require_active OR m.status = 'active')
  );
$$;

COMMENT ON FUNCTION public.is_society_member(uuid, boolean) IS
  'True when the caller holds a live membership of the society. Definer, so policies that read members from members do not recurse.';

CREATE OR REPLACE FUNCTION public.is_society_admin(p_society_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.members m
     WHERE m.society_id = p_society_id
       AND m.user_id = (SELECT auth.uid())
       AND m.role = 'admin'
       AND m.status = 'active'
  );
$$;

COMMENT ON FUNCTION public.is_society_admin(uuid) IS
  'True when the caller is an active Admin of the society. Mirrors canManageSociety() in the domain.';

REVOKE ALL ON FUNCTION public.is_society_member(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_society_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_society_member(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_society_admin(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────────

-- FORCE, not just ENABLE: without it the table owner bypasses its own policies,
-- which is the commonest way an RLS setup fails open (see the same note in the
-- auth migration).
ALTER TABLE public.societies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.societies FORCE ROW LEVEL SECURITY;
ALTER TABLE public.society_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.society_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.members FORCE ROW LEVEL SECURITY;

-- `(SELECT auth.uid())` rather than a bare call, and `p_…` wrapped in a
-- subquery for the same reason: Postgres hoists it into an InitPlan and
-- evaluates it once per statement instead of once per row.

-- ── societies ────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS societies_select_member ON public.societies;
CREATE POLICY societies_select_member
  ON public.societies
  FOR SELECT
  TO authenticated
  USING (
    created_by = (SELECT auth.uid())
    OR public.is_society_member(id, false)
  );
-- `is_society_member(…, false)`: a pending member may read the society they asked
-- to join — the app has to show its name on the "waiting for approval" screen.
-- It reveals nothing to a stranger, since a non-member still gets zero rows.
-- The creator clause is deliberate: the person who created the society can still
-- see it after their membership is removed, which is what makes the
-- support/transfer path (T046) possible without the service role.

DROP POLICY IF EXISTS societies_insert_creator ON public.societies;
CREATE POLICY societies_insert_creator
  ON public.societies
  FOR INSERT
  TO authenticated
  WITH CHECK (created_by = (SELECT auth.uid()));
-- Pinned to the caller: a client cannot create a society owned by someone else.
-- Everything else about a new society (slug, join code, settings, the creator's
-- admin membership) is derived by triggers, and the column grants below keep
-- those columns out of the client's reach entirely.

DROP POLICY IF EXISTS societies_update_admin ON public.societies;
CREATE POLICY societies_update_admin
  ON public.societies
  FOR UPDATE
  TO authenticated
  USING (public.is_society_admin(id))
  WITH CHECK (public.is_society_admin(id));

-- Deliberately NO delete policy: deleting a tenant is a soft delete
-- (`societies_soft_delete()`), because PRD §3.1/§3.3 keep financial history and
-- an account-deletion path must never cascade it away.

-- ── society_settings ─────────────────────────────────────────────────────────

DROP POLICY IF EXISTS society_settings_select_member ON public.society_settings;
CREATE POLICY society_settings_select_member
  ON public.society_settings
  FOR SELECT
  TO authenticated
  USING (public.is_society_member(society_id, false));

DROP POLICY IF EXISTS society_settings_update_admin ON public.society_settings;
CREATE POLICY society_settings_update_admin
  ON public.society_settings
  FOR UPDATE
  TO authenticated
  USING (public.is_society_admin(society_id))
  WITH CHECK (public.is_society_admin(society_id));

-- No INSERT policy: the row is created by `seed_society()` (definer) as part of
-- the same transaction that creates the society. A client that could insert
-- settings could also create a second, empty configuration row for another
-- tenant — there is nothing to gain and a whole class of bug to avoid.

-- ── members ──────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS members_select_self_or_roster ON public.members;
CREATE POLICY members_select_self_or_roster
  ON public.members
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR public.is_society_member(society_id, true)
  );
-- Own row always (routing depends on knowing your own pending state), the whole
-- roster only for *active* members. A pending member therefore sees exactly one
-- row: theirs. That is also why the repository derives a member count from a
-- definer function rather than counting rows it can see — the visible roster is
-- not the roster.

DROP POLICY IF EXISTS members_insert_self_pending ON public.members;
CREATE POLICY members_insert_self_pending
  ON public.members
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND status = 'pending'
    AND role = 'resident'
    AND removed_at IS NULL
  );
-- Joining is the only insert a client may perform, and it can only ever ask: the
-- row is theirs, it is `pending`, and it is a plain `resident`. Promotion to
-- `active` is an approval, and approvals are not self-service (PRD §3.2 "never
-- auto-approve"); the status/role columns needed to fake it are not grantable on
-- the way in, and `chk_member_self_change()` blocks the way out.

DROP POLICY IF EXISTS members_update_self_or_admin ON public.members;
CREATE POLICY members_update_self_or_admin
  ON public.members
  FOR UPDATE
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR public.is_society_admin(society_id)
  )
  WITH CHECK (
    user_id = (SELECT auth.uid())
    OR public.is_society_admin(society_id)
  );

-- No UPDATE policy for a plain member over someone else's row, and no DELETE
-- policy at all: leaving sets `status = 'removed'`, so a member's history (and
-- the financial rows that reference their `members.id`) survives.

-- ─────────────────────────────────────────────────────────────────────────────
-- Privileges
-- ─────────────────────────────────────────────────────────────────────────────

-- Supabase grants `anon`/`authenticated` ALL on new tables in `public` by
-- default, so the REVOKEs are not ceremony — they are what turns the policies
-- above into the only path. RLS filters rows; GRANTs decide which *columns* a
-- client may write, which is what stops a member from writing `join_code`,
-- `plan`, `deleted_at` or a role.
REVOKE ALL ON public.societies FROM anon;
REVOKE ALL ON public.societies FROM authenticated;
REVOKE ALL ON public.society_settings FROM anon;
REVOKE ALL ON public.society_settings FROM authenticated;
REVOKE ALL ON public.members FROM anon;
REVOKE ALL ON public.members FROM authenticated;

GRANT SELECT ON public.societies TO authenticated;
GRANT INSERT (
  name, society_type, registration_no, address_line1, address_line2,
  city, state, pincode, country, currency, timezone, created_by
) ON public.societies TO authenticated;
GRANT UPDATE (
  name, society_type, registration_no, address_line1, address_line2,
  city, state, pincode, timezone
) ON public.societies TO authenticated;
-- Not insertable: slug, join_code (minted by trigger), plan (billing), deleted_at.
-- Not updatable: slug (derived), join_code (`societies_rotate_join_code()` mints
-- it), country/currency (single-market product), plan, created_by, deleted_at.

GRANT SELECT ON public.society_settings TO authenticated;
GRANT UPDATE (
  billing_day, due_day, grace_days, late_fee_type, late_fee_value_paise,
  late_fee_percent, default_split_strategy, default_apartment_basis,
  approval_threshold_paise, bill_vacant_flats, allow_partial_payments,
  defaulter_list_public, bill_presentation, financial_year_start_month,
  ai_features_enabled
) ON public.society_settings TO authenticated;
-- `razorpay_account_id`, `bank_*` and `upi_vpa` are readable but not writable:
-- payment credentials are configured server-side (T078).

GRANT SELECT ON public.members TO authenticated;
GRANT INSERT (society_id, user_id, occupancy) ON public.members TO authenticated;
GRANT UPDATE (
  display_name, phone, email, occupancy, lease_start, lease_end, share_contact,
  status, removed_at
) ON public.members TO authenticated;
-- `display_name`/`phone`/`email` are filled from the caller's own profile by
-- `fill_member_identity()` on insert, and are updatable only for the caller's own
-- row (or by an admin). `role`, `is_primary`, `approved_by`, `joined_at`,
-- `society_id` and `user_id` are never client-writable — role changes belong to
-- the role-management path (T046), which runs through a guarded RPC.

REVOKE ALL ON FUNCTION public.gen_join_code() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gen_join_code() FROM anon;
REVOKE ALL ON FUNCTION public.gen_join_code() FROM authenticated;
-- Server-side only: minting codes is not a client operation, and leaving it
-- callable would let anyone burn CPU in the uniqueness loop.
