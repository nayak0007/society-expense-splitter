-- 20260920130000_society_core.sql
--
-- Society module — schema, defaults and invariants (PRD §3.2 "Create Society",
-- SAD §8.2 / §8.5 / §8.6).
--
-- WHY THE SCHEMA IS PART OF A CLIENT-ADAPTER TASK: `SocietyRepositorySupabase`
-- reads and writes these tables directly through PostgREST, and the security
-- boundary for that is RLS (SAD §2.2: "Supabase Auth's auth.uid() integrates
-- natively with Postgres RLS policies"). There is no guard process in between,
-- so the rules a guard would enforce — who may write, what a valid row is, what
-- must never be left in an inconsistent state — have to live in the database.
-- This is the same reasoning as the auth module's `profiles` migration.
--
-- Relationship to SAD §8.2 and the PRD §7 DDL: column names, types, enums and
-- indexes follow them exactly, with three deliberate differences, each called
-- out where it happens:
--   1. `societies.created_by` and `members.user_id` reference `auth.users`
--      (Supabase owns identity; `public.profiles` is the app-facing mirror);
--   2. `members.apartment_id`, its index and `uq_primary_occupant` are NOT here —
--      `apartments` does not exist yet (T043) and a dangling reference would
--      block the migration. They arrive with the structure module;
--   3. three CHECK constraints the PRD DDL leaves implicit (society_type, the
--      join-code shape, pincode) — see each one for the reason.
--
-- Down (run by hand — `supabase db push` is forward-only):
--   DROP TABLE IF EXISTS public.members;
--   DROP TABLE IF EXISTS public.society_settings;
--   DROP TABLE IF EXISTS public.societies;
--   DROP FUNCTION IF EXISTS public.seed_society();
--   DROP FUNCTION IF EXISTS public.prepare_society();
--   DROP FUNCTION IF EXISTS public.chk_admin_present();
--   DROP FUNCTION IF EXISTS public.chk_member_self_change();
--   DROP FUNCTION IF EXISTS public.fill_member_identity();
--   DROP FUNCTION IF EXISTS public.gen_join_code();
--   DROP TYPE IF EXISTS public.subscription_plan;
--   DROP TYPE IF EXISTS public.occupancy_type;
--   DROP TYPE IF EXISTS public.member_status;
--   DROP TYPE IF EXISTS public.member_role;
--   (plus the two types the settings table references: split_strategy, apartment_basis)

-- ─────────────────────────────────────────────────────────────────────────────
-- Enums (PRD §7)
-- ─────────────────────────────────────────────────────────────────────────────

-- Created in DO blocks so this file can be pasted into the SQL editor twice
-- without erroring, which is how the auth migration is expected to be applied.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'member_role') THEN
    CREATE TYPE public.member_role AS ENUM
      ('admin', 'treasurer', 'committee', 'resident', 'tenant', 'guest');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'member_status') THEN
    CREATE TYPE public.member_status AS ENUM
      ('pending', 'active', 'inactive', 'removed', 'rejected');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'occupancy_type') THEN
    CREATE TYPE public.occupancy_type AS ENUM
      ('owner_occupied', 'tenant', 'family_member', 'vacant_owner');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'subscription_plan') THEN
    CREATE TYPE public.subscription_plan AS ENUM
      ('free', 'premium', 'society_pro', 'enterprise');
  END IF;
  -- Referenced by society_settings defaults. Owned by the split engine (T056)
  -- and the structure module (T043), but the columns cannot exist without them.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'split_strategy') THEN
    CREATE TYPE public.split_strategy AS ENUM
      ('equal', 'percentage', 'shares', 'apartment', 'custom');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'apartment_basis') THEN
    CREATE TYPE public.apartment_basis AS ENUM
      ('per_flat', 'per_sqft_carpet', 'per_sqft_builtup', 'per_bhk', 'per_floor_band', 'per_parking_slot');
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Join codes
-- ─────────────────────────────────────────────────────────────────────────────

