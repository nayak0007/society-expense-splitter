-- 20260924120000_society_update_settings.sql
--
-- `society_settings` management was half-wired: the HTTP contract accepted nine
-- settings fields, the application layer carried all nine, the repository sent
-- all nine — and this function applied **two of them plus the billing days**.
-- The other six (`graceDays`, `billVacantFlats`, `allowPartialPayments`,
-- `defaulterListPublic`, `financialYearStartMonth`, `timezone`) were dropped
-- silently, and the request still answered `200` with the old value, which is the
-- worst possible shape for the bug: the user is told the change was saved.
--
-- Found by executing the module against a live database for the first time
-- (Roadmap T040's "any execution of this module against a live database" was the
-- outstanding item; the mocked-repository e2e suite cannot see SQL at all).
--
-- Forward-only, per the checksum ledger (`ses_meta.migrations`): the applied
-- `…130200_society_rpc.sql` stays byte-identical and this file replaces the
-- function. `CREATE OR REPLACE` keeps the existing ACL, so the `authenticated`
-- grant from the original migration is preserved.
--
-- Down (by hand, forward-only runner):
--   Re-apply the `society_update` body from `20260920130200_society_rpc.sql`.
--   Safe to roll back on its own: it only narrows which columns a patch may
--   change, and no other object depends on the wider set.

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
             THEN NULLIF(btrim(p_patch ->> 'pincode'), '') ELSE s.pincode END,
         -- Timezone lives on the society, not on `society_settings` (the domain
         -- merges the two — see `settingsFromRow`), so it is patched here.
         timezone = CASE
           WHEN NULLIF(btrim(p_patch ->> 'timezone'), '') IS NOT NULL
             THEN btrim(p_patch ->> 'timezone') ELSE s.timezone END
   WHERE s.id = p_society_id
     AND s.deleted_at IS NULL;
  -- `slug` is recomputed by `prepare_society()` when the name changes.

  IF NOT FOUND THEN
    -- The membership check above passed, so the caller knows this society
    -- exists. Zero rows here therefore means "not an Admin (or it was deleted)",
    -- and RLS is what enforced it — this branch only chooses the wording.
    RAISE EXCEPTION 'SOCIETY_FORBIDDEN' USING ERRCODE = 'P0003';
  END IF;

  -- Every key listed here is one the wire contract accepts; a key that appears
  -- in neither this guard nor the UPDATE above is a field the UI offers and the
  -- database discards. `scripts/db/rls-canary.sql` asserts each of them lands.
  IF p_patch ?| ARRAY[
       'billingDay', 'dueDay', 'graceDays', 'approvalThresholdPaise',
       'billVacantFlats', 'allowPartialPayments', 'defaulterListPublic',
       'financialYearStartMonth'
     ] THEN
    UPDATE public.society_settings ss
       SET billing_day = COALESCE((p_patch ->> 'billingDay')::smallint, ss.billing_day),
           due_day = COALESCE((p_patch ->> 'dueDay')::smallint, ss.due_day),
           grace_days = COALESCE((p_patch ->> 'graceDays')::smallint, ss.grace_days),
           approval_threshold_paise = COALESCE(
             (p_patch ->> 'approvalThresholdPaise')::bigint, ss.approval_threshold_paise
           ),
           bill_vacant_flats = COALESCE(
             (p_patch ->> 'billVacantFlats')::boolean, ss.bill_vacant_flats
           ),
           allow_partial_payments = COALESCE(
             (p_patch ->> 'allowPartialPayments')::boolean, ss.allow_partial_payments
           ),
           defaulter_list_public = COALESCE(
             (p_patch ->> 'defaulterListPublic')::boolean, ss.defaulter_list_public
           ),
           financial_year_start_month = COALESCE(
             (p_patch ->> 'financialYearStartMonth')::smallint,
             ss.financial_year_start_month
           )
     WHERE ss.society_id = p_society_id;
  END IF;

  RETURN public.society_snapshot(p_society_id);
END;
$$;

COMMENT ON FUNCTION public.society_update(uuid, jsonb) IS
  'Admin-only society and settings patch. Accepts exactly the fields the wire contract exposes; every settings key the contract accepts is applied here.';
