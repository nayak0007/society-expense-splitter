-- ─────────────────────────────────────────────────────────────────────────────
-- 20261009120000_expense_approval.sql — T070, migration #31
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT THIS FILE DOES (ADR-0011, accepted 2026-10-06).
--
--   1. **Rejection metadata** on `expenses`: `rejection_reason text`,
--      `rejected_at timestamptz`, `rejected_by uuid`, the composite tenancy key
--      `fk_expenses_rejected_by (rejected_by, society_id) → members (id,
--      society_id)` (the same shape `approved_by`/`voided_by`/`created_by` use)
--      and `chk_expenses_rejection_complete`: a rejected row carries all three
--      or none, with a reason of at least the domain's own minimum.
--   2. **The Committee submission fix**: the `expenses_insert_author` and
--      `expenses_update_author` policies accept `status IN ('draft',
--      'pending_approval')` for a `can_draft_expenses` caller — a Committee
--      Member's otherwise-valid draft may *enter* `pending_approval` — while the
--      UPDATE policy's `USING` clause still requires the **stored** row to be
--      `draft`, so a submitted expense stays out of their reach. Entering
--      `pending_approval` is not permission to publish: approval is Admin-only
--      and publication reads the threshold (item 6).
--   3. **`public.guard_expense_approval_transition()`** — a `BEFORE UPDATE`
--      trigger on `expenses` that (a) invalidates an approval when the expense's
--      content changes while it is still unpublished (ADR-0011 D8 — the
--      lifecycle stamps are *not* client-writable, so this is the only place the
--      invalidation can happen without widening a grant), and (b) refuses
--      `pending_approval → draft` and `* → published` transitions that would
--      launder an unapproved at-or-above-threshold expense, raising the stable
--      `APPROVAL_REQUIRED`.
--   4. **`public.expense_approve(uuid, uuid, integer)`** — the authoritative
--      approval: `pending_approval → pending_approval`, stamping
--      `approved_by`/`approved_at` and clearing any stale rejection metadata.
--      Workflow state only: no split, due, balance, publication or revision row.
--   5. **`public.expense_reject(uuid, uuid, integer, text)`** — the
--      authoritative rejection: `pending_approval → draft`, clearing the
--      approval and stamping the validated reason. No financial row is touched.
--   6. **`public.expense_publish`** is `CREATE OR REPLACE`d with **only** the
--      approval precondition added — at-or-above the *current* society threshold
--      requires `status = 'pending_approval'` with both approval stamps, read
--      under the row lock and before any financial write. The algorithm
--      (participant-independent split write, dues, balances, stamps, summary) is
--      T066/T067's, verbatim; T066 remains the single implementation.
--
-- WHY THIS IS ONE MIGRATION. The columns, the policy, the guard and the three
-- functions are one atomic decision: a window in which the columns exist without
-- the guard, or the guard without the precondition in `expense_publish`, would be
-- a window in which an unapproved high-value expense is publishable. SQL is
-- transactional, so they land together or not at all. Only a `CREATE OR REPLACE`
-- whose *return type changes* would need its own file (PostgreSQL refuses that in
-- place); none of the three does — `expense_approve`/`expense_reject` are new
-- functions and `expense_publish`'s signature and `RETURNS TABLE` are unchanged.
--
-- NOT changed, deliberately: migrations #1–30 are immutable and untouched. In
-- particular `expense_recalculate()` (T068) and `expense_void()` (T069) are
-- **not** replaced — their returned row keeps its shape and the API reads the
-- approval columns beside it. `expense_revisions`, `dues`, `member_balances` and
-- `expense_splits` are untouched by this file.
--
-- Existing rows satisfy the new constraint: no expense carries any rejection
-- stamp (the columns are new, so they are all NULL) and no `pending_approval`
-- row was ever approved in production (nothing wrote `approved_by`).
--
-- Down (run by hand — the runner is forward-only, same convention as the other
-- thirty files):
--   DROP TRIGGER IF EXISTS trg_expenses_approval_guard ON public.expenses;
--   DROP FUNCTION IF EXISTS public.guard_expense_approval_transition();
--   DROP FUNCTION IF EXISTS public.expense_approve(uuid, uuid, integer);
--   DROP FUNCTION IF EXISTS public.expense_reject(uuid, uuid, integer, text);
--   -- and restore the previous body of public.expense_publish(uuid, uuid,
--   -- integer, jsonb) from 20261006140000_fix_expense_publish_shadowing.sql
--   -- (it is replaced, not merely extended, below).
--   -- and restore the two `expenses` policies from
--   -- 20261001120000_expense_schema.sql.
--   ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS chk_expenses_rejection_complete;
--   ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS fk_expenses_rejected_by;
--   ALTER TABLE public.expenses DROP COLUMN IF EXISTS rejection_reason;
--   ALTER TABLE public.expenses DROP COLUMN IF EXISTS rejected_at;
--   ALTER TABLE public.expenses DROP COLUMN IF EXISTS rejected_by;
-- Lossless apart from the rejection metadata of any row that was rejected while
-- this migration was applied, which the Down block above discards by design.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · Rejection metadata (ADR-0011 D2)
-- ─────────────────────────────────────────────────────────────────────────────

