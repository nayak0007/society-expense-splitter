-- ============================================================================
-- Fix · `society_join_options()` shadows its own `society_id` variable
-- ============================================================================
--
-- The regression, and where it came from:
--
--   * T049's `20260926130000_join_requests.sql` declared `society_id uuid;` as
--     the function's resolved society, then wrote `WHERE a.society_id =
--     society_id` — an unqualified name that PL/pgSQL cannot resolve: it could
--     be the local variable or the column `a.society_id`, and with the default
--     `plpgsql.variable_conflict = error` the ambiguity is a hard failure, not a
--     preference. The whole function raised
--     `column reference "society_id" is ambiguous` on its first call, i.e. the
--     join screen's flat list was broken for every caller.
--   * Nothing in the TypeScript was wrong and no test double could see it: the
--     API unit tests mock the repository, and the repository's `joinOptions()`
--     is a thin `select … from public.society_join_options(…)`. Only a real
--     `SELECT` against a live function raises this, which is exactly what
--     `scripts/db/rls-canary.sql` does.
--
-- The fix is a rename: `v_society_id` cannot collide with any column the
-- function reads. The body is otherwise identical to
-- `20260926130000_join_requests.sql`, including the intended projection and the
-- `SOCIETY_JOIN_CODE_INVALID` refusal for a code that matches nothing.
--
-- A new migration rather than an edit because `20260926130000` is already
-- applied (and applied migrations are immutable — the runner checksums them);
-- the only correct way to change a definer function on a live database is to
-- replace it.
--
-- ── down ────────────────────────────────────────────────────────────────────
--   Re-run the `CREATE OR REPLACE FUNCTION public.society_join_options()` from
--   `20260926130000_join_requests.sql` — which reintroduces the ambiguity and
--   the failure. A database that keeps this fix is the only working one.
-- ============================================================================

-- Body unchanged from `20260926130000_join_requests.sql` except the local
-- variable's name — when that function changes, both copies must.
CREATE OR REPLACE FUNCTION public.society_join_options(
  p_code text,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_society_id uuid;
  cap integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  needle text := NULLIF(btrim(COALESCE(p_query, '')), '');
  flats jsonb;
  total integer;
BEGIN
  SELECT s.id INTO v_society_id
    FROM public.societies s
   WHERE s.deleted_at IS NULL
     AND s.join_code = upper(btrim(p_code))
   LIMIT 1;

  IF v_society_id IS NULL THEN
    RAISE EXCEPTION 'SOCIETY_JOIN_CODE_INVALID'
      USING ERRCODE = 'P0001',
            HINT = 'That join code does not match any society.';
  END IF;

  SELECT count(*)::int INTO total
    FROM public.apartments a
    JOIN public.buildings b ON b.id = a.building_id
   WHERE a.society_id = v_society_id
     AND a.deleted_at IS NULL
     AND (
       needle IS NULL
       OR a.apartment_number ILIKE '%' || needle || '%'
       OR b.name ILIKE '%' || needle || '%'
     );

  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id', flat.id,
               'number', flat.apartment_number,
               'buildingId', flat.building_id,
               'buildingName', flat.building_name,
               'wingId', flat.wing_id,
               'wingName', flat.wing_name,
               'floor', flat.floor
             )
             ORDER BY flat.building_name, flat.apartment_number
           ),
           '[]'::jsonb
         )
    INTO flats
    FROM (
      SELECT a.id,
             a.apartment_number,
             a.building_id,
             a.wing_id,
             a.floor,
             b.name AS building_name,
             w.name AS wing_name
        FROM public.apartments a
        JOIN public.buildings b ON b.id = a.building_id
        LEFT JOIN public.wings w ON w.id = a.wing_id
       WHERE a.society_id = v_society_id
         AND a.deleted_at IS NULL
         AND (
           needle IS NULL
           OR a.apartment_number ILIKE '%' || needle || '%'
           OR b.name ILIKE '%' || needle || '%'
         )
       ORDER BY b.name, a.apartment_number
       LIMIT cap
    ) AS flat;

  RETURN jsonb_build_object(
    'society_id', v_society_id,
    'flats', flats,
    'total', total,
    'truncated', total > cap
  );
END;
$$;

COMMENT ON FUNCTION public.society_join_options(text, text, integer) IS
  'The flats a join code''s society offers the join screen (id, number, building, wing, floor) — definer, because a requester is not a member yet (T049).';

-- `CREATE OR REPLACE` keeps the existing ACL, but restating it is cheap and
-- makes this file stand alone if it is ever replayed into a fresh database
-- before `20260926130000` (it cannot be — the runner is ordered — but the
-- grants are part of the function's contract either way).
REVOKE ALL ON FUNCTION public.society_join_options(text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.society_join_options(text, text, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.society_join_options(text, text, integer) TO authenticated;
