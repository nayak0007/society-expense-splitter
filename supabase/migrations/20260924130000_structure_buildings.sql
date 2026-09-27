-- 20260924130000_structure_buildings.sql
--
-- `public.buildings` — the first level of a society's physical structure
-- (PRD §7 "STRUCTURE", SAD §8.2/§8.5), for Roadmap T042.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why `buildings` only, and not `wings` / `apartments`
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The PRD's structure DDL defines the three tables together, but they do not
-- become useful together. `wings` exists only to group apartments and
-- `apartments.wing_id` is its only consumer, so a wings table created here would
-- be a column nobody can populate and a foreign key nobody can exercise —
-- including the `UNIQUE (building_id, name)` constraint this migration would have
-- to choose without knowing what a wing is for. They land with T043/T044, in the
-- migration that also creates `apartments`, which is the first migration that can
-- test them. T042's remaining scope is recorded in `docs/Roadmap.md`.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why create/update are plain DML and only delete is a function
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The society module's writes are all `SECURITY DEFINER` RPCs, because each of
-- them owns a derived value or a multi-table invariant: `society_create` mints the
-- slug and the join code, seeds settings and the creator's Admin membership, and
-- `society_update` has to touch two tables atomically. A building has none of
-- that. Its columns are all caller-supplied, so an INSERT with the column grants
-- below and an admin-only RLS policy is the complete rule — and RLS is the
-- boundary SAD §8.7 establishes, so keeping the write inside it is the *stronger*
-- arrangement rather than the looser one. There is exactly one exception:
--
-- `deleted_at` is deliberately **not granted**, so a soft delete cannot be
-- performed with plain DML. `building_soft_delete()` owns it, exactly as
-- `society_soft_delete()` owns the society's, which keeps "who may remove a
-- building" in one auditable place instead of in the column privilege list.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Two deliberate deviations from the PRD's DDL, both stated rather than silent
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. `updated_at` is added. The PRD's `buildings` block has `created_at` and
--    `deleted_at` only; SAD §8.1 applies the standard column set — `created_at`,
--    `updated_at`, `deleted_at` — to every table, with a `touch_updated_at()`
--    trigger. The SAD is the architecture of record for schema conventions, and an
--    audit trail that cannot say when a building was renamed is worth less than
--    the column costs.
--
-- 2. The name uniqueness constraint is a **partial unique index** on
--    `(society_id, name) WHERE deleted_at IS NULL`, not a table constraint.
--    SAD §8.1 requires partial indexes to carry the soft-delete predicate for
--    this tier of table, and the practical consequence is the point: with a plain
--    `UNIQUE (society_id, name)`, deleting "Block C" would make that name
--    permanently unusable, and a society that renames and later removes a
--    building could never recreate it.
--
-- `structure.view` (a new action in `@ses/domain`) is what lets the read routes be
-- header-scoped and therefore run behind the guard chain; the `authenticated`
-- SELECT grant below plus the member policy is what enforces it in the database.
-- The two are not redundant — RLS is the boundary, the guard is the application
-- layer (SAD §9.4's note, PRD T041).
--
-- Down (by hand, forward-only runner):
--   DROP FUNCTION IF EXISTS public.building_soft_delete(uuid, uuid);
--   DROP TABLE IF EXISTS public.buildings;
--   Safe on its own: nothing references `buildings` yet. Once T043 adds
--   `apartments.building_id`, this rollback must go in the same breath as that
--   table, or the FK will block it.

-- ─────────────────────────────────────────────────────────────────────────────
-- Table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.buildings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id    uuid NOT NULL REFERENCES public.societies (id) ON DELETE CASCADE,
  name          varchar(80) NOT NULL,
  -- Nullable because "not counted yet" is a real state (PRD §7): a society that
  -- has not walked its floors says nothing, and nothing is not zero.
  total_floors  smallint,
  display_order smallint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,

  -- Mirrors `createTotalFloors()` in @ses/domain. The domain is the first line of
  -- defence and this is the last: a value the client accepts and the database
  -- rejects surfaces as a crash at 2am rather than as a field error, so the two
  -- bounds have to agree. A 200-floor residential building does not exist, and a
  -- negative count would corrupt every per-floor generator in T043/T044.
  CONSTRAINT chk_buildings_total_floors
    CHECK (total_floors IS NULL OR (total_floors >= 1 AND total_floors <= 200)),
  CONSTRAINT chk_buildings_display_order
    CHECK (display_order >= 0)
);

COMMENT ON TABLE public.buildings IS
  'A physical building inside one society (PRD §5 hierarchy). Soft-deleted: apartments and history keep their parent, which is why the name uniqueness below is partial.';

COMMENT ON COLUMN public.buildings.total_floors IS
  'Floors above ground, or NULL when not recorded. Never 0 — see chk_buildings_total_floors.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────

-- The hot read path: one society's live buildings in display order. Partial, per
-- SAD §8.1's soft-delete policy, so the index carries the predicate every query
-- filters on and does not grow with deleted rows.
CREATE INDEX IF NOT EXISTS idx_buildings_society
  ON public.buildings (society_id, display_order, name)
  WHERE deleted_at IS NULL;

-- The FK is indexed because Postgres does not do it automatically, and an
-- unindexed FK makes a cascading society delete scan the whole table (SAD §8.1).
CREATE INDEX IF NOT EXISTS idx_buildings_society_fk
  ON public.buildings (society_id);

