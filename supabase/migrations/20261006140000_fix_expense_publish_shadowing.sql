-- ─────────────────────────────────────────────────────────────────────────────
-- 20261006140000_fix_expense_publish_shadowing.sql — T067 follow-up
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT THIS FILE FIXES. `20261006130000_fix_expense_publish_timezone.sql` moved
-- the timezone read to its owner table but left two name-resolution defects in
-- the T067 function body, both of the class
-- `20260926140000_fix_join_options_ambiguity.sql` exists to remember: inside a
-- `RETURNS TABLE` function, the output parameter names shadow column names, and
-- `plpgsql.variable_conflict = error` (the default) refuses the ambiguous
-- reference instead of guessing.
--
--   1. the dues insert's `RETURNING member_id, society_id, …` — both are output
--      parameter names, so the reference was refused as ambiguous (SQLSTATE
--      42702, `column reference "society_id" is ambiguous`);
--   2. the balance upsert's `ON CONFLICT (member_id)` — inference by name, where
--      `member_id` is also an output parameter.
--
-- Both were found by the T067 integration suite against a live PostgreSQL, which
-- is the only place a plpgsql body is compiled and executed; no mocked suite can
-- see them. The fixes are explicit: the `RETURNING` is table-qualified
-- (`dues.…`), the conflict target names the primary key constraint instead of an
-- index-expression list, and the function body opens with the documented
-- `#variable_conflict use_column` directive — every variable in this body is
-- `v_`-prefixed, so preferring the column is exactly the intended reading and
-- future-proofs the remaining statements.
--
-- Nothing else changes: the signature, the returned shape, the check order, the
-- due-date rule, the dues insert and the balance arithmetic are the T067 body.
--
-- Down (run by hand — the runner is forward-only, same convention as the other
-- twenty-three files):
--   -- and restore the previous body of public.expense_publish(uuid, uuid,
--   -- integer, jsonb) from 20261006130000_fix_expense_publish_timezone.sql (it
--   -- is replaced, not merely extended, below).

