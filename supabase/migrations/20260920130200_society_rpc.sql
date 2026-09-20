-- 20260920130200_society_rpc.sql
--
-- The society RPC surface — the only write paths a client has, and the only way
-- to read a society as a coherent whole.
--
-- WHY FUNCTIONS RATHER THAN PLAIN POSTGREST CALLS:
--   * **Atomicity.** PostgREST cannot send a transaction. Creating a society
--     touches `societies` + `society_settings` + `members`, and editing one can
--     touch two tables; a dropped connection between two HTTP calls would leave
--     half a change behind. Inside a function it is one transaction.
--   * **404 vs 403.** RLS answers "no rows affected" for both "not your tenant"
--     and "not your role". The PRD requires those to be different answers —
--     `not_found` for a non-member (T041: never leak existence) and `forbidden`
--     for a member whose role is insufficient — and only code that first looks up
--     the caller's membership can tell them apart.
--   * **Multi-row writes.** Deleting a tenant marks every membership removed;
--     RLS deliberately forbids a client from updating other members' rows.
--   * **Server-minted secrets.** Slugs and join codes are generated in the
--     database, so uniqueness is not a client-side race.
--
-- Each function states its security context deliberately:
--   SECURITY INVOKER (`create`, `update`) — RLS still applies row by row, so the
--     policies remain the enforcement and a bug here cannot widen access;
--   SECURITY DEFINER (`snapshot`, `soft_delete`, `rotate`, `join_preview`) — the
--     read is several relations (and the roster a count needs is not visible to a
--     pending member), the writes must touch rows the caller has no grant for, or
--     the caller is not a member at all. Every one of them checks membership
--     *before* it returns a row, and `SET search_path = ''` + fully-qualified
--     names closes the usual definer hole.
--
-- Error codes the client maps back to domain codes:
--   P0002 SOCIETY_NOT_FOUND  → not_found        (also used for "not a member")
--   P0003 SOCIETY_FORBIDDEN  → forbidden
--   P0001 + SOCIETY_ADMIN_REQUIRED / MEMBER_*  → sole_admin / forbidden / validation
--
-- Down (run by hand):
--   DROP FUNCTION IF EXISTS public.society_join_preview(text);
--   DROP FUNCTION IF EXISTS public.society_rotate_join_code(uuid);
--   DROP FUNCTION IF EXISTS public.society_soft_delete(uuid);
--   DROP FUNCTION IF EXISTS public.society_update(uuid, jsonb);
--   DROP FUNCTION IF EXISTS public.society_create(jsonb);
--   DROP FUNCTION IF EXISTS public.society_snapshot(uuid);
--   DROP FUNCTION IF EXISTS public.assert_society_membership(uuid);
--   DROP FUNCTION IF EXISTS public.assert_society_admin(uuid);

-- ─────────────────────────────────────────────────────────────────────────────
-- Authorisation helpers
-- ─────────────────────────────────────────────────────────────────────────────

-- The 404-before-403 rule, in one place: "you are not in this society" is
-- indistinguishable from "this society does not exist" (PRD T041).
CREATE OR REPLACE FUNCTION public.assert_society_membership(p_society_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT public.is_society_member(p_society_id, false) THEN
    RAISE EXCEPTION 'SOCIETY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_society_admin(p_society_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Membership first: a stranger gets 404, a member gets 403. Reporting
  -- "forbidden" to a stranger would confirm the society exists.
  PERFORM public.assert_society_membership(p_society_id);
  IF NOT public.is_society_admin(p_society_id) THEN
    RAISE EXCEPTION 'SOCIETY_FORBIDDEN'
      USING ERRCODE = 'P0003',
            HINT = 'Only a society Admin can do this.';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.assert_society_admin(uuid) IS
  '404 for a non-member, 403 for a member without the Admin role. Mirrors canManageSociety()/canDeleteSociety() in the domain.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Read
-- ─────────────────────────────────────────────────────────────────────────────

-- One society, whole: the row, its settings, the caller's membership and the
-- member count. One round trip, and the answer the port's `findById` promises —
-- `NULL` rather than an error when the caller has no live membership, which the
-- adapter turns into `not_found`.
--
-- The member count is why this is a function: RLS shows a *pending* member
-- exactly one `members` row (their own), so a count taken over visible rows would
-- read "1 member" for a society of 400. Counting here, after the membership gate,
-- is exact for everyone who is allowed to see the society at all.
CREATE OR REPLACE FUNCTION public.society_snapshot(p_society_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  result jsonb;
BEGIN
  IF NOT public.is_society_member(p_society_id, false) THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
           'society', to_jsonb(s),
           'settings', (
             SELECT to_jsonb(ss) FROM public.society_settings ss WHERE ss.society_id = s.id
           ),
           'membership', (
             SELECT to_jsonb(m)
               FROM public.members m
              WHERE m.society_id = s.id
                AND m.user_id = (SELECT auth.uid())
           ),
           'memberCount', (
             SELECT count(*)
               FROM public.members m
              WHERE m.society_id = s.id AND m.status = 'active'
           )
         )
    INTO result
    FROM public.societies s
   WHERE s.id = p_society_id
     AND s.deleted_at IS NULL;

  RETURN result;
END;
$$;

COMMENT ON FUNCTION public.society_snapshot(uuid) IS
  'Society + settings + caller membership + member count, or NULL when the caller has no live membership. The row shape the mobile adapter parses.';

-- Public preview of a join code (PRD §3.2). Deliberately narrow: name, city,
-- state, type, size and expiry — never the members, never the settings, and
-- never another society's join code (the code is an argument, not a column, so
-- this cannot be used to enumerate codes).
CREATE OR REPLACE FUNCTION public.society_join_preview(p_code text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
           'id', s.id,
           'name', s.name,
           'city', s.city,
           'state', s.state,
           'type', s.society_type,
           'memberCount', (
             SELECT count(*) FROM public.members m
              WHERE m.society_id = s.id AND m.status = 'active'
           ),
           'joinCodeExpiresAt', s.join_code_expires_at
         )
    FROM public.societies s
   WHERE s.deleted_at IS NULL
     AND s.join_code = upper(btrim(p_code))
   LIMIT 1;
