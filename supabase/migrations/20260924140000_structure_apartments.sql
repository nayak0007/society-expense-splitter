-- 20260924140000_structure_apartments.sql
--
-- `public.wings` and `public.apartments` — the last two levels of a society's
-- physical structure (PRD §5/§7 "STRUCTURE", SAD §8.2/§8.5), for Roadmap T043.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why wings land here, having been deliberately deferred by T042
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `20260924130000_structure_buildings.sql` left `wings` out on the grounds that
-- "a wings table created there would be a column nobody can populate and a
-- foreign key nobody can exercise", and named this migration as where it belongs.
-- That reasoning still holds for the *reference*: apartments are the only thing
-- that points at a wing. What changes here is that the referencing table exists,
-- so `apartments.wing_id` can be given a real, testable guarantee (below) instead
-- of a column that is always NULL for reasons nothing checks.
--
-- Wings still have **no write API**, so no client can create one yet. That is
-- recorded in `docs/Roadmap.md` rather than papered over: the table exists so the
-- hierarchy the PRD models is representable, and wing CRUD arrives as pure
-- addition rather than as a schema change to live financial-adjacent data.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- The wing/building pairing is enforced by the database, not by a check somewhere
-- ─────────────────────────────────────────────────────────────────────────────
--
-- "This apartment's wing belongs to this apartment's building" is a cross-table
-- invariant, and the obvious way to write it — a plain
-- `wing_id REFERENCES wings (id)` plus a validation step in the use case — leaves
-- the guarantee in the application layer alone, where a second writer (a bulk
-- import, a repair script, a future Nest module) can bypass it silently. An
-- apartment in Block A whose wing belongs to Block B is not a cosmetic problem:
-- every per-wing rollup and maintenance grouping reads the wrong branch.
--
-- So the foreign key is **composite and self-consistent**:
--
--   foreign key (wing_id, building_id) references wings (id, building_id)
--     on delete set null (wing_id)
--
-- which the database enforces for every writer, forever, with no code path able
-- to skip it. The column-specific `ON DELETE SET NULL (wing_id)` is what makes it
-- expressible: a plain `SET NULL` would null `building_id` too, and that column is
-- NOT NULL by design. It requires **PostgreSQL 15+** (Supabase runs 15+; the
-- project's CI container and local dev are on 18), which is stated here because a
-- downlevel server fails this migration at parse time rather than at runtime.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why create/update are plain DML and only delete is a function
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The same reasoning `…_structure_buildings.sql` records, unchanged: every column
-- is caller-supplied, so an INSERT under the admin-only policy plus the column
-- grants *is* the complete rule, and keeping the write inside RLS is the stronger
-- arrangement rather than the looser one. `deleted_at` is the single exception —
-- it is deliberately not a granted column, so `apartment_soft_delete()` owns it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Three deliberate deviations from the PRD's DDL, all stated rather than silent
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 1. `updated_at` and the `touch_updated_at()` trigger are added to both tables.
--    SAD §8.1 applies the standard column set to every table; the PRD's
--    `apartments` block carries `created_at`/`deleted_at` only.
--
-- 2. `apartments.building_id` is **`ON DELETE RESTRICT`**, where the PRD writes
--    `ON DELETE CASCADE`. Nothing hard-deletes a building (removal is
--    `building_soft_delete()`), so today the difference is unreachable — but it is
--    the difference between a future `DELETE FROM buildings` failing loudly and
--    silently taking every flat, and the financial rows that will hang off them,
--    with it. RESTRICT is the safe direction to be wrong in, and
--    `building_soft_delete()` below is where the *business* rule (report a typed
--    error) is actually implemented.
--
-- 3. The apartment-number uniqueness is a **partial unique index** on
--    `(society_id, building_id, apartment_number) WHERE deleted_at IS NULL`, for
--    the reason the building name index records in full: with a plain constraint,
--    removing flat "101" would make that number permanently unusable, and a
--    society that demolishes and rebuilds a wing could never recreate its flats.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- "A flat's building is a building of the flat's society" — a fourth constraint
-- the PRD does not ask for, added because the PRD's DDL cannot express it and the
-- omission is reachable
-- ─────────────────────────────────────────────────────────────────────────────
-- `apartments.society_id` is denormalised from the building, and nothing in the
-- obvious schema ties the two back together: `building_id REFERENCES buildings
-- (id)` is satisfied by *any* building in the database, and the flat's own
-- `society_id` comes from the caller's header. So an Admin of society B could
-- insert a flat whose tenant is B and whose parent building belongs to A — a row
-- no policy refuses, no check catches, and every per-building rollup of A silently
-- ignores. It is the same class of mistake as an apartment in Block A whose wing
-- is in Block B, which the composite wing key above exists to make
-- unrepresentable; this is its sibling, one level up.
--
-- The fix is the same shape: a **composite foreign key** on
-- `(building_id, society_id)`, which needs a unique constraint on exactly those
-- columns of `buildings`. That constraint is created here rather than in
-- `…_structure_buildings.sql` because this is the migration that creates the
-- reference and therefore the need — and it is redundant as a uniqueness claim
-- (`id` is already the primary key), which is stated so a reader does not go
-- looking for the second meaning.
--
-- The application layer checks the same thing first (`createApartment` loads the
-- building by `(building_id, society_id)`), so this is the second line: the one a
-- bulk import, a repair script or a future writer cannot skip.
--
-- `structure.view` / `structure.edit` are the permissions, unchanged from T042.
-- PRD §2.1 grants "Create/edit buildings, wings, apartments" as **one** Admin-only
-- capability, so apartments add no new action to the catalogue and the guard chain
-- needs no extension — the routes are simply header-scoped like the building ones.
--
-- Down (by hand, forward-only runner). Order matters: the composite FKs are what
-- make `wings` and `buildings` undroppable while anything references them.
--   DROP FUNCTION IF EXISTS public.apartment_soft_delete(uuid, uuid);
--   DROP TABLE IF EXISTS public.apartments;
--   DROP TABLE IF EXISTS public.wings;
--   ALTER TABLE public.buildings DROP CONSTRAINT IF EXISTS uq_buildings_id_society;
--   DROP TYPE IF EXISTS public.occupancy_status;
--   -- and restore the previous body of public.building_soft_delete(uuid, uuid)
--   -- from 20260924130000_structure_buildings.sql.

-- ─────────────────────────────────────────────────────────────────────────────
-- Enum
-- ─────────────────────────────────────────────────────────────────────────────

-- PRD §7.1 defines `occupancy_status` as a real enum, and the guarded `DO` block
-- is the idiom `…_society_core.sql` established: the type is shared vocabulary, so
-- re-running against a database that already has it must be a no-op rather than an
-- error. (`IF NOT EXISTS` is not valid syntax for `CREATE TYPE`.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'occupancy_status') THEN
    CREATE TYPE public.occupancy_status AS ENUM
      ('owner_occupied', 'rented', 'vacant', 'under_construction');
  END IF;
END
$$;

COMMENT ON TYPE public.occupancy_status IS
  'Whether a flat is lived in by its owner, let out, empty, or not finished (PRD §7.1). Drives billing eligibility together with is_billable.';

-- ─────────────────────────────────────────────────────────────────────────────
-- The anchor for the composite building/society foreign keys
-- ─────────────────────────────────────────────────────────────────────────────

-- Both new tables reference `buildings (id, society_id)` rather than `buildings
-- (id)`, which needs a unique constraint on exactly those columns. Added here, not
-- in `…_structure_buildings.sql`, because this is the migration whose constraints
-- need it — `id` is already the primary key, so the constraint's only job is to
-- give the composite reference something to point at, and it must exist *before*
-- the tables below are created rather than after.
ALTER TABLE public.buildings
  DROP CONSTRAINT IF EXISTS uq_buildings_id_society;
ALTER TABLE public.buildings
  ADD CONSTRAINT uq_buildings_id_society UNIQUE (id, society_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- Wings
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.wings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id  uuid NOT NULL REFERENCES public.societies (id) ON DELETE CASCADE,
  building_id uuid NOT NULL REFERENCES public.buildings (id) ON DELETE CASCADE,
  -- See the header: a wing's building must be a building of the wing's own society.
  CONSTRAINT fk_wings_building_society
    FOREIGN KEY (building_id, society_id)
    REFERENCES public.buildings (id, society_id)
    ON DELETE CASCADE,
  name        varchar(40) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- The PRD's `UNIQUE (building_id, name)`, kept as a plain constraint rather than
  -- a partial index: wings carry no `deleted_at`, because SAD §8.5's soft-delete
  -- tier names societies, buildings, apartments, members, announcements and
  -- expense categories — and a table with no delete path has no tombstone to
  -- filter. A wing that is renamed and later renamed back therefore collides with
  -- the old name only while the old name still exists, which is the honest
  -- behaviour for a label that can be edited.
  CONSTRAINT uq_wings_building_name UNIQUE (building_id, name)
);

COMMENT ON TABLE public.wings IS
  'An optional grouping of apartments inside one building (PRD §5: "a 6-flat building should not be forced through" a deep hierarchy). No write API yet — see docs/Roadmap.md T043.';

-- The composite foreign key `apartments (wing_id, building_id)` needs a unique
-- constraint on exactly those columns. `id` is already the primary key, so this is
-- redundant as a uniqueness claim — it exists so the database has something to
-- point the composite reference at, which is what turns "the wing belongs to the
-- building" into a constraint instead of a convention.
ALTER TABLE public.wings
  DROP CONSTRAINT IF EXISTS uq_wings_id_building;
ALTER TABLE public.wings
  ADD CONSTRAINT uq_wings_id_building UNIQUE (id, building_id);



-- ─────────────────────────────────────────────────────────────────────────────
-- Apartments
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.apartments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Denormalised on purpose, exactly as the PRD's DDL has it: `society_id` is the
  -- tenant column, and every policy, grant and index below can then be written
  -- against this row alone instead of joining up through `buildings`. The
  -- alternative — deriving the tenant through the building — makes each RLS
  -- predicate a subquery, and a policy that reads another table is how the
  -- recursion problems in `…_society_rls.sql` started.
  society_id        uuid NOT NULL REFERENCES public.societies (id) ON DELETE CASCADE,
  building_id       uuid NOT NULL REFERENCES public.buildings (id) ON DELETE RESTRICT,
  wing_id           uuid,
  apartment_number  varchar(24) NOT NULL,
  -- Nullable: flats exist on the ground floor and in basements, and a society may
  -- simply not have recorded which floor a flat is on. 0 is a floor, NULL is
  -- "unrecorded", and they are different.
  floor             smallint,
  bhk               numeric(3, 1),
  carpet_area_sqft  numeric(8, 2),
  builtup_area_sqft numeric(8, 2),
  parking_slots     smallint NOT NULL DEFAULT 0,
  share_units       numeric(8, 3) NOT NULL DEFAULT 1,
  occupancy_status  public.occupancy_status NOT NULL DEFAULT 'vacant',
  is_commercial     boolean NOT NULL DEFAULT false,
  is_billable       boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,

  -- See the header: one constraint, enforced for every writer, tying the wing to
  -- the building. `ON DELETE SET NULL (wing_id)` is the PostgreSQL 15+ form that
  -- leaves `building_id` intact.
  CONSTRAINT fk_apartments_wing
    FOREIGN KEY (wing_id, building_id)
    REFERENCES public.wings (id, building_id)
    ON DELETE SET NULL (wing_id),

  -- The sibling guarantee, one level up: a flat's building must be a building of
  -- the flat's own society. RESTRICT, matching `apartments_building_id_fkey` and for
  -- the reason deviation 2 gives — nothing hard-deletes a building, and if one ever
  -- does, failing loudly is the safe direction.
  CONSTRAINT fk_apartments_building_society
    FOREIGN KEY (building_id, society_id)
    REFERENCES public.buildings (id, society_id)
    ON DELETE RESTRICT,

  -- Mirrors `createApartmentNumber()`. Whitespace-only is not a number, and the
  -- column width is the domain's bound as well, so a value the client accepts is
  -- one the database accepts.
  CONSTRAINT chk_apartments_number_not_blank
    CHECK (length(btrim(apartment_number)) > 0),

  -- Mirrors `createFloor()`. The range is generous in both directions because
  -- real buildings have basements (negative) and no residential block has 200
  -- floors; a value outside it is a typo, and a typo that reached the per-floor
  -- generators downstream would produce a nonsense bill rather than an error.
  CONSTRAINT chk_apartments_floor
    CHECK (floor IS NULL OR (floor >= -5 AND floor <= 200)),

  -- Mirrors `createBhk()`. Half-BHK configurations are real (1.5 BHK); zero is
  -- not a flat.
  CONSTRAINT chk_apartments_bhk
    CHECK (bhk IS NULL OR (bhk >= 0.5 AND bhk <= 20)),

  -- Both areas sharing one bound, and `builtup >= carpet` enforced below: a
  -- carpet area larger than the built-up area is arithmetically impossible, and
  -- every per-sqft split rule (PRD §4) would silently compute a wrong share from
  -- it rather than failing.
  CONSTRAINT chk_apartments_carpet_area
    CHECK (carpet_area_sqft IS NULL OR (carpet_area_sqft > 0 AND carpet_area_sqft <= 100000)),
  CONSTRAINT chk_apartments_builtup_area
    CHECK (builtup_area_sqft IS NULL OR (builtup_area_sqft > 0 AND builtup_area_sqft <= 100000)),
  CONSTRAINT chk_apartments_area_ordering
    CHECK (
      carpet_area_sqft IS NULL
      OR builtup_area_sqft IS NULL
      OR builtup_area_sqft >= carpet_area_sqft
    ),

  CONSTRAINT chk_apartments_parking_slots
    CHECK (parking_slots >= 0 AND parking_slots <= 20),

  -- Zero is allowed and meaningful: a flat can be exempt from share-based splits
  -- (a caretaker's quarter, a commercial unit billed per sqft). NULL is not —
  -- "no weight" and "weight of zero" are one thing here, and the PRD's default is
  -- 1, so the column is NOT NULL.
  CONSTRAINT chk_apartments_share_units
    CHECK (share_units >= 0 AND share_units <= 10000)
);

COMMENT ON TABLE public.apartments IS
  'One flat inside one building (PRD §5 hierarchy, SAD §8.2). Soft-deleted: members, dues and meter readings will reference it, and financial history keeps its subject.';

COMMENT ON COLUMN public.apartments.society_id IS
  'The tenant column, denormalised from buildings on purpose so every policy and index is expressed against this row alone.';

COMMENT ON COLUMN public.apartments.wing_id IS
  'Optional wing, constrained by fk_apartments_wing to belong to this apartment''s own building.';

COMMENT ON COLUMN public.apartments.share_units IS
  'Manual weight for share-based splits (PRD §4). 0 = exempt; 1 = the default one unit.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────

-- The hot path: one building's live flats in reading order. Partial per SAD §8.1,
-- so the index carries the predicate every query filters on and does not grow with
-- removed flats.
--
-- `apartment_number` is ordered under the C collation deliberately. The default
-- collation on a Supabase database is `en_US.UTF-8`, whose ordering is
-- locale-dependent and can change with a server upgrade — and the domain's
-- `compareApartments()` sorts the same list optimistically on the client. Fixing
-- both to byte order is what keeps "what the server returns" and "what the client
-- shows before the refetch lands" from disagreeing on a list that contains both
-- "2" and "10".
CREATE INDEX IF NOT EXISTS idx_apartments_building
  ON public.apartments (building_id, floor, apartment_number COLLATE "C")
  WHERE deleted_at IS NULL;

-- The FK is indexed because Postgres does not do it automatically, and an
-- unindexed FK makes a cascading society delete scan the whole table (SAD §8.1).
-- `building_id` is covered by the index above; `society_id` and `wing_id` are not.
CREATE INDEX IF NOT EXISTS idx_apartments_society_fk
  ON public.apartments (society_id);

-- Partially indexed rather than fully: a wing is referenced only while its flats
-- are live, and the composite FK needs the lookup to stay cheap as the table grows.
CREATE INDEX IF NOT EXISTS idx_apartments_wing_fk
  ON public.apartments (wing_id)
  WHERE wing_id IS NOT NULL;

-- One live flat per number per building — see deviation 3 in the header. Scoped by
-- `society_id` as well because that is what the PRD's `UNIQUE` names, and because a
-- composite index whose leading column is the tenant is the one a per-society
-- repair query can use.
CREATE UNIQUE INDEX IF NOT EXISTS uq_apartments_building_number
  ON public.apartments (society_id, building_id, apartment_number)
  WHERE deleted_at IS NULL;

-- The wings FK, for the same cascade reason.
CREATE INDEX IF NOT EXISTS idx_wings_society_fk
  ON public.wings (society_id);

CREATE INDEX IF NOT EXISTS idx_wings_building
  ON public.wings (building_id, name);

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at
-- ─────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS set_apartments_updated_at ON public.apartments;
CREATE TRIGGER set_apartments_updated_at
  BEFORE UPDATE ON public.apartments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS set_wings_updated_at ON public.wings;
CREATE TRIGGER set_wings_updated_at
  BEFORE UPDATE ON public.wings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.apartments ENABLE ROW LEVEL SECURITY;
-- FORCE as well as ENABLE: without it the table owner bypasses its own policies,
-- which is the commonest way an RLS setup fails open.
ALTER TABLE public.apartments FORCE ROW LEVEL SECURITY;

-- Reads: any *active* member, matching the building policy's `true` argument for
-- the same reason (a pending member is shown the society, not its structure).
DROP POLICY IF EXISTS apartments_select_member ON public.apartments;
CREATE POLICY apartments_select_member
  ON public.apartments
  FOR SELECT
  TO authenticated
  USING (
    deleted_at IS NULL
    AND public.is_society_member(society_id, true)
  );

-- Writes: Admin only (PRD §2.1, one capability covering buildings, wings and
-- apartments). A non-member never reaches here — `SocietyGuard` answers 404 first —
-- so what this decides is member-without-the-role, which the adapter reports as 403.
DROP POLICY IF EXISTS apartments_insert_admin ON public.apartments;
CREATE POLICY apartments_insert_admin
  ON public.apartments
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_society_admin(society_id));

