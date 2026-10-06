-- ─────────────────────────────────────────────────────────────────────────────
-- 20261008120000_expense_void.sql — T069, migration #30
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT THIS FILE DOES (ADR-0010, accepted 2026-10-06).
--
--   1. `public.expense_void(uuid, uuid, integer, text)` — the authoritative
--      void transaction: membership → `expense.void` capability → expense row
--      locked FOR UPDATE → lifecycle → `expectedVersion` → trimmed reason
--      (>= 10 chars, no control characters) → fail closed on an unsupported
--      current due state → capture per-member (A, P) and compute the exact
--      signed deltas BEFORE any write → supersede every current principal due
--      (id, amount, paid_paise and split_id preserved — the splits are NOT
--      touched, ADR-0010 Decision 1) → set-based `member_balances` update
--      (`total_due -= A`, `total_paid -= P`, `advance += P`,
--      `outstanding -= A`, ADR-0010 Decision 2) → recompute
--      `oldest_due_date` from the authoritative open dues → stamp the expense
--      (`status = 'void'`, `voided_at`, `voided_by`, `void_reason`; `version`
--      bumped by the shared trigger) → return the voided row + summary.
--   2. A void-completeness backstop: a `void` expense must carry `voided_at`,
--      `voided_by` and a reason of the DB-safe minimum. `voided_at`/`voided_by`
--      are deliberately NOT in the `authenticated` UPDATE grant (T060 withheld
--      the lifecycle stamps), while `status` and `void_reason` ARE — so without
--      this constraint an authenticated direct `UPDATE expenses SET
--      status = 'void', void_reason = '…'` would leave a half-voided expense:
--      status void, no reversal, no stamps. The constraint makes that write
--      impossible, so the definer RPC is the only writer that can complete a
--      void.
--
-- NOT changed, deliberately: every grant on `expenses`/`dues`
-- (`DELETE` is not granted on either — SAD §8.1's "never deleted, voided
-- instead" tier), every RLS policy, and every object migrations #1–29 created.
-- `fk_dues_expense … ON DELETE CASCADE` stays as it is: the owner (or a repair
-- script running as owner) could still cascade a due away with its expense, and
-- that residual owner-level hazard is recorded in ADR-0010 §"Database
-- hardening" rather than repaired here — T069 must not rewrite the schema of
-- applied migrations to paper over it.
--
-- Existing rows satisfy the new constraint: no `void` expense exists (the
-- lifecycle had no writer that could produce one).
--
-- Down (run by hand — the runner is forward-only, same convention as the other
-- twenty-nine files):
--   ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS chk_expenses_void_complete;
--   DROP FUNCTION IF EXISTS public.expense_void(uuid, uuid, integer, text);
-- Both are lossless: the constraint judges rows and the function writes them,
-- and neither is referenced by anything else.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · The void-completeness backstop
-- ─────────────────────────────────────────────────────────────────────────────

-- The existing `chk_expenses_void_reason` (migration #25) only requires the
-- reason to be non-NULL. This one adds the two stamps and the minimum length, so
-- a `void` row is necessarily a *completed* void. The length is checked on the
-- trimmed value with `length(...) >= 10`, the DB-safe form of the domain's own
-- `VOID_REASON_MIN_LENGTH` — the field rule itself stays in the domain, where a
-- message can be shown, and this is the backstop that keeps the two from
-- disagreeing about whether a void ever happened.
ALTER TABLE public.expenses
  DROP CONSTRAINT IF EXISTS chk_expenses_void_complete;
ALTER TABLE public.expenses
  ADD CONSTRAINT chk_expenses_void_complete CHECK (
    status <> 'void'
    OR (
      voided_at IS NOT NULL
      AND voided_by IS NOT NULL
      AND void_reason IS NOT NULL
      AND length(btrim(void_reason)) >= 10
    )
  );

COMMENT ON CONSTRAINT chk_expenses_void_complete ON public.expenses IS
  'A void expense carries its instant, its author and a reason of at least 10 characters (ADR-0010). `voided_at`/`voided_by` are not client-writable, so an authenticated direct UPDATE of `status`/`void_reason` cannot complete a void — the `expense_void()` definer transaction is the only writer that can.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · The authoritative void transaction
-- ─────────────────────────────────────────────────────────────────────────────

-- Mirrors `expense_publish()` (migration #26) and `expense_recalculate()`
-- (#28/#29): SECURITY DEFINER, `SET search_path = ''`, fully-qualified names,
-- membership then capability before any read, and the expense row locked before
-- the lifecycle and version checks so two lifecycle operations on one expense
-- serialise.
--
-- The `RETURNS TABLE` declarations are the corrected #29 shape — in particular
-- `payment_source varchar(24)` with an uncast `e.payment_source` in the
-- `RETURN QUERY` — because #28's `::text` there produced a runtime `42804` that
-- only a real PostgreSQL suite could see. `#variable_conflict use_column` is the
-- same directive #29 needed: the output column names (`status`, `version`, …)
-- are also table columns, and every reference below is qualified.
CREATE OR REPLACE FUNCTION public.expense_void(
  p_expense_id uuid,
  p_society_id uuid,
  p_expected_version integer,
  p_reason text
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
  void_summary jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_status text;
  v_version integer;
  v_actor_member uuid;
  v_reason text;
  v_bad_status text;
  v_bad_kind text;
  v_dues_superseded integer;
  v_credits bigint;
  v_affected uuid[];
  v_deltas jsonb;
  v_summary jsonb;
BEGIN
  -- 1 · The subject: a member of this society, or `P0002` (never 403 — a
  --     non-member and a cross-society id are one answer, PRD T041).
  PERFORM public.assert_society_membership(p_society_id);

  -- 2 · The capability, before anything is read. Voiding is the manager half of
  --     the matrix (`expense.void` full for Admin/Treasurer); a Committee
  --     Member's grant is own-drafts-only and cannot reach a published row.
  IF NOT public.can_publish_expenses(p_society_id) THEN
    RAISE EXCEPTION 'EXPENSE_VOID_FORBIDDEN'
      USING ERRCODE = '42501',
            HINT = 'Only a society Admin or Treasurer can void a published expense.';
  END IF;

  -- 3 · The expense row, locked, before the lifecycle and version checks. Held
  --     to COMMIT, so a concurrent void/recalculation on the same expense is
  --     ordered behind this one and sees the committed result.
  SELECT e.status::text, e.version
    INTO v_status, v_version
    FROM public.expenses e
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 4 · Only a published expense is a bill to reverse. Void is terminal, so a
  --     second void lands here — a refusal, deliberately not an idempotent
  --     success (ADR-0010).
  IF v_status <> 'published' THEN
    RAISE EXCEPTION 'EXPENSE_NOT_VOIDABLE'
      USING ERRCODE = 'P0001',
            DETAIL = v_status,
            HINT = 'Only a published expense can be voided; a draft is edited or deleted, and a void expense is final.';
  END IF;

  -- 5 · The optimistic lock, under the row lock it belongs to.
  IF v_version <> p_expected_version THEN
    RAISE EXCEPTION 'EXPENSE_VERSION_MISMATCH'
      USING ERRCODE = 'P0001',
            DETAIL = v_version::text,
            HINT = 'This expense was changed by someone else. Reload it and try again.';
  END IF;

  -- 6 · The reason: trimmed, at least ten characters, no control characters —
  --     the domain's own rule (`createVoidReason`), restated where the write
  --     happens so a caller reaching this function outside the API meets the
  --     same refusal.
  v_reason := btrim(p_reason);

  IF v_reason IS NULL OR length(v_reason) < 10 THEN
    RAISE EXCEPTION 'EXPENSE_VOID_REASON_TOO_SHORT'
      USING ERRCODE = 'P0001',
            DETAIL = 'reason',
            HINT = 'Give a reason of at least 10 characters — residents see it.';
  END IF;

  IF v_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'EXPENSE_VOID_REASON_INVALID'
      USING ERRCODE = 'P0001',
            DETAIL = 'reason',
            HINT = 'The void reason contains characters that are not allowed.';
  END IF;

  -- The actor's own membership row, stamped as `voided_by`.
  SELECT m.id
    INTO v_actor_member
    FROM public.members m
   WHERE m.society_id = p_society_id
     AND m.user_id = (SELECT auth.uid())
     AND m.status = 'active'
   LIMIT 1;

  IF v_actor_member IS NULL THEN
    RAISE EXCEPTION 'EXPENSE_VOID_FORBIDDEN'
      USING ERRCODE = '42501',
            HINT = 'Only a society Admin or Treasurer can void a published expense.';
  END IF;

  -- 7/8 · Fail closed on a current principal due whose state the void path has
  --       no accounting rule for. `waived` and `written_off` are documented
  --       statuses with no production writer; guessing what a void means for
  --       them would be inventing a rule, so the whole transaction is refused
  --       instead (ADR-0010). Already-superseded dues are history and are
  --       ignored, never an error.
  SELECT d.status::text
    INTO v_bad_status
    FROM public.dues d
   WHERE d.expense_id = p_expense_id
     AND d.society_id = p_society_id
     AND d.kind = 'principal'
     AND d.status IN ('waived', 'written_off')
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'EXPENSE_VOID_DUE_STATE_UNSUPPORTED: a current principal due is %', v_bad_status
      USING ERRCODE = 'P0001',
            DETAIL = v_bad_status,
            HINT = 'This expense has a due in a state voiding does not support. Resolve it first.';
  END IF;

  -- The same fail-closed rule for a non-principal current due (`late_fee`,
  -- `adjustment`): the reversal below supersedes principal dues only, so a
  -- current obligation of another kind would keep its share of the projection
  -- while the expense stops being a bill — a silent conservation hole. No
  -- production writer creates one today (T085/T086 own them); if one exists,
  -- voiding refuses rather than corrupting the balances.
  SELECT d.kind
    INTO v_bad_kind
    FROM public.dues d
   WHERE d.expense_id = p_expense_id
     AND d.society_id = p_society_id
     AND d.kind <> 'principal'
     AND d.status <> 'superseded'
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'EXPENSE_VOID_DUE_KIND_UNSUPPORTED: the expense carries a current % due', v_bad_kind
      USING ERRCODE = 'P0001',
            DETAIL = v_bad_kind,
            HINT = 'Voiding reverses principal dues only. Resolve the other obligation first.';
  END IF;

  -- 9/10 · The exact signed deltas, computed from the PRE-write state, before a
  --        single row is touched. `total_paid_paise` falls by what was applied
  --        to the superseded obligations and `advance_paise` rises by the same
  --        amount, so `outstanding = total_due − total_paid − advance` holds
  --        after the write exactly as it did before (ADR-0010 Decision 2).
  -- `outstanding` moves by **the whole obligation**, `−A`, and not by its unpaid
  -- remainder: the credit that replaces the payment is subtracted from the
  -- equation's right-hand side, so `outstanding = total_due − total_paid −
  -- advance` holds before and after (ADR-0010 Decision 2's worked example: an
  -- A=100000/P=40000 due takes outstanding from +60000 to −40000, i.e. by −100000).
  WITH lines AS (
    SELECT
      d.member_id,
      d.amount_paise,
      d.paid_paise
    FROM public.dues d
    WHERE d.expense_id = p_expense_id
      AND d.society_id = p_society_id
      AND d.kind = 'principal'
      AND d.status <> 'superseded'
  ),
  agg AS (
    SELECT
      l.member_id,
      sum(l.amount_paise)::bigint AS amount_paise,
      sum(l.paid_paise)::bigint AS paid_paise
    FROM lines l
    GROUP BY l.member_id
  )
  SELECT
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'member_id', a.member_id,
               'due_delta', (-a.amount_paise)::text,
               'paid_delta', (-a.paid_paise)::text,
               'advance_delta', a.paid_paise::text,
               'outstanding_delta', (-a.amount_paise)::text
             ))
        FROM agg a
    ), '[]'::jsonb),
    COALESCE((SELECT array_agg(a.member_id) FROM agg a), ARRAY[]::uuid[]),
    COALESCE((SELECT sum(a.paid_paise) FROM agg a), 0)::bigint
  INTO v_deltas, v_affected, v_credits;

  -- 11/12 · Every current principal due becomes history. `status` is the ONLY
  --         column written: the id, the amount, the paid history and the split
  --         link all survive (ADR-0010 Decision 1). `status` is not in
  --         `chk_due_billable`'s watched column list, so the deferred trigger
  --         does not pay a cost for a status-only supersession.
  UPDATE public.dues d
     SET status = 'superseded'::public.due_status
   WHERE d.expense_id = p_expense_id
     AND d.society_id = p_society_id
     AND d.kind = 'principal'
     AND d.status <> 'superseded';
  GET DIAGNOSTICS v_dues_superseded = ROW_COUNT;

  -- `expense_splits` is deliberately untouched: the bill a resident was charged
  -- against stays readable, `chk_due_current_split_present` stays satisfied and
  -- `chk_split_total()` early-returns for a non-published expense.

  -- 13 · The balance deltas, set-based and under the members' own rows (the same
  --      upsert shape T067's publish and T068's recalculation use: arithmetic in
  --      SQL, never a read-modify-write in the application).
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
    (entry ->> 'paid_delta')::bigint,
    (entry ->> 'advance_delta')::bigint,
    (entry ->> 'outstanding_delta')::bigint,
    NULL,
    now()
  FROM jsonb_array_elements(v_deltas) AS entry
  ON CONFLICT ON CONSTRAINT member_balances_pkey DO UPDATE
     SET total_due_paise = mb.total_due_paise + EXCLUDED.total_due_paise,
         total_paid_paise = mb.total_paid_paise + EXCLUDED.total_paid_paise,
         advance_paise = mb.advance_paise + EXCLUDED.advance_paise,
         outstanding_paise = mb.outstanding_paise + EXCLUDED.outstanding_paise,
         updated_at = now();

  -- 14 · `oldest_due_date`, recomputed from the authoritative current open dues
  --      — never the publish-time `LEAST` shortcut, so it can move later or
  --      become NULL when the superseded dues were the member's only ones.
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
   WHERE mb.member_id = sub.member_id
     AND mb.society_id = p_society_id;

  -- 15 · The expense itself. `version` is not set here: the shared
  --      `touch_updated_at()` trigger bumps it on every update that has the
  --      column, so the optimistic lock this function just checked cannot be
  --      skipped by a second writer path. No `expense_revisions` row is written:
  --      a void is not an edit (ADR-0010).
  UPDATE public.expenses e
     SET status = 'void'::public.expense_status,
         voided_at = now(),
         voided_by = v_actor_member,
         void_reason = v_reason
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id;

  -- 16 · The summary, measured from the rows this call committed.
  v_summary := jsonb_build_object(
    'duesSuperseded', v_dues_superseded,
    'creditsIssuedPaise', v_credits::text,
    'affectedMembers', COALESCE(array_length(v_affected, 1), 0)
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

COMMENT ON FUNCTION public.expense_void(uuid, uuid, integer, text) IS
  'Voids one published expense atomically (T069, ADR-0010): supersedes every current principal due preserving its amount, paid_paise and split link, moves member_balances by exact deltas (total_due -= A, total_paid -= P, advance += P, outstanding -= A), recomputes oldest_due_date, stamps status/voided_at/voided_by/void_reason and returns the voided row with its summary. SECURITY DEFINER; membership + expense.void enforced; the expense row is locked before the lifecycle and version checks; expense_splits and already-superseded dues are never modified.';

-- Grants restated rather than assumed, exactly as `expense_publish()` and
-- `expense_recalculate()` do: the default-privileges bootstrap would otherwise
-- hand EXECUTE to `authenticated` without a decision being made here.
REVOKE ALL ON FUNCTION public.expense_void(uuid, uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expense_void(uuid, uuid, integer, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.expense_void(uuid, uuid, integer, text) TO authenticated;