$$;

COMMENT ON FUNCTION public.society_join_preview(text) IS
  'What the join screen shows before committing (PRD §3.2). Returns NULL for an unknown code; expiry is reported, not judged — the domain evaluates it against its injected clock.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Write
-- ─────────────────────────────────────────────────────────────────────────────

-- Create a society, its settings and the creator's Admin membership in one
-- transaction (PRD §3.2). SECURITY INVOKER on purpose: the INSERT is still
-- filtered by `societies_insert_creator`, so RLS — not this function — is what
-- stops a client creating a society owned by someone else.
CREATE OR REPLACE FUNCTION public.society_create(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  caller uuid := (SELECT auth.uid());
  new_id uuid;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;
  IF p_payload IS NULL OR p_payload = '{}'::jsonb THEN
    RAISE EXCEPTION 'EMPTY_PAYLOAD' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.societies (
    name, society_type, registration_no, address_line1, address_line2,
    city, state, pincode, created_by
  )
  VALUES (
    btrim(p_payload ->> 'name'),
    COALESCE(NULLIF(btrim(p_payload ->> 'type'), ''), 'apartment'),
    NULLIF(btrim(p_payload ->> 'registrationNumber'), ''),
    NULLIF(btrim(p_payload ->> 'addressLine1'), ''),
    NULLIF(btrim(p_payload ->> 'addressLine2'), ''),
    btrim(p_payload ->> 'city'),
    btrim(p_payload ->> 'state'),
    NULLIF(btrim(p_payload ->> 'pincode'), ''),
    caller
  )
  RETURNING id INTO new_id;
  -- `slug` and `join_code` are derived by `prepare_society()`; `society_settings`
  -- and the creator's Admin membership by `seed_society()`.

  -- The trigger seeded the column defaults; apply the wizard's financial choices
  -- (PRD §3.2 step 3) in the same transaction, so no society ever exists with
  -- settings the user did not choose.
  UPDATE public.society_settings ss
     SET billing_day = COALESCE((p_payload ->> 'billingDay')::smallint, ss.billing_day),
         due_day = COALESCE((p_payload ->> 'dueDay')::smallint, ss.due_day),
         approval_threshold_paise = COALESCE(
           (p_payload ->> 'approvalThresholdPaise')::bigint, ss.approval_threshold_paise
         )
   WHERE ss.society_id = new_id;

  RETURN public.society_snapshot(new_id);
END;
$$;

-- Patch a society and its settings atomically. The `p_patch ?` tests (jsonb key
-- existence) are what make "the client did not send this field" different from
-- "the client cleared it": an explicit `null` clears a nullable column
-- (`registration_no`, address lines, pincode), while a missing key leaves it as
-- it was. Without that distinction, a form that submits one field would wipe the
-- others.
CREATE OR REPLACE FUNCTION public.society_update(p_society_id uuid, p_patch jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_patch IS NULL OR p_patch = '{}'::jsonb THEN
    RAISE EXCEPTION 'EMPTY_PATCH' USING ERRCODE = 'P0001';
  END IF;

  PERFORM public.assert_society_membership(p_society_id);

  UPDATE public.societies s
     SET name = CASE
           WHEN NULLIF(btrim(p_patch ->> 'name'), '') IS NOT NULL
             THEN btrim(p_patch ->> 'name') ELSE s.name END,
         society_type = CASE
           WHEN NULLIF(btrim(p_patch ->> 'type'), '') IS NOT NULL
             THEN btrim(p_patch ->> 'type') ELSE s.society_type END,
         registration_no = CASE
           WHEN p_patch ? 'registrationNumber'
             THEN NULLIF(btrim(p_patch ->> 'registrationNumber'), '') ELSE s.registration_no END,
         address_line1 = CASE
           WHEN p_patch ? 'addressLine1'
             THEN NULLIF(btrim(p_patch ->> 'addressLine1'), '') ELSE s.address_line1 END,
         address_line2 = CASE
           WHEN p_patch ? 'addressLine2'
             THEN NULLIF(btrim(p_patch ->> 'addressLine2'), '') ELSE s.address_line2 END,
         city = CASE
           WHEN NULLIF(btrim(p_patch ->> 'city'), '') IS NOT NULL
             THEN btrim(p_patch ->> 'city') ELSE s.city END,
         state = CASE
           WHEN NULLIF(btrim(p_patch ->> 'state'), '') IS NOT NULL
             THEN btrim(p_patch ->> 'state') ELSE s.state END,
         pincode = CASE
           WHEN p_patch ? 'pincode'
             THEN NULLIF(btrim(p_patch ->> 'pincode'), '') ELSE s.pincode END
   WHERE s.id = p_society_id
     AND s.deleted_at IS NULL;
  -- `slug` is recomputed by `prepare_society()` when the name changes.

  IF NOT FOUND THEN
    -- The membership check above passed, so the caller knows this society
    -- exists. Zero rows here therefore means "not an Admin (or it was deleted)",
    -- and RLS is what enforced it — this branch only chooses the wording.
    RAISE EXCEPTION 'SOCIETY_FORBIDDEN' USING ERRCODE = 'P0003';
  END IF;

  IF p_patch ?| ARRAY['billingDay', 'dueDay', 'approvalThresholdPaise'] THEN
    UPDATE public.society_settings ss
       SET billing_day = COALESCE((p_patch ->> 'billingDay')::smallint, ss.billing_day),
           due_day = COALESCE((p_patch ->> 'dueDay')::smallint, ss.due_day),
           approval_threshold_paise = COALESCE(
             (p_patch ->> 'approvalThresholdPaise')::bigint, ss.approval_threshold_paise
           )
     WHERE ss.society_id = p_society_id;
  END IF;

  RETURN public.society_snapshot(p_society_id);
END;
$$;

-- Delete a society (PRD §3.2 "Delete Society"). Soft delete: the row stays so
-- financial history keeps its owner (PRD §3.1), while `deleted_at` takes it out
-- of every read path (`society_snapshot`, `society_join_preview`, the city index)
-- and the join code stops working.
--
-- SECURITY DEFINER because it must also mark every membership removed, which RLS
-- forbids a client from doing to other people's rows. The Admin check is
-- therefore explicit, and it runs before anything is written.
CREATE OR REPLACE FUNCTION public.society_soft_delete(p_society_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller_member_id uuid;
BEGIN
  PERFORM public.assert_society_admin(p_society_id);

  SELECT m.id INTO caller_member_id
    FROM public.members m
   WHERE m.society_id = p_society_id
     AND m.user_id = (SELECT auth.uid());

  UPDATE public.societies
     SET deleted_at = now()
   WHERE id = p_society_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOCIETY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- `chk_admin_present()` deliberately stands down for a deleted tenant: the
  -- invariant it protects ("a society always has an active admin") is about live
  -- societies, and a soft delete would otherwise be impossible for a sole Admin.
  UPDATE public.members
     SET status = 'removed',
         removed_at = now(),
         removed_by = caller_member_id
   WHERE society_id = p_society_id
     AND status <> 'removed';
END;
$$;

-- Rotate the join code (PRD §3.2: "Regenerable by Admin; optional expiry").
-- Minted here rather than by the client so the alphabet stays defined in one
-- place and uniqueness is not a race. Rotating invalidates the old code
-- immediately, which is what contains a leaked code in one admin action.
CREATE OR REPLACE FUNCTION public.society_rotate_join_code(p_society_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.assert_society_admin(p_society_id);

  UPDATE public.societies
     SET join_code = public.gen_join_code()
   WHERE id = p_society_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOCIETY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  RETURN public.society_snapshot(p_society_id);
END;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Privileges
-- ─────────────────────────────────────────────────────────────────────────────

-- Supabase grants EXECUTE on new functions to PUBLIC by default, so this is what
-- narrows the surface to the six intended entry points.
REVOKE ALL ON FUNCTION public.assert_society_membership(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_society_admin(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.society_snapshot(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.society_create(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.society_update(uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.society_soft_delete(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.society_rotate_join_code(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.society_join_preview(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_society_membership(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.assert_society_admin(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.society_snapshot(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.society_create(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.society_update(uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.society_soft_delete(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.society_rotate_join_code(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.society_join_preview(text) FROM anon;

GRANT EXECUTE ON FUNCTION public.society_snapshot(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.society_create(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.society_update(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.society_soft_delete(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.society_rotate_join_code(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.society_join_preview(text) TO authenticated;

-- `society_join_preview` is authenticated-only, although the PRD's API endpoint
-- (T040) is public. Deliberate: PostgREST cannot rate-limit, so an
-- anonymous-callable code oracle is a brute-force surface (32^6 codes is small
-- enough to matter when requests are free). The app can only reach the join
-- screen with a session (SAD §5.2 routing), so nothing is blocked today, and
-- opening it to `anon` is a one-line GRANT once the API — which can rate-limit —
-- owns the endpoint.
