-- ============================================================================
-- Fix · `seed_society()` may not create a primary occupant without a flat
-- ============================================================================
--
-- The regression, and where it came from:
--
--   * T043's `20260925120000_members_directory.sql` added
--     `chk_members_primary_requires_apartment` — "the primary occupant is the
--     person the flat's dues are addressed to, so the flag is meaningless
--     without a flat". A correct constraint.
--   * `seed_society()` (T042, `20260920130000_society_core.sql`) inserts the
--     creator's Admin membership with `is_primary => true` and no `apartment_id`.
--     At the time that was a harmless default; a society's creator has no flat
--     yet — no building or apartment row can exist in the creating transaction.
--   * Together: every `society_create()` call fails with
--     `chk_members_primary_requires_apartment`, i.e. creating a society was
--     broken on any database carrying both migrations. The API's e2e suite uses
--     fake repositories and never noticed; the RLS canary creates a real society
--     and did.
--
-- The fix is one value: the creator is an active Admin, not yet a primary
-- occupant of anything. Their `is_primary` flips to true when an Admin (or the
-- directory flow) assigns them a flat, through the ordinary grantable path.
--
-- A new migration rather than an edit because `20260925120000` is already
-- applied; the only correct way to change a definer function on a live database
-- is to replace it.
--
-- ── down ────────────────────────────────────────────────────────────────────
--   Re-run the `CREATE OR REPLACE FUNCTION public.seed_society()` from
--   `20260920130000_society_core.sql` (which sets `is_primary => true`), or, on a
--   database where the flag is already fixed, leave it as is: this migration is a
--   correction, not a feature, and reverting it reintroduces the broken insert.
-- ============================================================================

-- Body unchanged from `20260920130000_society_core.sql` except the commented
-- `is_primary` argument below — when that insert changes, both copies must.
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

  -- `is_primary` is false: the creator holds no flat yet (none can exist in this
  -- transaction), and `chk_members_primary_requires_apartment` — correctly —
  -- refuses `true` without an `apartment_id`. The creator becomes the flat's
  -- primary occupant the day a flat is assigned to them, not before.
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
    false,
    now()
  )
  ON CONFLICT (society_id, user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.seed_society() IS
  'Seeds society_settings and makes the creator an active Admin, in the creating transaction (PRD §3.2). The creator holds no flat, so is_primary is false (chk_members_primary_requires_apartment).';
