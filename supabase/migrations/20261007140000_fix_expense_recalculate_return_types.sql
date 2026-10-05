-- 20261007140000_fix_expense_recalculate_return_types.sql — T068 · repair, migration #29
--
-- WHAT IS WRONG
--
-- `expense_recalculate()` (migration #28) declares its result row with
-- `payment_source varchar(24)` — the same declaration `expense_publish()` uses,
-- because the two return the same row — but its `RETURN QUERY` selects
-- `e.payment_source::text`. Postgres refuses the mismatch at *runtime*, not at
-- `CREATE FUNCTION` time:
--
--   ERROR:  42804: structure of query does not match function result type
--   DETAIL: Returned type text does not match expected type character varying
--           in column "payment_source" (position 9).
--
-- Every call therefore failed — a plain amount revision, a title edit, a
-- participant change — while #28's constraints, index and enum value were
-- unaffected. T068's real-Postgres integration suite is what found it; a
-- fake-backed e2e suite cannot see a server-side type mismatch.
--
-- WHY A NEW FILE AND NOT AN EDIT OF #28
--
-- #28 is applied (the project's dev project records its sha256 in
-- `ses_meta.migrations`, and the runner treats a file whose recorded checksum no
-- longer matches as fatal), so the repair is forward-only: this migration
-- replaces the function with a body identical to #28's except for the one cast.
-- Nothing else #28 introduced — the `superseded` enum value, `fk_dues_split`,
-- `chk_due_billable()`, `chk_due_current_split_present`,
-- `uq_dues_current_participant` — is touched.
--
-- Rehearsed by the integration suite, which applies the chain from scratch on a
-- real Postgres container and then runs every lifecycle proof against the
-- replaced function.
--
-- Down (run by hand — the runner is forward-only, same convention as the other
-- twenty-eight files). Valid only after #28; it restores that file's body, which
-- differs from this one at exactly one line: the `RETURN QUERY` selects
-- `e.payment_source::text AS payment_source` there and `e.payment_source` here.
--   Re-run this file's `CREATE OR REPLACE FUNCTION` with that one line restored,
--   or re-apply #28's body verbatim. No other object was created or changed.

