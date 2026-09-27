-- ============================================================================
-- T045 · Members module — directory, shadow members, removal
-- ============================================================================
--
-- This migration is the database half of the directory the PRD §3.3 describes and
-- `20260920130000_society_core.sql` created the table for. That migration built
-- the membership record — the join between a user and a society, and the only
-- place a role exists — together with the invariant triggers that keep a society
-- from becoming admin-less and a member from promoting themselves. What it could
-- not build is the part that points at a flat, because apartments did not exist
-- yet (`members.apartment_id` is in PRD §7 and was omitted deliberately by T040),
-- nor the directory's own rules.
--
-- What this adds, and why each piece is a database decision rather than a
-- service-layer one:
--
--   1. `members.apartment_id`, held to the *member's own society* by a composite
--      foreign key. The denormalised `society_id` arrives from the caller's
--      header, so without the composite key an Admin could attach a member to a
--      flat in another society and every other constraint would still hold —
--      the same reachable mistake `20260924140000_structure_apartments.sql`
--      documents for `apartments.building_id`.
--   2. `uq_primary_occupant` (PRD §7): at most one primary owner and one primary
--      tenant per flat. "Primary" is what billing and notices key on, so two of
--      them is not a tidy-up, it is a duplicate charge.
--   3. A partial unique index on a shadow member's phone, so the directory cannot
--      show the same person twice — and, once dues land, cannot bill them twice.
--   4. `stamp_member_approval()`, which records `joined_at`/`approved_by` for the
--      admin path only, because neither column is grantable and a member must not
--      be able to approve themselves.
--   5. An admin INSERT policy: adding a shadow member is the one insert that is
--      not a self-join, and it must be unable to mint a role or an approval.
--   6. `chk_member_self_change()` extended with the flat, so a member cannot move
--      themselves into someone else's flat.
--
-- Rollback (reverse order):
--   DROP TRIGGER IF EXISTS stamp_member_approval_before_insert ON public.members;
--   DROP FUNCTION IF EXISTS public.stamp_member_approval();
--   DROP INDEX IF EXISTS public.uq_members_shadow_phone;
--   DROP INDEX IF EXISTS public.uq_primary_occupant;
--   DROP INDEX IF EXISTS public.idx_members_directory;
--   ALTER TABLE public.members DROP CONSTRAINT IF EXISTS fk_members_apartment_society;
--   ALTER TABLE public.members DROP COLUMN IF EXISTS apartment_id;
--   ALTER TABLE public.apartments DROP CONSTRAINT IF EXISTS uq_apartments_id_society;
--   DROP POLICY IF EXISTS members_insert_admin ON public.members;
--   (and `chk_member_self_change`/`stamp_member_removal` re-created from
--    `20260920130000_society_core.sql`)

-- ─────────────────────────────────────────────────────────────────────────────
-- Anchor for the composite key
-- ─────────────────────────────────────────────────────────────────────────────

-- The composite FK below needs a unique key on the *pair* to point at, exactly as
-- `uq_buildings_id_society` served `fk_apartments_building_society`. `(id)` alone
-- is already unique; this adds `(id, society_id)` so a reference can carry the
-- tenant with it and be checked in the same constraint.
ALTER TABLE public.apartments
  DROP CONSTRAINT IF EXISTS uq_apartments_id_society;