-- Name uniqueness among *live* buildings only — see deviation 2 in the header.
CREATE UNIQUE INDEX IF NOT EXISTS uq_buildings_society_name
  ON public.buildings (society_id, name)
  WHERE deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at
-- ─────────────────────────────────────────────────────────────────────────────

-- `touch_updated_at()` is created by the auth migration and is the shared
-- convention (SAD §8.1). It also bumps `version` when a table has one, which this
-- one does not.
DROP TRIGGER IF EXISTS set_buildings_updated_at ON public.buildings;
CREATE TRIGGER set_buildings_updated_at
  BEFORE UPDATE ON public.buildings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.buildings ENABLE ROW LEVEL SECURITY;
-- FORCE as well as ENABLE: without it the table owner bypasses its own policies,
-- which is the commonest way an RLS setup fails open.
ALTER TABLE public.buildings FORCE ROW LEVEL SECURITY;

-- Reads: any *active* member of the society. `is_society_member(…, true)` rather
-- than the society module's `false`, and the difference is deliberate — a pending
-- member is shown the society they applied to (so the "waiting for approval"
-- screen can name it) but not its structure. The join flow's building picker is
-- addressed by the join *code*, which is a capability in its own right, and it
-- belongs to the join RPC (T043/T054) rather than to this member-scoped read.
DROP POLICY IF EXISTS buildings_select_member ON public.buildings;
CREATE POLICY buildings_select_member
  ON public.buildings
  FOR SELECT
  TO authenticated
  USING (
    deleted_at IS NULL
    AND public.is_society_member(society_id, true)
  );

-- Writes: Admin only (PRD §2.1, "Create/edit buildings, wings, apartments").
-- A non-member's write is refused here too, but the caller never reaches this
-- point with a non-membership: `SocietyGuard` answers 404 for exactly that case
-- before the handler runs, so what this policy actually decides is
-- member-without-the-role, which the adapter classifies as 403.
DROP POLICY IF EXISTS buildings_insert_admin ON public.buildings;
CREATE POLICY buildings_insert_admin
  ON public.buildings
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_society_admin(society_id));

DROP POLICY IF EXISTS buildings_update_admin ON public.buildings;
CREATE POLICY buildings_update_admin
  ON public.buildings
  FOR UPDATE
  TO authenticated
  USING (public.is_society_admin(society_id))
  WITH CHECK (public.is_society_admin(society_id));

-- No DELETE policy, and DELETE is not granted below. Removing a building is a
-- soft delete (`building_soft_delete()`), because apartments, dues and expenses
-- will reference it and PRD §3.1/§3.3 keep financial history.
--
-- No INSERT policy on `deleted_at` either: it is not a grantable column, so a
-- client cannot create a pre-deleted building.

-- ─────────────────────────────────────────────────────────────────────────────
-- Soft delete
-- ─────────────────────────────────────────────────────────────────────────────

-- `SECURITY DEFINER` because `deleted_at` is not a grantable column (above), so
-- the update has to run as the owner. That makes the Admin check *explicit and
-- mandatory* rather than merely implied by RLS, and it runs first — so a stranger
-- gets `SOCIETY_NOT_FOUND` (404) and a member without the role gets
-- `SOCIETY_FORBIDDEN` (403), in that order. Reporting "forbidden" to a stranger
-- would confirm the society exists (PRD T041).
--
-- `p_society_id` is a separate argument from `p_building_id` on purpose: a
-- building id alone does not say which tenant the caller is acting in, and pairing
-- them here is what makes a building from another society unaddressable rather
-- than merely unreadable.
CREATE OR REPLACE FUNCTION public.building_soft_delete(
  p_building_id uuid,
  p_society_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.assert_society_admin(p_society_id);

  UPDATE public.buildings
     SET deleted_at = now()
   WHERE id = p_building_id
     AND society_id = p_society_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    -- The caller is an active Admin of this society, so they know it exists. Zero
    -- rows therefore means the building is not in it, was already removed, or
    -- never existed — and all three are one answer, because distinguishing them
    -- would let an Admin of society A enumerate society B's building ids.
    RAISE EXCEPTION 'BUILDING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.building_soft_delete(uuid, uuid) IS
  'Admin-only soft delete of one building. 404 for a non-member, 403 for a member without the role, P0002 when the building is not in that society.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Privileges
-- ─────────────────────────────────────────────────────────────────────────────

-- Supabase grants `anon`/`authenticated` ALL on new tables in `public` by default,
-- so these REVOKEs are what turn the policies above into the only path. RLS
-- filters rows; GRANTs decide which *columns* a client may write.
REVOKE ALL ON public.buildings FROM anon;
REVOKE ALL ON public.buildings FROM authenticated;

GRANT SELECT ON public.buildings TO authenticated;

-- Everything the form collects. Not insertable: `id`, `created_at`, `updated_at`
-- (defaults), `deleted_at` (only `building_soft_delete()` sets it).
GRANT INSERT (society_id, name, total_floors, display_order)
  ON public.buildings TO authenticated;

-- `society_id` is not updatable: moving a building between societies would move
-- every apartment inside it across a tenant boundary, and there is no legitimate
-- flow that needs it. The WITH CHECK policy is written against it regardless, so
-- an attempt is refused by RLS as well as by the column grant.
GRANT UPDATE (name, total_floors, display_order)
  ON public.buildings TO authenticated;

REVOKE ALL ON FUNCTION public.building_soft_delete(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.building_soft_delete(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.building_soft_delete(uuid, uuid) TO authenticated;