-- 32 unambiguous uppercase characters. MUST stay identical to
-- JOIN_CODE_ALPHABET in packages/domain/src/society/join-code.ts — that module
-- documents why (`0/O` and `1/I` are misread when a code is spoken over the
-- phone or copied off a notice board), and the domain's `isValidJoinCode` is
-- what the client uses to validate what it types. Divergence between the two
-- would let the database mint a code the client rejects.
CREATE OR REPLACE FUNCTION public.gen_join_code()
RETURNS text
LANGUAGE plpgsql
VOLATILE
SET search_path = ''
AS $$
DECLARE
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  candidate text;
BEGIN
  LOOP
    -- `gen_random_uuid()` (pg_catalog, so no extension and no search_path
    -- dependency) supplies the entropy: a v4 uuid printed as hex gives 32 hex
    -- digits, and one byte maps onto the 32-character alphabet with no modulo
    -- bias because 256 is an exact multiple of 32.
    SELECT string_agg(
             substr(alphabet, 1 + (get_byte(decode(substr(hex, pos, 2), 'hex'), 0) % 32), 1),
             ''
           )
      INTO candidate
      FROM (SELECT replace(gen_random_uuid()::text, '-', '') AS hex) AS r,
           generate_series(1, 11, 2) AS pos;

    -- Uniqueness is checked here rather than left to the UNIQUE constraint alone
    -- so the common case never surfaces as a constraint violation. Two
    -- concurrent inserts can still collide on the narrow window between this
    -- check and the insert; the repository retries once when the unique
    -- violation names the join-code index (PRD T040: "Join-code collision
    -- retries and succeeds").
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.societies s WHERE s.join_code = candidate);
  END LOOP;
  RETURN candidate;
END;
$$;

COMMENT ON FUNCTION public.gen_join_code() IS
  'Mints a unique 6-character join code from the unambiguous alphabet. Server-side only — EXECUTE is revoked from client roles.';