DROP POLICY IF EXISTS apartments_update_admin ON public.apartments;
CREATE POLICY apartments_update_admin
  ON public.apartments
  FOR UPDATE
  TO authenticated
  USING (public.is_society_admin(society_id))
  WITH CHECK (public.is_society_admin(society_id));

-- No DELETE policy and no DELETE grant: removing a flat is a soft delete
-- (`apartment_soft_delete()`), because dues, members and meter readings will point
-- at it and PRD §3.1/§3.3 keep financial history.

ALTER TABLE public.wings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wings_select_member ON public.wings;
CREATE POLICY wings_select_member
  ON public.wings
  FOR SELECT
  TO authenticated
  USING (public.is_society_member(society_id, true));

-- Insert/update policies exist although no route writes wings yet: the columns are
-- granted below and a policy is what makes those grants safe the moment a wing
-- write path arrives, rather than leaving a window in which the grants are the only
-- control. A route that does not exist cannot be forgotten.
DROP POLICY IF EXISTS wings_insert_admin ON public.wings;
CREATE POLICY wings_insert_admin
  ON public.wings
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_society_admin(society_id));

DROP POLICY IF EXISTS wings_update_admin ON public.wings;
CREATE POLICY wings_update_admin
  ON public.wings
  FOR UPDATE
  TO authenticated
  USING (public.is_society_admin(society_id))
  WITH CHECK (public.is_society_admin(society_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- Soft delete
-- ─────────────────────────────────────────────────────────────────────────────

-- Shape, ordering and error codes are `building_soft_delete()`'s, for the reason
-- that function records: `SECURITY DEFINER` because `deleted_at` is not grantable,
-- the Admin check explicit and first, and 404-before-403 so that reporting
-- "forbidden" to a stranger cannot confirm a society exists (PRD T041).
--
-- `p_society_id` remains a separate argument from the row id: an apartment id alone
-- does not say which tenant the caller is acting in, and pairing them is what makes
-- a flat in another society unaddressable rather than merely unreadable.
CREATE OR REPLACE FUNCTION public.apartment_soft_delete(
  p_apartment_id uuid,
  p_society_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.assert_society_admin(p_society_id);

  UPDATE public.apartments
     SET deleted_at = now()
   WHERE id = p_apartment_id
     AND society_id = p_society_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    -- The caller is an active Admin of this society, so they know it exists; zero
    -- rows therefore means the flat is not in it, was already removed, or never
    -- existed — one answer, because distinguishing them would let an Admin of one
    -- society enumerate another's apartment ids.
    RAISE EXCEPTION 'APARTMENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.apartment_soft_delete(uuid, uuid) IS
  'Admin-only soft delete of one apartment. 404 for a non-member, 403 for a member without the role, P0002 when the apartment is not in that society.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Building deletion now has a child to check
-- ─────────────────────────────────────────────────────────────────────────────

-- The forward half of what `…_structure_buildings.sql` predicted: "It therefore
-- lands with the apartments slice, as a single `IF EXISTS` guard ahead of the soft
-- delete, in the same migration that creates the dependency."
--
-- The rule is a soft-delete rule, so a foreign key cannot express it — RESTRICT
-- above only fires on a hard `DELETE`, which nothing performs. This is the last
-- line of defence for the business rule; `deleteBuilding` in `@ses/application`
-- checks the same thing through the repository and is what produces the message
-- the user reads, because the application layer's answer is the one the mobile app
-- can also produce without a round trip.
--
-- `P0001` (raise_exception) with a named message, matching how `assert_society_admin`
-- reports its refusals: the code alone is not enough to distinguish this from any
-- other plpgsql raise.
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

  -- Checked before the update, and against live flats only: a building whose
  -- apartments were all removed is empty again and may be removed, which is what
  -- makes this a rule about the current structure rather than about history.
  IF EXISTS (
    SELECT 1
      FROM public.apartments
     WHERE building_id = p_building_id
       AND society_id = p_society_id
       AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'BUILDING_HAS_APARTMENTS' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.buildings
     SET deleted_at = now()
   WHERE id = p_building_id
     AND society_id = p_society_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BUILDING_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.building_soft_delete(uuid, uuid) IS
  'Admin-only soft delete of one building. Refuses with P0001/BUILDING_HAS_APARTMENTS while any live apartment points at it.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Privileges
-- ─────────────────────────────────────────────────────────────────────────────

-- Supabase grants `anon`/`authenticated` ALL on new tables in `public` by default,
-- so these REVOKEs are what turn the policies above into the only path. RLS filters
-- rows; GRANTs decide which *columns* a client may write.
REVOKE ALL ON public.apartments FROM anon;
REVOKE ALL ON public.apartments FROM authenticated;
REVOKE ALL ON public.wings FROM anon;
REVOKE ALL ON public.wings FROM authenticated;

GRANT SELECT ON public.apartments TO authenticated;
GRANT SELECT ON public.wings TO authenticated;

-- Everything the form collects. Not insertable: `id`, `created_at`, `updated_at`
-- (defaults) and `deleted_at` (only `apartment_soft_delete()` sets it).
GRANT INSERT (
  society_id, building_id, wing_id, apartment_number, floor, bhk,
  carpet_area_sqft, builtup_area_sqft, parking_slots, share_units,
  occupancy_status, is_commercial, is_billable
) ON public.apartments TO authenticated;

-- `society_id` and `building_id` are not updatable: moving a flat to another
-- building (or another society) would move its members, dues and history across a
-- tenant boundary, and no legitimate flow needs it. Re-pointing `wing_id` is a
-- normal edit and stays available — the composite FK keeps it inside the building.
GRANT UPDATE (
  wing_id, apartment_number, floor, bhk, carpet_area_sqft, builtup_area_sqft,
  parking_slots, share_units, occupancy_status, is_commercial, is_billable
) ON public.apartments TO authenticated;

-- Granted so a wing-write route can be added without a migration. There is no
-- DELETE grant: nothing removes a wing, and the apartments pointing at one are
-- covered by the FK's `ON DELETE SET NULL (wing_id)` if that changes.
GRANT INSERT (society_id, building_id, name) ON public.wings TO authenticated;
GRANT UPDATE (name) ON public.wings TO authenticated;

REVOKE ALL ON FUNCTION public.apartment_soft_delete(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apartment_soft_delete(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.apartment_soft_delete(uuid, uuid) TO authenticated;