-- `IF NOT EXISTS` on each column so the file is re-runnable (`DROP … IF EXISTS` +
-- `ADD` would fail on a database where the columns already exist and a dependent
-- constraint is in the way, the same reason `20261001120000_expense_schema.sql`
-- adds `uq_members_id_society` conditionally).
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by uuid;

COMMENT ON COLUMN public.expenses.rejection_reason IS
  'Why an Admin rejected this expense (ADR-0011 D2). Trimmed, at least 10 characters, no control characters. Required beside rejected_at/rejected_by; cleared when the expense is submitted for approval again or approved.';
COMMENT ON COLUMN public.expenses.rejected_at IS
  'When the rejection was recorded, from the database clock. Not client-writable.';
COMMENT ON COLUMN public.expenses.rejected_by IS
  'The Admin membership that rejected the expense. Composite FK to members (id, society_id), like approved_by.';

-- The composite tenancy key: an expense can never name a rejecter from another
-- society. Added conditionally for the re-runnability reason above.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'fk_expenses_rejected_by'
       AND conrelid = 'public.expenses'::regclass
  ) THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT fk_expenses_rejected_by
        FOREIGN KEY (rejected_by, society_id)
        REFERENCES public.members (id, society_id);
  END IF;
END
$$;

-- All three or none, and a usable reason — the reject-completeness backstop that
-- mirrors `chk_expenses_void_complete` (T069). The length is checked on the
-- trimmed value with `length(...) >= 10`, the DB-safe form of the domain's own
-- `REJECTION_REASON_MIN_LENGTH`; the field rule itself stays in the domain, where
-- a message can be shown. A partial write — a reason with no stamp, a stamp with
-- no reason — is refused, so a row can never claim a rejection that did not
-- happen or hide one that did.
ALTER TABLE public.expenses
  DROP CONSTRAINT IF EXISTS chk_expenses_rejection_complete;
ALTER TABLE public.expenses
  ADD CONSTRAINT chk_expenses_rejection_complete CHECK (
    (
      rejected_by IS NULL
      AND rejected_at IS NULL
      AND rejection_reason IS NULL
    )
    OR (
      rejected_by IS NOT NULL
      AND rejected_at IS NOT NULL
      AND rejection_reason IS NOT NULL
      AND length(btrim(rejection_reason)) >= 10
    )
  );

COMMENT ON CONSTRAINT chk_expenses_rejection_complete ON public.expenses IS
  'A rejected expense carries its reason, instant and author together — all three or none, with a reason of at least 10 characters (ADR-0011 D2).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · The Committee submission fix (ADR-0011, "Committee submission deadlock")