-- ─────────────────────────────────────────────────────────────────────────────
-- societies
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.societies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  -- Derivable from the name, and derived in `prepare_society()` rather than by
  -- the client: uniqueness is a storage concern, and a client-side
  -- "check then insert" leaves a race that a UNIQUE constraint would then turn
  -- into a failed create.
  slug varchar(180) NOT NULL UNIQUE,
  society_type varchar(24) NOT NULL DEFAULT 'apartment',
  registration_no varchar(64),
  address_line1 varchar(200),
  address_line2 varchar(200),
  city varchar(80) NOT NULL,
  state varchar(80) NOT NULL,
  pincode varchar(10),
  country char(2) NOT NULL DEFAULT 'IN',
  currency char(3) NOT NULL DEFAULT 'INR',
  timezone varchar(48) NOT NULL DEFAULT 'Asia/Kolkata',
  logo_key text,
  join_code varchar(8) NOT NULL UNIQUE,
  join_code_expires_at timestamptz,
  plan public.subscription_plan NOT NULL DEFAULT 'free',
  plan_expires_at timestamptz,
  -- ON DELETE RESTRICT, not CASCADE: a society is a tenant with financial
  -- history behind it (PRD §3.1 keeps anonymised financial rows; §3.3 refuses to
  -- delete a member's history). Deleting the auth user must therefore be an
  -- explicit transfer-then-delete operation, never an accident of a cascade.
  created_by uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,

  -- The PRD leaves `society_type` an open varchar; the domain, the contract and
  -- the client all enumerate the same five values. Without this CHECK a typo
  -- ('appartment') creates a society the app can never render.
  CONSTRAINT societies_society_type_check CHECK (
    society_type IN ('apartment', 'villa', 'rowhouse', 'shared_flat', 'other')
  ),
  -- Same shape the client enforces (`JOIN_CODE_PATTERN`): 6 characters from the
  -- alphabet above. The database is the last line of defence, so a code inserted
  -- by a script or the dashboard is held to it too.
  CONSTRAINT societies_join_code_check CHECK (join_code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  CONSTRAINT societies_pincode_check CHECK (pincode IS NULL OR pincode ~ '^[1-9][0-9]{5}$'),
  CONSTRAINT societies_country_check CHECK (country = 'IN'),
  CONSTRAINT societies_currency_check CHECK (currency = 'INR')
);

COMMENT ON TABLE public.societies IS
  'A society (tenant). Every module below it is scoped by this table''s id — SAD §8.5.';
COMMENT ON COLUMN public.societies.slug IS
  'URL-safe key derived from the name; assigned by prepare_society(), deduplicated with a numeric suffix.';
COMMENT ON COLUMN public.societies.deleted_at IS
  'Soft delete only. Nothing in the app hard-deletes a tenant — see the no-DELETE policy note in the RLS migration.';

CREATE INDEX IF NOT EXISTS idx_societies_city
  ON public.societies (city) WHERE deleted_at IS NULL;
-- Join-by-code lookup runs on every join attempt; the UNIQUE index on join_code
-- already serves it, so no extra index is needed.

-- ─────────────────────────────────────────────────────────────────────────────
-- society_settings — 1:1 with a society
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.society_settings (
  society_id uuid PRIMARY KEY REFERENCES public.societies (id) ON DELETE CASCADE,
  billing_day smallint NOT NULL DEFAULT 1 CHECK (billing_day BETWEEN 1 AND 28),
  due_day smallint NOT NULL DEFAULT 10 CHECK (due_day BETWEEN 1 AND 28),
  grace_days smallint NOT NULL DEFAULT 5,
  late_fee_type varchar(12) NOT NULL DEFAULT 'none',
  late_fee_value_paise bigint NOT NULL DEFAULT 0,
  late_fee_percent numeric(5, 2) NOT NULL DEFAULT 0,
  default_split_strategy public.split_strategy NOT NULL DEFAULT 'equal',
  default_apartment_basis public.apartment_basis,
  approval_threshold_paise bigint NOT NULL DEFAULT 1000000,
  bill_vacant_flats boolean NOT NULL DEFAULT true,
  allow_partial_payments boolean NOT NULL DEFAULT true,
  defaulter_list_public boolean NOT NULL DEFAULT false,
  bill_presentation varchar(16) NOT NULL DEFAULT 'composite',
  financial_year_start_month smallint NOT NULL DEFAULT 4 CHECK (
    financial_year_start_month BETWEEN 1 AND 12
  ),
  ai_features_enabled boolean NOT NULL DEFAULT true,
  -- Payment credentials. Column grants in the RLS migration keep these
  -- server-side: the client may read the masked values and never write them.
  razorpay_account_id varchar(64),
  bank_account_name varchar(120),
  bank_account_masked varchar(24),
  bank_ifsc varchar(16),
  upi_vpa varchar(80),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT society_settings_late_fee_type_check CHECK (
    late_fee_type IN ('none', 'flat', 'percent')
  )
);

COMMENT ON TABLE public.society_settings IS
  'Per-society configuration (PRD §3.2 step 3). Seeded on creation by seed_society(); there is no INSERT grant for clients.';
COMMENT ON COLUMN public.society_settings.financial_year_start_month IS
  '4 = April, the Indian financial year (PRD §3.2 step 3). Drives every FY-scoped report.';

-- ─────────────────────────────────────────────────────────────────────────────
-- members
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES public.societies (id) ON DELETE CASCADE,
  -- NULL = shadow member (a flat's occupant recorded by an admin before they
  -- had an account — PRD §3.2). UNIQUE(society_id, user_id) tolerates many NULLs.
  user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  display_name varchar(120) NOT NULL,
  phone varchar(16),
  email text,
  role public.member_role NOT NULL DEFAULT 'resident',
  status public.member_status NOT NULL DEFAULT 'pending',
  occupancy public.occupancy_type NOT NULL DEFAULT 'owner_occupied',
  is_primary boolean NOT NULL DEFAULT false,
  lease_start date,
  lease_end date,
  share_contact boolean NOT NULL DEFAULT false,
  joined_at timestamptz,
  approved_by uuid REFERENCES public.members (id),
  removed_at timestamptz,
  removed_by uuid REFERENCES public.members (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT members_society_user_key UNIQUE (society_id, user_id)
);

COMMENT ON TABLE public.members IS
  'Membership: the join between a user and a society, and the only place a role exists (roles are per-membership, never global — PRD §2).';

CREATE INDEX IF NOT EXISTS idx_members_society_status ON public.members (society_id, status);
CREATE INDEX IF NOT EXISTS idx_members_user ON public.members (user_id);
CREATE INDEX IF NOT EXISTS idx_members_society_active
  ON public.members (society_id) WHERE status = 'active';

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at
-- ─────────────────────────────────────────────────────────────────────────────

-- `touch_updated_at()` is created by the auth migration (SAD §8.1). Attached
-- here to the three new tables; it also bumps `version` when a table has one,
-- which none of these do yet.
DROP TRIGGER IF EXISTS set_societies_updated_at ON public.societies;
CREATE TRIGGER set_societies_updated_at
  BEFORE UPDATE ON public.societies
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS set_society_settings_updated_at ON public.society_settings;
CREATE TRIGGER set_society_settings_updated_at
  BEFORE UPDATE ON public.society_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS set_members_updated_at ON public.members;
CREATE TRIGGER set_members_updated_at
  BEFORE UPDATE ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- societies — derived columns
-- ─────────────────────────────────────────────────────────────────────────────

-- SECURITY DEFINER is not needed here (the row is the caller's own), but the
-- function must run with a known search_path: it is called from an INSERT whose
-- caller controls nothing, and a definer-free function still inherits the
-- session's search_path.
CREATE OR REPLACE FUNCTION public.prepare_society()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  base_slug text;
  candidate text;
  suffix int := 1;
BEGIN
  NEW.name := btrim(NEW.name);
  NEW.city := btrim(NEW.city);
  NEW.state := btrim(NEW.state);

  IF TG_OP = 'UPDATE' AND NEW.name = OLD.name THEN
    -- Name unchanged: keep the slug (and its history) exactly as it was.
    NEW.slug := OLD.slug;
  ELSE
    -- Diacritics are not folded here (SQL has no NFKD in the standard library);
    -- the domain's `slugify` is the folding implementation and remains the
    -- offline/mock path. What matters for the database is that the slug is
    -- non-empty, URL-safe and unique.
    base_slug := NULLIF(btrim(regexp_replace(lower(NEW.name), '[^a-z0-9]+', '-', 'g'), '-'), '');
    base_slug := left(COALESCE(base_slug, 'society'), 170);

    candidate := base_slug;
    WHILE EXISTS (
      SELECT 1 FROM public.societies s
       WHERE s.slug = candidate AND s.id IS DISTINCT FROM NEW.id
    ) LOOP
      suffix := suffix + 1;
      candidate := base_slug || '-' || suffix;
    END LOOP;
    NEW.slug := candidate;
  END IF;

  IF TG_OP = 'INSERT' AND (NEW.join_code IS NULL OR btrim(NEW.join_code) = '') THEN
    NEW.join_code := public.gen_join_code();
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.prepare_society() IS
  'Trims text fields, derives a unique slug from the name and mints the join code on insert. Never trusts a client-supplied slug.';

DROP TRIGGER IF EXISTS prepare_society_before_write ON public.societies;
CREATE TRIGGER prepare_society_before_write
  BEFORE INSERT OR UPDATE ON public.societies
  FOR EACH ROW EXECUTE FUNCTION public.prepare_society();

-- ─────────────────────────────────────────────────────────────────────────────
-- societies — creation side effects
-- ─────────────────────────────────────────────────────────────────────────────

-- PRD §3.2: "Creation seeds society_settings … the creator becomes Society
-- Admin." Both happen in the same transaction as the INSERT, so a society can
-- never exist for a moment without its admin — and the client needs exactly one
-- request to create a coherent tenant.
--
-- SECURITY DEFINER because the seeding writes rows the caller has no direct
-- grant for (`society_settings` has no INSERT grant; the `members` INSERT policy
-- only accepts a self-join as a pending resident). `SET search_path = ''` plus
-- fully-qualified names is the documented hardening for definer functions.
CREATE OR REPLACE FUNCTION public.seed_society()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  creator_name text;
  creator_email text;
  creator_phone text;
BEGIN
  -- DB defaults (PRD §3.2 step 3); the client's chosen values are applied
  -- immediately after, inside the same transaction, by society_create().
  INSERT INTO public.society_settings (society_id)
  VALUES (NEW.id)
  ON CONFLICT (society_id) DO NOTHING;

  SELECT
    COALESCE(NULLIF(btrim(p.full_name), ''), NULLIF(split_part(COALESCE(p.email, ''), '@', 1), '')),
    p.email,
    p.phone
    INTO creator_name, creator_email, creator_phone
    FROM public.profiles p
   WHERE p.id = NEW.created_by;

  INSERT INTO public.members (
    society_id, user_id, display_name, phone, email, role, status, occupancy, is_primary, joined_at
  )
  VALUES (
    NEW.id,
    NEW.created_by,
    left(COALESCE(creator_name, 'Admin'), 120),
    creator_phone,
    creator_email,
    'admin',
    'active',
    'owner_occupied',
    true,
    now()
  )
  ON CONFLICT (society_id, user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.seed_society() IS
  'Seeds society_settings and makes the creator an active Admin, in the creating transaction (PRD §3.2).';

DROP TRIGGER IF EXISTS seed_society_after_insert ON public.societies;
CREATE TRIGGER seed_society_after_insert
  AFTER INSERT ON public.societies
  FOR EACH ROW EXECUTE FUNCTION public.seed_society();

-- ─────────────────────────────────────────────────────────────────────────────
-- members — identity defaults
-- ─────────────────────────────────────────────────────────────────────────────

-- A self-join sends only (society_id, occupancy): the client has no grant for
-- display_name/phone/email, so it cannot misrepresent itself, and the row is
-- still complete because this trigger fills the identity from the caller's own
-- profile. A missing name is not a reason to reject a join, so it falls back
-- through email → phone → 'Member' rather than failing.
CREATE OR REPLACE FUNCTION public.fill_member_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  p_full text;
  p_email text;
  p_phone text;
BEGIN
  IF NEW.user_id IS NULL OR NULLIF(btrim(NEW.display_name), '') IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.full_name, p.email, p.phone
    INTO p_full, p_email, p_phone
    FROM public.profiles p
   WHERE p.id = NEW.user_id;

  NEW.display_name := left(
    COALESCE(
      NULLIF(btrim(p_full), ''),
      NULLIF(split_part(COALESCE(p_email, ''), '@', 1), ''),
      NULLIF(btrim(p_phone), ''),
      'Member'
    ),
    120
  );
  NEW.email := COALESCE(NEW.email, p_email);
  NEW.phone := COALESCE(NEW.phone, p_phone);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fill_member_identity_before_insert ON public.members;
CREATE TRIGGER fill_member_identity_before_insert
  BEFORE INSERT ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.fill_member_identity();

-- ─────────────────────────────────────────────────────────────────────────────
-- members — invariants
-- ─────────────────────────────────────────────────────────────────────────────

-- Phase 3 definition of done: *a society can never be left without an active
-- admin*. The client evaluates the same rule (`canLeaveSociety`) before it
-- asks, so this trigger only ever fires on a bug, a stale client or a direct SQL
-- write — which is exactly when it matters.
--
-- DEFERRABLE INITIALLY DEFERRED on purpose: the check runs at COMMIT, so a
-- transaction that promotes a replacement admin and removes the old one in one
-- go is legal, while a lone removal is not.
CREATE OR REPLACE FUNCTION public.chk_admin_present()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  remaining int;
BEGIN
  -- Only a write that removes an *active admin* can orphan a society.
  IF OLD.role <> 'admin' OR OLD.status <> 'active' THEN
    RETURN NULL;
  END IF;

  -- The row is still an active admin (a name change, an occupancy edit): nothing
  -- was lost, so an ordinary update of an admin must not trip this.
  IF TG_OP = 'UPDATE'
     AND NEW.society_id = OLD.society_id
     AND NEW.role = 'admin'
     AND NEW.status = 'active' THEN
    RETURN NULL;
  END IF;

  -- A cascade from the society itself (hard delete) and a soft-deleted tenant are
  -- neither of them an orphaning: there is no live society left to administer.
  -- Without the deleted_at test, `society_soft_delete()` — which removes every
  -- membership — could never commit.
  IF NOT EXISTS (
    SELECT 1 FROM public.societies s
     WHERE s.id = OLD.society_id AND s.deleted_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO remaining
    FROM public.members m
   WHERE m.society_id = OLD.society_id
     AND m.role = 'admin'
     AND m.status = 'active'
     AND m.id <> OLD.id;

  IF remaining = 0 THEN
    RAISE EXCEPTION 'SOCIETY_ADMIN_REQUIRED'
      USING ERRCODE = 'P0001',
            HINT = 'Promote another member to Admin before leaving or changing this role.';
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.chk_admin_present() IS
  'Refuses a commit that would leave a society with no active admin (Phase 3 DoD). Deferred, so promote-and-replace in one transaction is allowed.';

DROP TRIGGER IF EXISTS chk_admin_present_after_member_write ON public.members;
CREATE CONSTRAINT TRIGGER chk_admin_present_after_member_write
  AFTER UPDATE OR DELETE ON public.members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.chk_admin_present();

-- The other half of safe self-service: a member may edit their own row, but may
-- never promote themselves. RLS decides *whose* row may be written (and the
-- column grants decide which columns at all); this trigger decides whether the
-- transition is a legitimate one, because `WITH CHECK` cannot see the old row.
--
-- Roles and approvals belong to the admin paths (T045/T046), not to a member.
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

DROP TRIGGER IF EXISTS chk_member_self_change_before_update ON public.members;
CREATE TRIGGER chk_member_self_change_before_update
  BEFORE UPDATE ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.chk_member_self_change();

-- Removing a member (leaving, or a tenant being deleted) must stamp removed_at,
-- so "when did they go?" is answerable without a second table.
CREATE OR REPLACE FUNCTION public.stamp_member_removal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'removed' AND OLD.status IS DISTINCT FROM 'removed' AND NEW.removed_at IS NULL THEN
    NEW.removed_at := now();
  END IF;
  IF NEW.status = 'active' AND NEW.joined_at IS NULL THEN
    NEW.joined_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS stamp_member_removal_before_update ON public.members;
CREATE TRIGGER stamp_member_removal_before_update
  BEFORE UPDATE ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.stamp_member_removal();