ALTER TABLE public.apartments
  ADD CONSTRAINT uq_apartments_id_society UNIQUE (id, society_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- The flat a membership occupies
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS apartment_id uuid;

-- `ON DELETE SET NULL (apartment_id)` is the column-specific form Postgres 15
-- added, and it is the reason this is one constraint rather than two: the row must
-- keep its `society_id` (which is NOT NULL, and which the FK's own column list
-- includes) while losing only the flat. `RESTRICT` — the PRD's default for
-- children — is the wrong answer here: a flat is removed with
-- `apartment_soft_delete()`, which never deletes the row, so a hard delete only
-- happens during a repair, and orphaning the membership is a better failure than
-- refusing the repair. The rule that a flat with residents cannot be removed is a
-- *soft*-delete rule and belongs in that function, exactly as
-- `building_soft_delete()` carries the same rule for buildings.
ALTER TABLE public.members
  DROP CONSTRAINT IF EXISTS fk_members_apartment_society;
ALTER TABLE public.members
  ADD CONSTRAINT fk_members_apartment_society
  FOREIGN KEY (apartment_id, society_id)
  REFERENCES public.apartments (id, society_id)
  ON DELETE SET NULL (apartment_id);

CREATE INDEX IF NOT EXISTS idx_members_apartment
  ON public.members (apartment_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Constraints (PRD §7's members table, plus the directory's own rules)
-- ─────────────────────────────────────────────────────────────────────────────

-- A name is what the directory renders; a blank one is a hole in the roster
-- rather than a member. `fill_member_identity()` already refuses to leave it
-- empty on the self-join path, so this is the backstop for the admin path and for
-- a direct SQL write.
ALTER TABLE public.members
  DROP CONSTRAINT IF EXISTS chk_members_name_not_blank;
ALTER TABLE public.members
  ADD CONSTRAINT chk_members_name_not_blank
  CHECK (btrim(display_name) <> '');

-- A lease that ends before it starts is a typo with a billing consequence: the
-- tenant's charges are prorated by this window (PRD §3.4).
ALTER TABLE public.members
  DROP CONSTRAINT IF EXISTS chk_members_lease_window;
ALTER TABLE public.members
  ADD CONSTRAINT chk_members_lease_window
  CHECK (
    lease_start IS NULL
    OR lease_end IS NULL
    OR lease_start <= lease_end
  );

-- The primary occupant is the person the flat's dues are addressed to, so the flag
-- is meaningless without a flat. This is also what makes `uq_primary_occupant`
-- below well defined: a NULL `apartment_id` is not a group anything can collide
-- in.
ALTER TABLE public.members
  DROP CONSTRAINT IF EXISTS chk_members_primary_requires_apartment;
ALTER TABLE public.members
  ADD CONSTRAINT chk_members_primary_requires_apartment
  CHECK (NOT is_primary OR apartment_id IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- Uniqueness
-- ─────────────────────────────────────────────────────────────────────────────

-- PRD §7's index, verbatim: at most one primary owner and at most one primary
-- tenant (a `vacant_owner` counts as an owner) per flat, among *live* memberships.
-- The partial predicate is what makes removal work: a member who left no longer
-- holds the claim, so the flat's next primary occupant can be recorded.
CREATE UNIQUE INDEX IF NOT EXISTS uq_primary_occupant
  ON public.members (apartment_id, occupancy)
  WHERE is_primary
    AND status = 'active'
    AND occupancy IN ('owner_occupied', 'tenant', 'vacant_owner');

-- A shadow member's only identifier is their phone — there is no account to key on
-- — so a second live shadow member with the same number in one society is the same
-- person recorded twice: two rows to bill, two rows to link when they sign up, and
-- a directory that shows a duplicate. The account case is already covered by
-- `members_society_user_key`.
--
-- `status <> 'removed'` for the same reason the primary index is partial, and
-- broader than the primary index on purpose: a *pending* duplicate is also a
-- duplicate, and it is the state the join flow leaves behind. An addition beyond
-- the PRD's constraints, and a deliberate one.
CREATE UNIQUE INDEX IF NOT EXISTS uq_members_shadow_phone
  ON public.members (society_id, phone)
  WHERE user_id IS NULL
    AND phone IS NOT NULL
    AND status <> 'removed';

-- The directory's default read: one society, ordered by name, live rows only.
-- `COLLATE "C"` because that is the order the API returns and the order the client
-- renders — a locale collation here would put "A-101" and "a-101" in an order the
-- index cannot reproduce, and the sort would silently fall back to a scan.
CREATE INDEX IF NOT EXISTS idx_members_directory
  ON public.members (society_id, display_name COLLATE "C")
  WHERE status <> 'removed';

-- ─────────────────────────────────────────────────────────────────────────────
-- Approval stamps
-- ─────────────────────────────────────────────────────────────────────────────

-- `joined_at` and `approved_by` are absent from every column grant below, so
-- something server-side has to write them; this is that something, and it is a
-- trigger rather than application code so a repaired row gets them too.
--
-- Only the *admin* path reaches a row whose status is already `active` at insert
-- time: the self-join policy pins an insert to `pending`. That is why one function
-- can cover both obligations — for a pending row it does nothing, and the approval
-- stamps land when the approve path lands (T049), which updates the row and is
-- covered by `stamp_member_removal()`'s existing `status = 'active'` branch.
CREATE OR REPLACE FUNCTION public.stamp_member_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'active' THEN
    IF NEW.joined_at IS NULL THEN
      NEW.joined_at := now();
    END IF;
    -- The acting admin's own membership row, not the row being written: a NULL
    -- identity (a migration, a repair) leaves the column NULL rather than
    -- inventing an approver.
    IF NEW.approved_by IS NULL THEN
      SELECT m.id INTO NEW.approved_by
        FROM public.members m
       WHERE m.society_id = NEW.society_id
         AND m.user_id = (SELECT auth.uid())
       LIMIT 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.stamp_member_approval() IS
  'Stamps joined_at and the approving admin on an insert that already holds status=active (the admin direct-add path). The self-join path is pending and untouched.';

DROP TRIGGER IF EXISTS stamp_member_approval_before_insert ON public.members;
CREATE TRIGGER stamp_member_approval_before_insert
  BEFORE INSERT ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.stamp_member_approval();

-- ─────────────────────────────────────────────────────────────────────────────
-- members — invariants (rewritten, additively)
-- ─────────────────────────────────────────────────────────────────────────────

-- Same rule as `20260920130000_society_core.sql`, with one new branch. The original
-- states why a member may edit their own row but never promote themselves; what is
-- added here is the flat, because `apartment_id` is now a grantable column and the
-- self-update policy would otherwise let a member move themselves into someone
-- else's flat — taking that flat's billing address, notices and (once dues land)
-- its balance with them.
--
-- `is_primary` is the same door from the other side: a member who could set it on
-- their own row would be claiming the flat's primary occupancy without an admin
-- deciding it. Both are admin decisions, so both are refused here rather than by
-- the grant — the grant has to exist for the admin path.
CREATE OR REPLACE FUNCTION public.chk_member_self_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller uuid := (SELECT auth.uid());
BEGIN
  -- No JWT (service_role, a migration, the API's own connection, or the
  -- `ON DELETE SET NULL` cascade from `auth.users`): the server path, which is
  -- trusted and audited elsewhere. The ordering matters — the cascade that
  -- nulls `user_id` when an account is deleted (PRD §3.1 keeps the financial
  -- rows) must not be mistaken for a client rewriting a membership.
  IF caller IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.society_id <> OLD.society_id THEN
    RAISE EXCEPTION 'MEMBER_SOCIETY_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;

  -- The membership's subject never changes. (A NULL ⇄ value change would move
  -- a shadow member's history onto someone else.) Column grants already exclude
  -- both columns; this is the second lock on the same door.
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'MEMBER_USER_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;

  -- Someone else's row: governed by RLS and the admin paths, not by this rule.
  IF OLD.user_id IS DISTINCT FROM caller THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'MEMBER_ROLE_CHANGE_FORBIDDEN'
      USING ERRCODE = 'P0001',
            HINT = 'Only a society Admin can change roles.';
  END IF;

  -- New in T045: which flat a membership belongs to, and whether it is that
  -- flat's primary occupant, are admin decisions.
  IF NEW.apartment_id IS DISTINCT FROM OLD.apartment_id
     OR NEW.is_primary IS DISTINCT FROM OLD.is_primary THEN
    RAISE EXCEPTION 'MEMBER_APARTMENT_CHANGE_FORBIDDEN'
      USING ERRCODE = 'P0001',
            HINT = 'Only a society Admin can move a membership to another flat.';
  END IF;

  -- Self-service is leaving, withdrawing a request and asking again:
  --   pending|active → removed   (leave / withdraw)
  --   removed        → pending   (ask to rejoin)
  -- Everything else — above all `→ active` — is an approval, and an approval by
  -- the person being approved is how a join queue becomes decorative.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       (NEW.status = 'removed' AND OLD.status IN ('pending', 'active'))
       OR (NEW.status = 'pending' AND OLD.status = 'removed')
     ) THEN
    RAISE EXCEPTION 'MEMBER_STATUS_CHANGE_FORBIDDEN'
      USING ERRCODE = 'P0001',
            HINT = 'Joining a society needs an Admin to approve it.';
  END IF;

  RETURN NEW;
END;
$$;

-- Same rule as the original, with `removed_by` filled in. It is deliberately not a
-- grantable column: "who removed this member?" is an accountability question, and a
-- client that could answer it could answer it wrongly. `SECURITY DEFINER` so the
-- lookup does not depend on the caller being able to read the roster — the WHERE
-- still pins the caller, so it can only ever record them or nobody.
CREATE OR REPLACE FUNCTION public.stamp_member_removal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'removed' AND OLD.status IS DISTINCT FROM 'removed' THEN
    IF NEW.removed_at IS NULL THEN
      NEW.removed_at := now();
    END IF;
    IF NEW.removed_by IS NULL THEN
      SELECT m.id INTO NEW.removed_by
        FROM public.members m
       WHERE m.society_id = NEW.society_id
         AND m.user_id = (SELECT auth.uid())
       LIMIT 1;
    END IF;
  END IF;
  IF NEW.status = 'active' AND NEW.joined_at IS NULL THEN
    NEW.joined_at := now();
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.stamp_member_removal() IS
  'Stamps removed_at and the acting member on removal, and joined_at on activation. Neither column is grantable, so this is the only writer.';

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────────

-- The second INSERT policy, for the one insert that is not a self-join: an Admin
-- recording an occupant who has no account yet (PRD §3.3 "Add Members … name +
-- phone, creates a *shadow member*"). Every clause is load bearing:
--
--   * `user_id IS NULL` — direct add creates somebody who has not signed up. An
--     Admin cannot use this to attach a *third party's* account to the society
--     without that person's consent, which would make the join flow decorative.
--   * `role = 'resident'` — the default. Roles are assigned through T046, and a
--     shadow member holding `admin` would be an admin nobody can sign in as.
--   * `status = 'active'` — the whole point of a shadow member: they are billable
--     before they have a login. `pending` shadow rows would be invisible to every
--     billing query and unreachable by the approve path, since there is nobody to
--     approve on their behalf.
--   * `removed_at IS NULL` — a live row, matching the self-join policy.
--
-- The approval itself is stamped by `stamp_member_approval()` rather than sent.
DROP POLICY IF EXISTS members_insert_admin ON public.members;
CREATE POLICY members_insert_admin
  ON public.members
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_society_admin(society_id)
    AND user_id IS NULL
    AND role = 'resident'
    AND status = 'active'
    AND removed_at IS NULL
  );

-- No new UPDATE or SELECT policy: `members_update_self_or_admin` already grants an
-- Admin every row of their society (which is how suspend, reactivate, remove and
-- the edit path all work — an Admin writing *someone else's* row), and
-- `members_select_self_or_roster` already grants an active member the roster. The
-- contact-consent rule is enforced a layer above both, in the use cases, because a
-- policy cannot vary by *column*: RLS filters rows, and every row here is one the
-- caller may legitimately see.

-- ─────────────────────────────────────────────────────────────────────────────
-- Privileges
-- ─────────────────────────────────────────────────────────────────────────────

-- Added to `20260920130100_society_rls.sql`'s grants, which stay in force.
--
-- `role`, `user_id`, `is_primary`'s approval stamps, `society_id` and `joined_at`
-- are deliberately absent from the INSERT list: an insert may not choose a role, a
-- subject, an approver or a tenant. `status` *is* listed, because the two policies
-- above pin it to exactly one value each — `pending` for a self-join, `active` for
-- an admin add — and the column cannot be omitted without losing that.
GRANT INSERT (
  display_name, phone, email, apartment_id, is_primary, lease_start, lease_end,
  share_contact, status
) ON public.members TO authenticated;

-- `apartment_id` and `is_primary` are updatable so an Admin can assign or move a
-- membership (and clear the flag). `chk_member_self_change()` is what stops a
-- member doing the same to their own row, and `society_id`/`user_id` remain
-- un-updatable from the core migration: a membership never changes tenant or
-- subject.
GRANT UPDATE (apartment_id, is_primary) ON public.members TO authenticated;