-- ─────────────────────────────────────────────────────────────────────────────

-- A `can_draft_expenses` caller (Committee Member) could not *insert* or *update*
-- a row whose status was `pending_approval`, so their above-threshold draft could
-- never enter the approval queue — the deadlock the audit found. Both policies
-- now accept `status IN ('draft', 'pending_approval')` from that branch.
--
-- Two things stay exactly as they were, and both matter:
--
--   * the UPDATE policy's `USING` clause still requires the **stored** row to be
--     `draft`, so a Committee Member can move their own draft *into*
--     `pending_approval` (the `WITH CHECK` sees the new row) but cannot touch a
--     row that is already submitted — the application's resource decision
--     (`snapshotOf`: `published: status !== 'draft'`) refuses them there too, and
--     this policy is the database's half of the same narrowing;
--   * `published` is still not writable by them, and publication is gated on the
--     threshold at publish time (item 6), so nothing here grants a Committee
--     Member a new financial capability: entering `pending_approval` is not
--     permission to publish.
DROP POLICY IF EXISTS expenses_insert_author ON public.expenses;
CREATE POLICY expenses_insert_author
  ON public.expenses
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.can_publish_expenses(society_id)
    OR (
      public.can_draft_expenses(society_id)
      AND status IN ('draft', 'pending_approval')
    )
  );

DROP POLICY IF EXISTS expenses_update_author ON public.expenses;
CREATE POLICY expenses_update_author
  ON public.expenses
  FOR UPDATE
  TO authenticated
  USING (
    public.can_publish_expenses(society_id)
    OR (public.can_draft_expenses(society_id) AND status = 'draft')
  )
  WITH CHECK (
    public.can_publish_expenses(society_id)
    OR (
      public.can_draft_expenses(society_id)
      AND status IN ('draft', 'pending_approval')
    )
  );

COMMENT ON POLICY expenses_update_author ON public.expenses IS
  'Admin/Treasurer may write any state; a Committee Member may write a draft, and may move their own draft into pending_approval (ADR-0011). A stored pending_approval/published row is outside their reach.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · The approval guard (ADR-0011 D4/D8, direct-write hardening)
-- ─────────────────────────────────────────────────────────────────────────────