-- ─────────────────────────────────────────────────────────────────────────────
-- expense_publish, v4 — the same transaction, ambiguity-free by construction
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.expense_publish(
  p_expense_id uuid,
  p_society_id uuid,
  p_expected_version integer,
  p_splits jsonb
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
  split_summary jsonb
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
  v_expense_due_date date;
  v_due_day smallint;
  v_timezone text;
  v_today date;
  v_due_date date;
  v_split_total bigint;
  v_summary jsonb;
BEGIN
  PERFORM public.assert_society_membership(p_society_id);

  -- 403 before 404, and "may you" before "does it exist": the caller's standing is
  -- decided before the record's, matching the API's guard chain and the reason
  -- `expense_draft_delete()` orders its checks the same way.
  IF NOT public.can_publish_expenses(p_society_id) THEN
    RAISE EXCEPTION 'EXPENSE_PUBLISH_FORBIDDEN'
      USING ERRCODE = '42501',
            HINT = 'Only a society Admin or Treasurer can publish an expense.';
  END IF;

  SELECT e.status::text, e.version, e.amount_paise, e.due_date
    INTO v_status, v_version, v_amount, v_expense_due_date
    FROM public.expenses e
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_status NOT IN ('draft', 'pending_approval') THEN
    RAISE EXCEPTION 'EXPENSE_NOT_PUBLISHABLE'
      USING ERRCODE = 'P0001',
            DETAIL = v_status,
            HINT = 'Only a draft or an expense awaiting approval can be published.';
  END IF;

  IF v_version <> p_expected_version THEN
    RAISE EXCEPTION 'EXPENSE_VERSION_MISMATCH'
      USING ERRCODE = 'P0001',
            DETAIL = v_version::text,
            HINT = 'This expense was changed by someone else. Reload it and try again.';
  END IF;

  -- The dues' due date, decided once for the whole set (see the header). The
  -- expense's own `due_date` is the cycles/recurring module's channel; until it
  -- exists, the society's financial defaults are the rule.
  IF v_expense_due_date IS NOT NULL THEN
    v_due_date := v_expense_due_date;
  ELSE
    SELECT ss.due_day
      INTO v_due_day
      FROM public.society_settings ss
     WHERE ss.society_id = p_society_id;

    -- The society's timezone lives on `societies`, not on `society_settings`
    -- (20260920130000_society_core.sql). The first attempt at this function read
    -- `ss.timezone` and failed with 42703 on a live database — see this file's
    -- header.
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

  IF jsonb_typeof(p_splits) <> 'array' THEN
    RAISE EXCEPTION 'SPLIT_MISMATCH: the allocations are not a list'
      USING ERRCODE = 'P0001',
            HINT = 'A publish must carry the allocation list the split engine produced.';
  END IF;

  IF jsonb_array_length(p_splits) = 0 THEN
    RAISE EXCEPTION 'SPLIT_MISMATCH: expense % has no allocations', p_expense_id
      USING ERRCODE = 'P0001',
            HINT = 'A published expense must have splits summing exactly to its amount.';
  END IF;

  SELECT COALESCE(sum((entry ->> 'amount_paise')::bigint), 0)
    INTO v_split_total
    FROM jsonb_array_elements(p_splits) AS entry;

  IF v_split_total <> v_amount THEN
    RAISE EXCEPTION 'SPLIT_MISMATCH: expense % splits total % expected %',
      p_expense_id, v_split_total, v_amount
      USING ERRCODE = 'P0001',
            HINT = 'A published expense must have splits summing exactly to its amount.';
  END IF;

  -- Replace rather than assume none exist. A draft cannot normally have splits
  -- (T065's delete refuses one that does, and nothing in the product writes them
  -- before publication), but "publishing is the split set's writer" is only true
  -- if it is total: a stale row left by an earlier attempt would otherwise be
  -- summed by `chk_split_total()` alongside the new ones.
  DELETE FROM public.expense_splits s
   WHERE s.expense_id = p_expense_id
     AND s.society_id = p_society_id;

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
    (entry ->> 'apartment_id')::uuid,
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
  FROM jsonb_array_elements(p_splits) AS entry;

  -- The receivable, from the splits this call just wrote — one principal due per
  -- split, paisa for paisa, at the due date decided above — and the balance delta,
  -- aggregated per member and applied in the same statement. The data-modifying
  -- CTE's `RETURNING` set is the dues **this call** created, not a re-read, so a
  -- concurrent transaction's rows cannot leak into this delta. `ON CONFLICT DO
  -- UPDATE` runs its arithmetic on the locked row — `mb.total_due_paise +
  -- EXCLUDED.total_due_paise` — which is precisely "no lost update": two
  -- concurrent publications to one member add twice, whatever their interleaving.
  -- Nothing is read into the application and written back; `SELECT balance →
  -- calculate in TypeScript → UPDATE` is the lost-update shape this deliberately
  -- does not have.
  --
  -- `member_id` is NOT NULL by schema and the split column is nullable; a split
  -- with no member therefore raises 23502 here and takes the whole publication with
  -- it, which is the database's own fail-closed answer to "a due cannot address
  -- nobody" (the API refuses earlier with `unassigned_participants`).
  --
  -- `LEAST` ignores the NULL side, so `oldest_due_date` fills from the first dues
  -- and only ever moves earlier while dues can only be added.
  WITH created AS (
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
    -- Qualified for the same reason the rest of the body is: the RETURNS TABLE
    -- output parameters shadow these column names (T049's ambiguity class).
    RETURNING dues.member_id, dues.society_id, dues.amount_paise, dues.due_date
  ),
  per_member AS (
    SELECT
      created.member_id,
      created.society_id,
      sum(created.amount_paise)::bigint AS due_delta,
      min(created.due_date) AS oldest_due
    FROM created
    GROUP BY created.member_id, created.society_id
  )
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
    per_member.member_id,
    per_member.society_id,
    per_member.due_delta,
    0,
    0,
    per_member.due_delta,
    per_member.oldest_due,
    now()
  FROM per_member
  -- Named explicitly rather than inferred: `member_id` is also an output
  -- parameter name, and index inference would have to resolve it by name.
  ON CONFLICT ON CONSTRAINT member_balances_pkey DO UPDATE
     SET total_due_paise = mb.total_due_paise + EXCLUDED.total_due_paise,
         outstanding_paise = mb.outstanding_paise + EXCLUDED.outstanding_paise,
         oldest_due_date = LEAST(mb.oldest_due_date, EXCLUDED.oldest_due_date),
         updated_at = now();

  -- The transition, and the only place `published_at` is written. `version` is not
  -- set here: the shared `touch_updated_at()` trigger bumps it (and stamps
  -- `updated_at`) on every update of a table that has one, so the optimistic lock
  -- this function just checked cannot be skipped by a second writer path.
  UPDATE public.expenses e
     SET status = 'published',
         published_at = now()
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id;

  -- The summary is read back from `expense_splits`, so a response can only ever
  -- describe rows that committed. `min`/`max`/`sum` are the PRD §8.3 example's
  -- `splitSummary` (plus `totalPaise`, the conservation fact), and the amounts
  -- travel as text so no JSON number stands between a bigint and the API.
  SELECT jsonb_build_object(
           'participantCount', count(*),
           'totalPaise', COALESCE(sum(s.amount_paise), 0)::text,
           'minPaise', COALESCE(min(s.amount_paise), 0)::text,
           'maxPaise', COALESCE(max(s.amount_paise), 0)::text
         )
    INTO v_summary
    FROM public.expense_splits s
   WHERE s.expense_id = p_expense_id
     AND s.society_id = p_society_id;

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
      e.split_strategy::text,
      e.apartment_basis::text,
      e.split_config,
      e.participant_selector,
      e.status::text,
      e.created_by,
      e.published_at,
      e.voided_at,
      e.voided_by,
      e.void_reason,
      e.version,
      e.created_at,
      e.updated_at,
      v_summary AS split_summary
    FROM public.expenses e
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id;
END;
$$;

COMMENT ON FUNCTION public.expense_publish(uuid, uuid, integer, jsonb) IS
  'Publishes one draft or pending_approval expense, writing its splits, its per-split principal dues and the member_balances summary, atomically (T066/T067; timezone read and name resolution corrected in 20261006130000/20261006140000). Locks the expense row, enforces expense.publish, the lifecycle, the caller''s version and exact conservation of the supplied allocations, stamps status/published_at, and applies the balance delta with one set-based upsert. Returns the published row plus the persisted split summary.';

-- Grants restated rather than assumed: `CREATE OR REPLACE` preserves the ACL, and
-- the REVOKEs are what keep the executable surface of this function exactly the
-- roles T066 granted. `anon` is refused explicitly for the same reason T066 refused
-- it — a signed-out caller has no path to mint a bill.
REVOKE ALL ON FUNCTION public.expense_publish(uuid, uuid, integer, jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expense_publish(uuid, uuid, integer, jsonb)
  FROM anon;
GRANT EXECUTE ON FUNCTION public.expense_publish(uuid, uuid, integer, jsonb)
  TO authenticated;