CREATE OR REPLACE FUNCTION public.expense_recalculate(
  p_expense_id uuid,
  p_society_id uuid,
  p_expected_version integer,
  p_fields jsonb,
  p_splits jsonb,
  p_change_note text
)
RETURNS TABLE (
  id uuid,
  society_id uuid,
  category_id uuid,
  title varchar(120),
  description text,
  amount_paise text,
  expense_date text,
  vendor_name varchar(120),
  payment_source varchar(24),
  paid_by_member_id uuid,
  split_strategy text,
  apartment_basis text,
  split_config jsonb,
  participant_selector jsonb,
  status text,
  created_by uuid,
  published_at timestamptz,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  version integer,
  created_at timestamptz,
  updated_at timestamptz,
  recalculation jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_status text;
  v_version integer;
  v_amount bigint;
  v_new_amount bigint;
  v_actor_member uuid;
  v_snapshot jsonb;
  v_split_total bigint;
  v_old_current bigint;
  v_retained integer;
  v_superseded integer;
  v_created integer;
  v_updated integer;
  v_deltas jsonb;
  v_affected uuid[];
  v_bad_id uuid;
  v_bad_paid bigint;
  v_bad_new bigint;
  v_expense_due_date date;
  v_due_day smallint;
  v_timezone text;
  v_today date;
  v_due_date date;
  v_summary jsonb;
BEGIN
  PERFORM public.assert_society_membership(p_society_id);

  IF NOT public.can_publish_expenses(p_society_id) THEN
    RAISE EXCEPTION 'EXPENSE_RECALC_FORBIDDEN'
      USING ERRCODE = '42501',
            HINT = 'Only a society Admin or Treasurer can revise a published expense.';
  END IF;

  SELECT e.status::text, e.version, e.amount_paise
    INTO v_status, v_version, v_amount
    FROM public.expenses e
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_status <> 'published' THEN
    RAISE EXCEPTION 'EXPENSE_NOT_RECALCULABLE'
      USING ERRCODE = 'P0001',
            DETAIL = v_status,
            HINT = 'Only a published expense can be recalculated; drafts are edited and void expenses are final.';
  END IF;

  IF v_version <> p_expected_version THEN
    RAISE EXCEPTION 'EXPENSE_VERSION_MISMATCH'
      USING ERRCODE = 'P0001',
            DETAIL = v_version::text,
            HINT = 'This expense was changed by someone else. Reload it and try again.';
  END IF;

  -- The actor's membership of this society, recorded as the revision's
  -- `changed_by` (ADR-0009 §17). `can_publish_expenses` already proved an
  -- active manager identity exists; this reads its row.
  SELECT m.id
    INTO v_actor_member
    FROM public.members m
   WHERE m.society_id = p_society_id
     AND m.user_id = (SELECT auth.uid())
     AND m.status = 'active'
   LIMIT 1;

  IF v_actor_member IS NULL THEN
    RAISE EXCEPTION 'EXPENSE_RECALC_FORBIDDEN'
      USING ERRCODE = '42501',
            HINT = 'Only a society Admin or Treasurer can revise a published expense.';
  END IF;

  -- ── The edit payload: published-editable fields only ──────────────────────

  IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
    RAISE EXCEPTION 'EXPENSE_RECALC_FIELD_NOT_EDITABLE: the edit payload is not an object'
      USING ERRCODE = 'P0001',
            HINT = 'Send an object carrying only the fields a published expense may change.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_each(p_fields) AS field(key, value)
     WHERE field.key NOT IN (
       'title', 'description', 'vendorName', 'amountPaise',
       'splitStrategy', 'apartmentBasis', 'splitConfig', 'participantSelector'
     )
  ) THEN
    RAISE EXCEPTION 'EXPENSE_RECALC_FIELD_NOT_EDITABLE: the edit payload carries a field a published expense may not change'
      USING ERRCODE = 'P0001',
            HINT = 'A published expense may change title, description, vendorName, amountPaise, splitStrategy, apartmentBasis, splitConfig and participantSelector only.';
  END IF;

  IF p_fields ? 'title' THEN
    IF jsonb_typeof(p_fields -> 'title') <> 'string'
       OR btrim(p_fields ->> 'title') = ''
       OR length(p_fields ->> 'title') > 120 THEN
      RAISE EXCEPTION 'EXPENSE_RECALC_INVALID_FIELD: title must be 1–120 characters'
        USING ERRCODE = 'P0001',
              DETAIL = 'title';
    END IF;
  END IF;

  IF p_fields ? 'vendorName' AND jsonb_typeof(p_fields -> 'vendorName') = 'string' THEN
    IF length(p_fields ->> 'vendorName') > 120 THEN
      RAISE EXCEPTION 'EXPENSE_RECALC_INVALID_FIELD: vendorName must be at most 120 characters'
        USING ERRCODE = 'P0001',
              DETAIL = 'vendorName';
    END IF;
  END IF;

  IF p_fields ? 'splitStrategy' THEN
    IF (p_fields ->> 'splitStrategy') NOT IN
       ('equal', 'percentage', 'shares', 'apartment', 'custom') THEN
      RAISE EXCEPTION 'EXPENSE_RECALC_INVALID_FIELD: splitStrategy is not a known strategy'
        USING ERRCODE = 'P0001',
              DETAIL = 'splitStrategy';
    END IF;
  END IF;

  IF p_fields ? 'apartmentBasis'
     AND jsonb_typeof(p_fields -> 'apartmentBasis') = 'string'
     AND (p_fields ->> 'apartmentBasis') NOT IN
         ('per_flat', 'per_sqft_carpet', 'per_sqft_builtup', 'per_bhk', 'per_floor_band', 'per_parking_slot') THEN
    RAISE EXCEPTION 'EXPENSE_RECALC_INVALID_FIELD: apartmentBasis is not a known basis'
      USING ERRCODE = 'P0001',
            DETAIL = 'apartmentBasis';
  END IF;

  IF p_fields ? 'amountPaise' THEN
    IF jsonb_typeof(p_fields -> 'amountPaise') <> 'number'
       OR (p_fields ->> 'amountPaise') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'EXPENSE_RECALC_INVALID_FIELD: amountPaise must be a positive integer'
        USING ERRCODE = 'P0001',
              DETAIL = 'amountPaise';
    END IF;
    v_new_amount := (p_fields ->> 'amountPaise')::bigint;
  ELSE
    v_new_amount := v_amount;
  END IF;

  IF v_new_amount <= 0 THEN
    RAISE EXCEPTION 'EXPENSE_RECALC_INVALID_FIELD: the amount must be greater than zero'
      USING ERRCODE = 'P0001',
            DETAIL = 'amountPaise';
  END IF;

  -- ── The allocation plan ───────────────────────────────────────────────────

  IF p_splits IS NULL OR jsonb_typeof(p_splits) <> 'array' THEN
    RAISE EXCEPTION 'SPLIT_MISMATCH: the allocations are not a list'
      USING ERRCODE = 'P0001',
            HINT = 'A recalculation must carry the allocation list the split engine produced.';
  END IF;

  IF jsonb_array_length(p_splits) = 0 THEN
    RAISE EXCEPTION 'SPLIT_MISMATCH: expense % has no allocations', p_expense_id
      USING ERRCODE = 'P0001',
            HINT = 'A published expense must have splits summing exactly to its amount.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_splits) AS entry
     WHERE entry ->> 'member_id' IS NULL
        OR entry ->> 'amount_paise' IS NULL
        OR (entry ->> 'amount_paise') !~ '^[0-9]+$'
  ) THEN
    RAISE EXCEPTION 'SPLIT_MISMATCH: every allocation needs a member and a non-negative integer amount'
      USING ERRCODE = 'P0001',
            HINT = 'A due cannot address nobody, and an amount is integer paise.';
  END IF;

  SELECT COALESCE(sum((entry ->> 'amount_paise')::bigint), 0)
    INTO v_split_total
    FROM jsonb_array_elements(p_splits) AS entry;

  IF v_split_total <> v_new_amount THEN
    RAISE EXCEPTION 'SPLIT_MISMATCH: expense % splits total % expected %',
      p_expense_id, v_split_total, v_new_amount
      USING ERRCODE = 'P0001',
            HINT = 'A published expense must have splits summing exactly to its amount.';
  END IF;

  -- ── The paid-obligation block, before any write (ADR-0009 §13) ────────────

  -- A removed participant whose due has a verified payment, or a retained due
  -- whose new obligation is below what was already paid, cannot be superseded
  -- or reduced by T068: the revision is refused atomically and the caller is
  -- told to issue a credit adjustment instead. The `chk_dues_paid_within_amount`
  -- CHECK is the database backstop for the retained case.
  SELECT d.id, d.paid_paise
    INTO v_bad_id, v_bad_paid
    FROM public.dues d
   WHERE d.expense_id = p_expense_id
     AND d.society_id = p_society_id
     AND d.kind = 'principal'
     AND d.status <> 'superseded'
     AND d.paid_paise > 0
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_splits) AS entry
        WHERE (entry ->> 'member_id')::uuid = d.member_id
          AND NULLIF(entry ->> 'apartment_id', '')::uuid IS NOT DISTINCT FROM d.apartment_id
     )
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'DUE_PAID_EXCEEDS_NEW_AMOUNT: due % carries a verified payment of % and would be removed', v_bad_id, v_bad_paid
      USING ERRCODE = 'P0001',
            DETAIL = v_bad_id::text,
            HINT = 'The recalculated obligation would be below a verified payment. Issue a credit adjustment instead.';
  END IF;

  SELECT d.id, d.paid_paise, (entry ->> 'amount_paise')::bigint
    INTO v_bad_id, v_bad_paid, v_bad_new
    FROM public.dues d
    JOIN jsonb_array_elements(p_splits) AS entry
      ON (entry ->> 'member_id')::uuid = d.member_id
     AND NULLIF(entry ->> 'apartment_id', '')::uuid IS NOT DISTINCT FROM d.apartment_id
   WHERE d.expense_id = p_expense_id
     AND d.society_id = p_society_id
     AND d.kind = 'principal'
     AND d.status <> 'superseded'
     AND d.paid_paise > (entry ->> 'amount_paise')::bigint
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'DUE_PAID_EXCEEDS_NEW_AMOUNT: due % carries a verified payment of % but the recalculated obligation is %', v_bad_id, v_bad_paid, v_bad_new
      USING ERRCODE = 'P0001',
            DETAIL = v_bad_id::text,
            HINT = 'The recalculated obligation would be below a verified payment. Issue a credit adjustment instead.';
  END IF;

  -- ── Classification counts (pre-write) ─────────────────────────────────────

  SELECT count(*)
    INTO v_retained
    FROM public.dues d
   WHERE d.expense_id = p_expense_id
     AND d.society_id = p_society_id
     AND d.kind = 'principal'
     AND d.status <> 'superseded'
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_splits) AS entry
        WHERE (entry ->> 'member_id')::uuid = d.member_id
          AND NULLIF(entry ->> 'apartment_id', '')::uuid IS NOT DISTINCT FROM d.apartment_id
     );

  SELECT count(*)
    INTO v_updated
    FROM public.dues d
   WHERE d.expense_id = p_expense_id
     AND d.society_id = p_society_id
     AND d.kind = 'principal'
     AND d.status <> 'superseded'
     AND EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_splits) AS entry
        WHERE (entry ->> 'member_id')::uuid = d.member_id
          AND NULLIF(entry ->> 'apartment_id', '')::uuid IS NOT DISTINCT FROM d.apartment_id
          AND (entry ->> 'amount_paise')::bigint <> d.amount_paise
     );

  SELECT count(*)
    INTO v_superseded
    FROM public.dues d
   WHERE d.expense_id = p_expense_id
     AND d.society_id = p_society_id
     AND d.kind = 'principal'
     AND d.status <> 'superseded'
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_splits) AS entry
        WHERE (entry ->> 'member_id')::uuid = d.member_id
          AND NULLIF(entry ->> 'apartment_id', '')::uuid IS NOT DISTINCT FROM d.apartment_id
     );

  SELECT count(*)
    INTO v_created
    FROM jsonb_array_elements(p_splits) AS entry
   WHERE NOT EXISTS (
     SELECT 1
       FROM public.dues d
      WHERE d.expense_id = p_expense_id
        AND d.society_id = p_society_id
        AND d.kind = 'principal'
        AND d.status <> 'superseded'
        AND d.member_id = (entry ->> 'member_id')::uuid
        AND d.apartment_id IS NOT DISTINCT FROM NULLIF(entry ->> 'apartment_id', '')::uuid
   );

  SELECT COALESCE(sum(d.amount_paise), 0)
    INTO v_old_current
    FROM public.dues d
   WHERE d.expense_id = p_expense_id
     AND d.society_id = p_society_id
     AND d.kind = 'principal'
     AND d.status <> 'superseded';

  -- ── The BEFORE snapshot (ADR-0009 §17): the state being replaced ──────────

  SELECT jsonb_build_object(
           'expense', jsonb_build_object(
             'id', e.id,
             'society_id', e.society_id,
             'category_id', e.category_id,
             'title', e.title,
             'description', e.description,
             'amount_paise', e.amount_paise::text,
             'expense_date', e.expense_date::text,
             'vendor_name', e.vendor_name,
             'payment_source', e.payment_source::text,
             'paid_by_member_id', e.paid_by_member_id,
             'split_strategy', e.split_strategy::text,
             'apartment_basis', e.apartment_basis::text,
             'split_config', e.split_config,
             'participant_selector', e.participant_selector,
             'status', e.status::text,
             'due_date', e.due_date::text,
             'version', e.version,
             'created_by', e.created_by,
             'published_at', e.published_at,
             'created_at', e.created_at,
             'updated_at', e.updated_at
           ),
           'splits', COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'id', s.id,
                      'member_id', s.member_id,
                      'apartment_id', s.apartment_id,
                      'amount_paise', s.amount_paise::text,
                      'weight', s.weight,
                      'percent', s.percent,
                      'assigned_reason', s.assigned_reason,
                      'snapshot', s.snapshot
                    ) ORDER BY s.created_at, s.id)
               FROM public.expense_splits s
              WHERE s.expense_id = p_expense_id
                AND s.society_id = p_society_id
           ), '[]'::jsonb)
         )
    INTO v_snapshot
    FROM public.expenses e
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id;

  -- ── The balance deltas, captured from the PRE-write state ─────────────────

  -- `total_due_paise` is the gross sum of current obligations; the outstanding
  -- contribution of a line is `amount − paid` while it is open and 0 once it is
  -- settled or forgiven. The deltas mirror the lifecycle moves this same
  -- transaction is about to make, which is why they are captured before it.
  WITH plan AS (
    SELECT
      (entry ->> 'member_id')::uuid AS member_id,
      NULLIF(entry ->> 'apartment_id', '')::uuid AS apartment_id,
      (entry ->> 'amount_paise')::bigint AS amount_paise
    FROM jsonb_array_elements(p_splits) AS entry
  ),
  current_dues AS (
    SELECT
      d.member_id,
      d.apartment_id,
      d.amount_paise,
      d.paid_paise,
      d.status::text AS status
    FROM public.dues d
    WHERE d.expense_id = p_expense_id
      AND d.society_id = p_society_id
      AND d.kind = 'principal'
      AND d.status <> 'superseded'
  ),
  deltas AS (
    SELECT
      c.member_id,
      (p.amount_paise - c.amount_paise)::bigint AS due_delta,
      (
        (CASE WHEN p.amount_paise > c.paid_paise THEN p.amount_paise - c.paid_paise ELSE 0 END)
        - (CASE WHEN c.status IN ('pending', 'partial', 'overdue') THEN c.amount_paise - c.paid_paise ELSE 0 END)
      )::bigint AS outstanding_delta
    FROM current_dues c
    JOIN plan p
      ON p.member_id = c.member_id
     AND p.apartment_id IS NOT DISTINCT FROM c.apartment_id
    UNION ALL
    SELECT
      c.member_id,
      (-c.amount_paise)::bigint,
      (-(CASE WHEN c.status IN ('pending', 'partial', 'overdue') THEN c.amount_paise - c.paid_paise ELSE 0 END))::bigint
    FROM current_dues c
    WHERE NOT EXISTS (
      SELECT 1 FROM plan p
       WHERE p.member_id = c.member_id
         AND p.apartment_id IS NOT DISTINCT FROM c.apartment_id
    )
    UNION ALL
    SELECT
      p.member_id,
      p.amount_paise,
      p.amount_paise
    FROM plan p
    WHERE NOT EXISTS (
      SELECT 1 FROM current_dues c
       WHERE c.member_id = p.member_id
         AND c.apartment_id IS NOT DISTINCT FROM p.apartment_id
    )
  ),
  agg AS (
    SELECT
      member_id,
      sum(due_delta)::bigint AS due_delta,
      sum(outstanding_delta)::bigint AS outstanding_delta
    FROM deltas
    GROUP BY member_id
  )
  SELECT
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'member_id', a.member_id,
               'due_delta', a.due_delta::text,
               'outstanding_delta', a.outstanding_delta::text
             ))
        FROM agg a
       WHERE NOT (a.due_delta = 0 AND a.outstanding_delta = 0)
    ), '[]'::jsonb),
    COALESCE((SELECT array_agg(a.member_id) FROM agg a), ARRAY[]::uuid[])
  INTO v_deltas, v_affected;

  -- ── The due date for dues this call creates (publish's own rule) ──────────

  IF v_created > 0 THEN
    SELECT e.due_date
      INTO v_expense_due_date
      FROM public.expenses e
     WHERE e.id = p_expense_id
       AND e.society_id = p_society_id;

    IF v_expense_due_date IS NOT NULL THEN
      v_due_date := v_expense_due_date;
    ELSE
      SELECT ss.due_day
        INTO v_due_day
        FROM public.society_settings ss
       WHERE ss.society_id = p_society_id;

      SELECT soc.timezone
        INTO v_timezone
        FROM public.societies soc
       WHERE soc.id = p_society_id;

      v_due_day := COALESCE(v_due_day, 10);

      BEGIN
        v_today := (now() AT TIME ZONE COALESCE(v_timezone, 'Asia/Kolkata'))::date;
      EXCEPTION WHEN invalid_parameter_value THEN
        v_today := now()::date;
      END;

      v_due_date := CASE
        WHEN EXTRACT(DAY FROM v_today)::int <= v_due_day
          THEN (date_trunc('month', v_today)::date + (v_due_day - 1))
        ELSE ((date_trunc('month', v_today) + interval '1 month')::date + (v_due_day - 1))
      END;
    END IF;
  END IF;

  -- ── Retained splits: updated in place, so split identity (and the due's
  --    split link) survives the recalculation ──────────────────────────────

  UPDATE public.expense_splits s
     SET amount_paise = (entry ->> 'amount_paise')::bigint,
         weight = CASE
           WHEN entry ->> 'weight' IS NULL THEN NULL
           ELSE (entry ->> 'weight')::numeric(12, 4)
         END,
         percent = CASE
           WHEN entry ->> 'percent' IS NULL THEN NULL
           ELSE (entry ->> 'percent')::numeric(7, 4)
         END,
         assigned_reason = NULLIF(entry ->> 'assigned_reason', ''),
         snapshot = COALESCE(entry -> 'snapshot', '{}'::jsonb)
    FROM jsonb_array_elements(p_splits) AS entry
   WHERE s.expense_id = p_expense_id
     AND s.society_id = p_society_id
     AND s.member_id = (entry ->> 'member_id')::uuid
     AND s.apartment_id IS NOT DISTINCT FROM NULLIF(entry ->> 'apartment_id', '')::uuid;

  -- ── Retained dues: amount to the new authoritative split amount, and the
  --    payment-derived status recomputed (paid → partial → paid) ────────────

  UPDATE public.dues d
     SET amount_paise = (entry ->> 'amount_paise')::bigint,
         status = CASE
           WHEN d.status IN ('pending', 'partial', 'paid', 'overdue') THEN
             CASE
               WHEN d.paid_paise = 0 THEN
                 CASE
                   WHEN d.status = 'overdue' THEN 'overdue'::public.due_status
                   ELSE 'pending'::public.due_status
                 END
               WHEN d.paid_paise < (entry ->> 'amount_paise')::bigint THEN 'partial'::public.due_status
               ELSE 'paid'::public.due_status
             END
           ELSE d.status
         END
    FROM jsonb_array_elements(p_splits) AS entry
   WHERE d.expense_id = p_expense_id
     AND d.society_id = p_society_id
     AND d.kind = 'principal'
     AND d.status <> 'superseded'
     AND d.member_id = (entry ->> 'member_id')::uuid
     AND d.apartment_id IS NOT DISTINCT FROM NULLIF(entry ->> 'apartment_id', '')::uuid;

  -- ── Removed dues: superseded, never deleted — and BEFORE their split is
  --    deleted, because chk_due_current_split_present refuses the reverse ───

  UPDATE public.dues d
     SET status = 'superseded'::public.due_status
   WHERE d.expense_id = p_expense_id
     AND d.society_id = p_society_id
     AND d.kind = 'principal'
     AND d.status <> 'superseded'
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_splits) AS entry
        WHERE (entry ->> 'member_id')::uuid = d.member_id
          AND NULLIF(entry ->> 'apartment_id', '')::uuid IS NOT DISTINCT FROM d.apartment_id
     );

  -- The obsolete current split goes; the FK nulls the superseded due's
  -- `split_id`, which is the historical state ADR-0009 defines.
  DELETE FROM public.expense_splits s
   WHERE s.expense_id = p_expense_id
     AND s.society_id = p_society_id
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(p_splits) AS entry
        WHERE (entry ->> 'member_id')::uuid = s.member_id
          AND NULLIF(entry ->> 'apartment_id', '')::uuid IS NOT DISTINCT FROM s.apartment_id
     );

  -- ── Added splits and their dues ───────────────────────────────────────────

  INSERT INTO public.expense_splits (
    society_id,
    expense_id,
    member_id,
    apartment_id,
    amount_paise,
    weight,
    percent,
    assigned_reason,
    snapshot
  )
  SELECT
    p_society_id,
    p_expense_id,
    (entry ->> 'member_id')::uuid,
    NULLIF(entry ->> 'apartment_id', '')::uuid,
    (entry ->> 'amount_paise')::bigint,
    CASE
      WHEN entry ->> 'weight' IS NULL THEN NULL
      ELSE (entry ->> 'weight')::numeric(12, 4)
    END,
    CASE
      WHEN entry ->> 'percent' IS NULL THEN NULL
      ELSE (entry ->> 'percent')::numeric(7, 4)
    END,
    NULLIF(entry ->> 'assigned_reason', ''),
    COALESCE(entry -> 'snapshot', '{}'::jsonb)
  FROM jsonb_array_elements(p_splits) AS entry
  WHERE NOT EXISTS (
    SELECT 1
      FROM public.expense_splits s
     WHERE s.expense_id = p_expense_id
       AND s.society_id = p_society_id
       AND s.member_id = (entry ->> 'member_id')::uuid
       AND s.apartment_id IS NOT DISTINCT FROM NULLIF(entry ->> 'apartment_id', '')::uuid
  );

  INSERT INTO public.dues (
    society_id,
    member_id,
    apartment_id,
    expense_id,
    split_id,
    kind,
    amount_paise,
    paid_paise,
    status,
    due_date
  )
  SELECT
    p_society_id,
    s.member_id,
    s.apartment_id,
    p_expense_id,
    s.id,
    'principal',
    s.amount_paise,
    0,
    'pending',
    v_due_date
  FROM public.expense_splits s
  WHERE s.expense_id = p_expense_id
    AND s.society_id = p_society_id
    AND NOT EXISTS (
      SELECT 1
        FROM public.dues d
       WHERE d.expense_id = p_expense_id
         AND d.society_id = p_society_id
         AND d.kind = 'principal'
         AND d.status <> 'superseded'
         AND d.member_id = s.member_id
         AND d.apartment_id IS NOT DISTINCT FROM s.apartment_id
    );

  -- ── Balance deltas, applied set-based (the T067 upsert shape) ─────────────

  INSERT INTO public.member_balances AS mb (
    member_id,
    society_id,
    total_due_paise,
    total_paid_paise,
    advance_paise,
    outstanding_paise,
    oldest_due_date,
    updated_at
  )
  SELECT
    (entry ->> 'member_id')::uuid,
    p_society_id,
    (entry ->> 'due_delta')::bigint,
    0,
    0,
    (entry ->> 'outstanding_delta')::bigint,
    NULL,
    now()
  FROM jsonb_array_elements(v_deltas) AS entry
  ON CONFLICT ON CONSTRAINT member_balances_pkey DO UPDATE
     SET total_due_paise = mb.total_due_paise + EXCLUDED.total_due_paise,
         outstanding_paise = mb.outstanding_paise + EXCLUDED.outstanding_paise,
         updated_at = now();

  -- ── oldest_due_date: recomputed from the authoritative open dues, never the
  --    publish-time LEAST shortcut ───────────────────────────────────────────

  UPDATE public.member_balances mb
     SET oldest_due_date = sub.min_due,
         updated_at = now()
    FROM (
      SELECT
        a.member_id AS member_id,
        (
          SELECT min(d.due_date)
            FROM public.dues d
           WHERE d.member_id = a.member_id
             AND d.status IN ('pending', 'partial', 'overdue')
        ) AS min_due
      FROM unnest(v_affected) AS a(member_id)
    ) AS sub
   WHERE mb.member_id = sub.member_id;

  -- ── The expense's editable fields; the touch trigger bumps `version` ──────

  UPDATE public.expenses e
     SET title = CASE WHEN p_fields ? 'title' THEN p_fields ->> 'title' ELSE e.title END,
         description = CASE WHEN p_fields ? 'description' THEN p_fields ->> 'description' ELSE e.description END,
         vendor_name = CASE WHEN p_fields ? 'vendorName' THEN p_fields ->> 'vendorName' ELSE e.vendor_name END,
         amount_paise = v_new_amount,
         split_strategy = CASE
           WHEN p_fields ? 'splitStrategy' THEN (p_fields ->> 'splitStrategy')::public.split_strategy
           ELSE e.split_strategy
         END,
         apartment_basis = CASE
           WHEN p_fields ? 'apartmentBasis' THEN NULLIF(p_fields ->> 'apartmentBasis', '')::public.apartment_basis
           ELSE e.apartment_basis
         END,
         split_config = CASE
           WHEN p_fields ? 'splitConfig' THEN
             CASE WHEN jsonb_typeof(p_fields -> 'splitConfig') = 'object' THEN p_fields -> 'splitConfig' ELSE '{}'::jsonb END
           ELSE e.split_config
         END,
         participant_selector = CASE
           WHEN p_fields ? 'participantSelector' THEN
             CASE WHEN jsonb_typeof(p_fields -> 'participantSelector') = 'object' THEN p_fields -> 'participantSelector' ELSE '{}'::jsonb END
           ELSE e.participant_selector
         END
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id;

  -- ── Exactly one revision, BEFORE state, PRE-edit version (ADR-0009 §17) ───

  INSERT INTO public.expense_revisions (
    society_id,
    expense_id,
    version,
    snapshot,
    changed_by,
    change_note
  )
  VALUES (
    p_society_id,
    p_expense_id,
    v_version,
    v_snapshot,
    v_actor_member,
    NULLIF(btrim(p_change_note), '')
  );

  -- ── The summary, measured from the rows this call committed ───────────────

  v_summary := jsonb_build_object(
    'duesUpdated', v_updated,
    'duesSuperseded', v_superseded,
    'duesCreated', v_created,
    'totalDeltaPaise', (v_split_total - v_old_current)::text,
    'affectedMembers', COALESCE(array_length(v_affected, 1), 0),
    'blockedByPaidSplits', 0
  );

  RETURN QUERY
    SELECT
      e.id,
      e.society_id,
      e.category_id,
      e.title,
      e.description,
      e.amount_paise::text AS amount_paise,
      e.expense_date::text AS expense_date,
      e.vendor_name,
      e.payment_source,
      e.paid_by_member_id,
      e.split_strategy::text AS split_strategy,
      e.apartment_basis::text AS apartment_basis,
      e.split_config,
      e.participant_selector,
      e.status::text AS status,
      e.created_by,
      e.published_at,
      e.voided_at,
      e.voided_by,
      e.void_reason,
      e.version,
      e.created_at,
      e.updated_at,
      v_summary
    FROM public.expenses e
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id;
END;
$$;

COMMENT ON FUNCTION public.expense_recalculate(uuid, uuid, integer, jsonb, jsonb, text) IS
  'Revises one published expense atomically (T068, ADR-0009): captures the BEFORE revision snapshot, classifies every current principal due against the new allocation plan, refuses when any new obligation is below its verified paid amount (DUE_PAID_EXCEEDS_NEW_AMOUNT), updates retained dues/splits in place, supersedes removed ones (amount preserved, split unlinked), creates added ones, applies exact member_balances deltas, recomputes oldest_due_date, updates only the published-editable expense fields, and writes exactly one expense_revisions row. SECURITY DEFINER; membership + expense.publish enforced; the expense row is locked before the version check.';

-- Grants restated rather than assumed, exactly as `expense_publish()` does.
REVOKE ALL ON FUNCTION public.expense_recalculate(uuid, uuid, integer, jsonb, jsonb, text)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expense_recalculate(uuid, uuid, integer, jsonb, jsonb, text)
  FROM anon;
GRANT EXECUTE ON FUNCTION public.expense_recalculate(uuid, uuid, integer, jsonb, jsonb, text)
  TO authenticated;