-- Two jobs, both of which have to happen at the row boundary:
--
--   (a) **Approval invalidation (D8).** An approval is bound to the exact
--       content/version it approved. The lifecycle stamps are deliberately NOT in
--       the `authenticated` UPDATE grant (T060 withheld them so a client cannot
--       backdate a bill), so the application *cannot* clear `approved_by` with a
--       plain `UPDATE` — and widening that grant would let a client forge an
--       approval, which is precisely what the "approved_at/approved_by cannot be
--       forged through client grants" test forbids. A `BEFORE UPDATE` trigger is
--       therefore the only place the invalidation can live: it rewrites `NEW`,
--       which no column grant polices. A published or void row is untouched, so
--       ADR-0009 §18's "lifecycle/approval fields" rule (a published
--       recalculation never changes approval) still holds.
--
--   (b) **Transition hardening.** `pending_approval → draft` was reachable
--       through the column grant (`status` is writable) and the
--       `expenses_update_author` policy for an Admin/Treasurer — a way to launder
--       an unapproved high-value expense into a publishable draft. The guard
--       refuses it unless the same statement stamps a *complete* rejection (the
--       authoritative rejection RPC's shape — and the rejection columns are not
--       client-writable, so this cannot be forged) or the new amount is below the
--       **current** threshold (D8's edit routing). It also re-asserts the
--       publication precondition for any writer that is not the RPC, which is the
--       defense-in-depth half of D4.
--
-- The threshold is read from `society_settings` at write time, so it is the
-- *current* one. A cross-table lock on `society_settings` is deliberately not
-- taken (ADR-0011, Consequences): the authoritative read happens after the
-- expense row's own lock and the invariant holds wherever the threshold moves.
CREATE OR REPLACE FUNCTION public.guard_expense_approval_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_threshold bigint;
  v_content_changed boolean;
BEGIN
  -- Every editable, allocation-driving column. Changing any of them on an
  -- unpublished expense invalidates the approval: the approval described the row
  -- as it was, and the conservative rule (D8) is that *any* successful user edit
  -- invalidates it. The stamps themselves (`approved_by`, `approved_at`) and the
  -- rejection metadata are deliberately absent from this list — writing them is
  -- not a content change, and `expense_approve()` writes them on a row whose
  -- status does not move.
  v_content_changed := (
    NEW.category_id IS DISTINCT FROM OLD.category_id
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.amount_paise IS DISTINCT FROM OLD.amount_paise
    OR NEW.expense_date IS DISTINCT FROM OLD.expense_date
    OR NEW.vendor_name IS DISTINCT FROM OLD.vendor_name
    OR NEW.payment_source IS DISTINCT FROM OLD.payment_source
    OR NEW.paid_by_member_id IS DISTINCT FROM OLD.paid_by_member_id
    OR NEW.split_strategy IS DISTINCT FROM OLD.split_strategy
    OR NEW.apartment_basis IS DISTINCT FROM OLD.apartment_basis
    OR NEW.split_config IS DISTINCT FROM OLD.split_config
    OR NEW.participant_selector IS DISTINCT FROM OLD.participant_selector
    OR NEW.due_date IS DISTINCT FROM OLD.due_date
  );

  IF OLD.status IN ('draft', 'pending_approval') AND v_content_changed THEN
    NEW.approved_by := NULL;
    NEW.approved_at := NULL;
  END IF;

  -- Nothing further to judge unless the lifecycle moves.
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT ss.approval_threshold_paise
    INTO v_threshold
    FROM public.society_settings ss
   WHERE ss.society_id = NEW.society_id;

  -- The column is NOT NULL with a default, so this only guards a society whose
  -- settings row is missing (a hand-built fixture); the default is the PRD's own.
  v_threshold := COALESCE(v_threshold, 1000000);

  -- (a) Sending an at-or-above-threshold expense back to draft.
  IF OLD.status = 'pending_approval' AND NEW.status = 'draft' THEN
    -- The authoritative rejection: the same statement records the reason, its
    -- instant and its author (ADR-0011's rejection semantics). The columns are not
    -- in the `authenticated` UPDATE grant, so a client cannot reach this branch.
    IF NEW.rejected_by IS NOT NULL
       AND NEW.rejected_at IS NOT NULL
       AND NEW.rejection_reason IS NOT NULL THEN
      RETURN NEW;
    END IF;

    -- The edit that dropped the amount below the current threshold (D8): the
    -- expense no longer needs approval, so returning it to a draft is correct.
    IF NEW.amount_paise < v_threshold THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'APPROVAL_REQUIRED'
      USING ERRCODE = 'P0001',
            DETAIL = NEW.status::text,
            HINT = 'This expense needs an Admin''s approval. Reject it through the approval route instead of sending it back to draft.';
  END IF;

  -- (b) Becoming a bill. The definer function checks this too, before any
  --     financial write; this is the half that covers every other writer.
  IF NEW.status = 'published'
     AND NEW.amount_paise >= v_threshold
     AND (NEW.approved_by IS NULL OR NEW.approved_at IS NULL) THEN
    RAISE EXCEPTION 'APPROVAL_REQUIRED'
      USING ERRCODE = 'P0001',
            DETAIL = NEW.status::text,
            HINT = 'An expense at or above the approval threshold must be approved by an Admin before it can be published.';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.guard_expense_approval_transition() IS
  'BEFORE UPDATE guard on expenses (T070, ADR-0011): invalidates an approval when an unpublished expense''s content changes, and refuses a pending_approval → draft flip or an unapproved at-or-above-threshold publication with APPROVAL_REQUIRED. SECURITY DEFINER so it reads the current society threshold irrespective of the writer''s RLS.';

DROP TRIGGER IF EXISTS trg_expenses_approval_guard ON public.expenses;
CREATE TRIGGER trg_expenses_approval_guard
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.guard_expense_approval_transition();

-- A trigger function cannot be called outside a trigger, and is revoked anyway so
-- the executable surface has no exception to remember — the same discipline the
-- T060 trigger functions follow.
REVOKE ALL ON FUNCTION public.guard_expense_approval_transition()
  FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4 · The authoritative approval
-- ─────────────────────────────────────────────────────────────────────────────

-- `pending_approval → pending_approval`, one version later, with the approval
-- stamped. It is deliberately **not** a publication: no split is written, no due
-- is created, no balance moves, `published_at` is untouched, no
-- `expense_revisions` row is appended and no domain event is raised (ADR-0011,
-- "Approval semantics"). Approving is the decision; publishing is T066's
-- transaction, and T070 keeps them separable — which is what makes "approval then
-- publish" and "publish refused for lack of approval" two different facts.
--
-- The order is the one ADR-0011 fixes: membership → capability → row lock →
-- status → version → not-already-approved → stamps. Membership and capability
-- come first for the reason every other RPC here states: a definer function is
-- callable directly by any `authenticated` caller, so every rule a policy cannot
-- see is restated inside it.
--
-- `RETURNS TABLE` output names shadow column names, hence
-- `#variable_conflict use_column` and a fully-qualified `e.` on every reference —
-- the defect class `20260926140000_fix_join_options_ambiguity.sql` exists to
-- remember. The returned column types are the T069 shape: `amount_paise`,
-- `expense_date`, `split_strategy`, `apartment_basis` and `status` as `text`,
-- `payment_source` as its own `varchar(24)` with an **uncast** select (the #28
-- 42804 lesson), and the new approval/rejection columns in their own types.
CREATE OR REPLACE FUNCTION public.expense_approve(
  p_expense_id uuid,
  p_society_id uuid,
  p_expected_version integer
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
  approved_by uuid,
  approved_at timestamptz,
  rejected_by uuid,
  rejected_at timestamptz,
  rejection_reason text,
  version integer,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_column
DECLARE
  v_status text;
  v_version integer;
  v_approved_by uuid;
  v_actor_member uuid;
BEGIN
  -- 1 · The subject: a member of this society, or `P0002` (never 403 — a
  --     non-member and a cross-society id are one answer, PRD T041).
  PERFORM public.assert_society_membership(p_society_id);

  -- 2 · The capability, before anything is read. `expense.approve` is a full
  --     Admin cell (PRD §2.1); a Treasurer cannot approve anything — including
  --     their own expense — and that is a role rule, not a self-approval rule
  --     (ADR-0011 D5).
  IF NOT public.is_society_admin(p_society_id) THEN
    RAISE EXCEPTION 'EXPENSE_APPROVE_FORBIDDEN'
      USING ERRCODE = '42501',
            HINT = 'Only a society Admin can approve an expense.';
  END IF;

  -- 3 · The expense row, locked, before the lifecycle and version checks. Held to
  --     COMMIT, so a concurrent approve/reject/publish/edit on the same expense is
  --     ordered behind this one and sees the committed result.
  SELECT e.status::text, e.version, e.approved_by
    INTO v_status, v_version, v_approved_by
    FROM public.expenses e
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 4 · Only an expense waiting for a decision can be approved.
  IF v_status <> 'pending_approval' THEN
    RAISE EXCEPTION 'EXPENSE_NOT_APPROVABLE'
      USING ERRCODE = 'P0001',
            DETAIL = v_status,
            HINT = 'Only an expense awaiting approval can be approved. A draft is published or submitted; a published expense is voided.';
  END IF;

  -- 5 · The optimistic lock, under the row lock it belongs to.
  IF v_version <> p_expected_version THEN
    RAISE EXCEPTION 'EXPENSE_VERSION_MISMATCH'
      USING ERRCODE = 'P0001',
            DETAIL = v_version::text,
            HINT = 'This expense was changed by someone else. Reload it and try again.';
  END IF;

  -- 6 · Already approved. A second approval is a refusal, not a quiet success:
  --     the version the caller held is stale precisely because the first approval
  --     committed, and pretending otherwise would hide a lost race.
  IF v_approved_by IS NOT NULL THEN
    RAISE EXCEPTION 'EXPENSE_ALREADY_APPROVED'
      USING ERRCODE = 'P0001',
            DETAIL = v_status,
            HINT = 'This expense has already been approved.';
  END IF;

  -- The actor's own membership row, stamped as `approved_by`.
  SELECT m.id
    INTO v_actor_member
    FROM public.members m
   WHERE m.society_id = p_society_id
     AND m.user_id = (SELECT auth.uid())
     AND m.status = 'active'
   LIMIT 1;

  IF v_actor_member IS NULL THEN
    RAISE EXCEPTION 'EXPENSE_APPROVE_FORBIDDEN'
      USING ERRCODE = '42501',
            HINT = 'Only a society Admin can approve an expense.';
  END IF;

  -- 7 · The stamps, and the stale rejection metadata cleared in the same
  --     statement. The status does not move: approval is not publication.
  --     `version` is not set here — the shared `touch_updated_at()` trigger bumps
  --     it on every update that has the column, so the optimistic lock this
  --     function just checked cannot be skipped by a second writer path.
  UPDATE public.expenses e
     SET approved_by = v_actor_member,
         approved_at = now(),
         rejected_by = NULL,
         rejected_at = NULL,
         rejection_reason = NULL
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id;

  -- 8 · The authoritative row, read back from what committed.
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
      e.approved_by,
      e.approved_at,
      e.rejected_by,
      e.rejected_at,
      e.rejection_reason,
      e.version,
      e.created_at,
      e.updated_at
    FROM public.expenses e
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id;
END;
$$;

COMMENT ON FUNCTION public.expense_approve(uuid, uuid, integer) IS
  'Approves one pending_approval expense (T070, ADR-0011): Admin-only, locks the row, checks the lifecycle and the caller''s version, refuses a second approval, then stamps approved_by/approved_at and clears stale rejection metadata. Workflow state only — no split, due, balance, publication or revision write, and no domain event.';

REVOKE ALL ON FUNCTION public.expense_approve(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expense_approve(uuid, uuid, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.expense_approve(uuid, uuid, integer) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5 · The authoritative rejection
-- ─────────────────────────────────────────────────────────────────────────────

-- `pending_approval → draft`, clearing the approval and recording who sent it
-- back and why (ADR-0011 D1/D2). `draft` is not a `rejected` status: the expense
-- is a draft that needs correction, it may be edited and submitted again, and
-- re-submitting clears the three rejection columns.
--
-- The reason is trimmed, at least ten characters and free of control characters —
-- the domain's own rule (`createRejectionReason`), restated where the write
-- happens so a caller reaching this function outside the API meets the same
-- refusal. No financial row is touched: dues, balances, splits and revisions are
-- exactly as they were.
CREATE OR REPLACE FUNCTION public.expense_reject(
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
  approved_by uuid,
  approved_at timestamptz,
  rejected_by uuid,
  rejected_at timestamptz,
  rejection_reason text,
  version integer,
  created_at timestamptz,
  updated_at timestamptz
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
BEGIN
  -- 1 · Membership (P0002), 2 · the Admin capability (42501) — the same order and
  --     the same reasons as `expense_approve()`.
  PERFORM public.assert_society_membership(p_society_id);

  IF NOT public.is_society_admin(p_society_id) THEN
    RAISE EXCEPTION 'EXPENSE_REJECT_FORBIDDEN'
      USING ERRCODE = '42501',
            HINT = 'Only a society Admin can reject an expense.';
  END IF;

  -- 3 · The row, locked, before the lifecycle and version checks.
  SELECT e.status::text, e.version
    INTO v_status, v_version
    FROM public.expenses e
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- 4 · Only an expense waiting for a decision can be rejected.
  IF v_status <> 'pending_approval' THEN
    RAISE EXCEPTION 'EXPENSE_NOT_REJECTABLE'
      USING ERRCODE = 'P0001',
            DETAIL = v_status,
            HINT = 'Only an expense awaiting approval can be rejected. A draft is edited or deleted; a published expense is voided.';
  END IF;

  -- 5 · The optimistic lock, under the row lock it belongs to.
  IF v_version <> p_expected_version THEN
    RAISE EXCEPTION 'EXPENSE_VERSION_MISMATCH'
      USING ERRCODE = 'P0001',
            DETAIL = v_version::text,
            HINT = 'This expense was changed by someone else. Reload it and try again.';
  END IF;

  -- 6 · The reason, before any write.
  v_reason := btrim(p_reason);

  IF v_reason IS NULL OR length(v_reason) < 10 THEN
    RAISE EXCEPTION 'EXPENSE_REJECTION_REASON_TOO_SHORT'
      USING ERRCODE = 'P0001',
            DETAIL = 'reason',
            HINT = 'Give a reason of at least 10 characters — the creator sees it.';
  END IF;

  IF v_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'EXPENSE_REJECTION_REASON_INVALID'
      USING ERRCODE = 'P0001',
            DETAIL = 'reason',
            HINT = 'The rejection reason contains characters that are not allowed.';
  END IF;

  SELECT m.id
    INTO v_actor_member
    FROM public.members m
   WHERE m.society_id = p_society_id
     AND m.user_id = (SELECT auth.uid())
     AND m.status = 'active'
   LIMIT 1;

  IF v_actor_member IS NULL THEN
    RAISE EXCEPTION 'EXPENSE_REJECT_FORBIDDEN'
      USING ERRCODE = '42501',
            HINT = 'Only a society Admin can reject an expense.';
  END IF;

  -- 7 · The transition and the stamps, in one statement: the approval is cleared
  --     (a rejection is the opposite decision about the same version) and a
  --     complete rejection is recorded, which is what lets the BEFORE UPDATE
  --     guard distinguish this from a status flip. `version` is the shared
  --     trigger's.
  UPDATE public.expenses e
     SET status = 'draft'::public.expense_status,
         approved_by = NULL,
         approved_at = NULL,
         rejected_by = v_actor_member,
         rejected_at = now(),
         rejection_reason = v_reason
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id;

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
      e.approved_by,
      e.approved_at,
      e.rejected_by,
      e.rejected_at,
      e.rejection_reason,
      e.version,
      e.created_at,
      e.updated_at
    FROM public.expenses e
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id;
END;
$$;

COMMENT ON FUNCTION public.expense_reject(uuid, uuid, integer, text) IS
  'Rejects one pending_approval expense (T070, ADR-0011): Admin-only, locks the row, checks the lifecycle and the caller''s version, validates the reason, then moves it to draft clearing the approval and recording rejected_by/rejected_at/rejection_reason. No financial row is touched.';

REVOKE ALL ON FUNCTION public.expense_reject(uuid, uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expense_reject(uuid, uuid, integer, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.expense_reject(uuid, uuid, integer, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6 · expense_publish, v5 — the approval precondition, and nothing else changed
-- ─────────────────────────────────────────────────────────────────────────────

-- The ONLY difference from 20261006140000_fix_expense_publish_shadowing.sql is the
-- precondition below: the row lock now also reads the approval stamps, and after
-- the version check — before the due date is decided, before a split is deleted or
-- written, before a due or a balance exists — the function compares the expense's
-- amount with the **current** society threshold and refuses an unapproved
-- at-or-above-threshold publication with the stable `APPROVAL_REQUIRED`.
--
-- The threshold is read here rather than trusted from `status` because
-- `status` alone cannot answer the question (ADR-0011 D4): a draft is publishable
-- when its amount is below the threshold, and a `pending_approval` row is
-- publishable when it is below it too (no deadlock), while anything at or above it
-- needs both stamps. Everything else — the split conservation check, the replace
-- rather than assume, the per-split principal dues, the set-based balance upsert,
-- the `status`/`published_at` stamp and the summary read back from the table — is
-- the T067 algorithm verbatim. T066 remains the single implementation of
-- financial publication; T070 adds a gate and no arithmetic.
--
-- `CREATE OR REPLACE` preserves the ACL, and the REVOKEs are restated anyway so
-- the executable surface stays exactly the roles T066 granted.
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
  v_approved_by uuid;
  v_approved_at timestamptz;
  v_threshold bigint;
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

  SELECT e.status::text, e.version, e.amount_paise, e.due_date,
         e.approved_by, e.approved_at
    INTO v_status, v_version, v_amount, v_expense_due_date,
         v_approved_by, v_approved_at
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

  -- ★ T070 / ADR-0011 D4 — the approval precondition. Under the row lock, after
  --   the lifecycle and version checks, and **before** the due date is decided or
  --   a single split, due or balance row is touched: a refusal here leaves the
  --   transaction with no financial write at all.
  SELECT ss.approval_threshold_paise
    INTO v_threshold
    FROM public.society_settings ss
   WHERE ss.society_id = p_society_id;

  v_threshold := COALESCE(v_threshold, 1000000);

  IF v_amount >= v_threshold
     AND (
       v_status <> 'pending_approval'
       OR v_approved_by IS NULL
       OR v_approved_at IS NULL
     ) THEN
    RAISE EXCEPTION 'APPROVAL_REQUIRED'
      USING ERRCODE = 'P0001',
            DETAIL = v_status,
            HINT = 'An expense at or above the approval threshold must be approved by an Admin before it can be published.';
  END IF;

  -- The dues' due date, decided once for the whole set (see T067's header). The
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
    -- `ss.timezone` and failed with 42703 on a live database.
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
  -- EXCLUDED.total_due_paise` — which is precisely "no lost update".
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
    -- output parameters shadow these column names.
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

  -- The transition, and the only place `published_at` is written. The approval
  -- stamps are deliberately left as they are — publication does not consume the
  -- approval, it cites it, and a published row keeps the record of who approved
  -- it. `version` is not set here: the shared `touch_updated_at()` trigger bumps
  -- it (and stamps `updated_at`) on every update of a table that has one, so the
  -- optimistic lock this function just checked cannot be skipped by a second
  -- writer path.
  UPDATE public.expenses e
     SET status = 'published',
         published_at = now()
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id;

  -- The summary is read back from `expense_splits`, so a response can only ever
  -- describe rows that committed.
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
  'Publishes one draft or pending_approval expense, writing its splits, its per-split principal dues and the member_balances summary, atomically (T066/T067; the approval precondition added by T070, ADR-0011). Locks the expense row, enforces expense.publish, the lifecycle, the caller''s version, the current society approval threshold (at or above it requires status = pending_approval with both approval stamps, else APPROVAL_REQUIRED) and exact conservation of the supplied allocations, then stamps status/published_at. Returns the published row plus the persisted split summary.';

REVOKE ALL ON FUNCTION public.expense_publish(uuid, uuid, integer, jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expense_publish(uuid, uuid, integer, jsonb)
  FROM anon;
GRANT EXECUTE ON FUNCTION public.expense_publish(uuid, uuid, integer, jsonb)
  TO authenticated;
