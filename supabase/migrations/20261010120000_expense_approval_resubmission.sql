-- ─────────────────────────────────────────────────────────────────────────────
-- T070 · ADR-0011 D2/D8 — a resubmission answers the rejection it corrects
-- ─────────────────────────────────────────────────────────────────────────────
-- Migration #31 (`20261009120000_expense_approval.sql`) gave `expenses` its
-- rejection columns, the approval guard and the two decision RPCs. One half of
-- D2 was missing from it, and the real-PostgreSQL suite found it:
--
--   "When a rejected draft is subsequently submitted for approval again: clear
--    rejection_reason, rejected_at, rejected_by."
--
-- `expense_reject()` writes the three stamps and `expense_approve()` clears them,
-- but the *resubmission* is not an RPC: it is an ordinary `PATCH /expenses/:id`
-- (`UpdateExpenseUseCase` → `Expense.submitForApproval()` → the repository's
-- `UPDATE`). That statement cannot clear them, because `rejected_by`,
-- `rejected_at` and `rejection_reason` are deliberately **not** in the
-- `authenticated` UPDATE grant — they are workflow evidence, and a client that
-- could write them could forge or erase an Admin's decision. Widening the grant
-- is therefore not the fix; the definer trigger is.
--
-- This migration replaces `guard_expense_approval_transition()` with the same
-- body plus one block: the single transition that *is* a resubmission,
-- `draft → pending_approval`, clears the three columns. Everything else is
-- unchanged — the approval invalidation, the `pending_approval → draft` refusal
-- and the unapproved at-or-above-threshold publication refusal all keep the
-- behaviour migration #31 established, and nothing here is a second authority:
-- the `expenses_update_author` policy, the column grants and the two decision
-- RPCs are untouched.
--
-- Forward-only, per the checksum ledger (`ses_meta.migrations`): the runner treats
-- a file whose recorded checksum no longer matches as fatal, so #31 is left
-- exactly as applied and the fix travels as its own step.

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

  -- (D2, the resubmission — added by this migration.) A rejected draft moving
  -- back into the queue answers the Admin's decision, so the three rejection
  -- columns are cleared in the same statement. They are not client-writable
  -- (which is what stops a forged or erased rejection), so this definer trigger
  -- is the only writer that can do it on the ordinary `PATCH` path. Clearing all
  -- three together also satisfies `chk_expenses_rejection_complete`, which is
  -- evaluated against the rewritten `NEW`.
  IF OLD.status = 'draft' AND NEW.status = 'pending_approval' THEN
    NEW.rejected_by := NULL;
    NEW.rejected_at := NULL;
    NEW.rejection_reason := NULL;
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
  'BEFORE UPDATE guard on expenses (T070, ADR-0011): invalidates an approval when an unpublished expense''s content changes, clears the rejection stamps when a rejected draft is resubmitted, and refuses a pending_approval → draft flip or an unapproved at-or-above-threshold publication with APPROVAL_REQUIRED. SECURITY DEFINER so it reads the current society threshold irrespective of the writer''s RLS.';

DROP TRIGGER IF EXISTS trg_expenses_approval_guard ON public.expenses;
CREATE TRIGGER trg_expenses_approval_guard
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.guard_expense_approval_transition();

-- A trigger function cannot be called outside a trigger, and is revoked anyway so
-- the executable surface has no exception to remember — the same discipline the
-- T060 trigger functions follow.
REVOKE ALL ON FUNCTION public.guard_expense_approval_transition()
  FROM PUBLIC, anon, authenticated;
