-- 20261004120000_expense_draft_delete.sql
--
-- `public.expense_draft_delete(uuid, uuid)` — the one path that hard-deletes an
-- expense, for Roadmap T065 (expense creation and draft lifecycle).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why this is a function and not a DELETE grant
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `20261001120000_expense_schema.sql` granted no DELETE on `expenses` and said
-- exactly where the write would come from:
--
--   "No DELETE policy: DELETE is not granted. SAD §8.1 puts expenses in the
--    'never deleted — voided instead' tier and revokes DELETE at the grant level.
--    The PRD's one exception ('Drafts can be hard-deleted by their creator',
--    §3.5.3) is recorded in the T060 report rather than granted here: it needs a
--    rule this policy cannot express (creator-only, draft-only, and only while no
--    split exists), which is a definer function's job — the same shape as
--    `apartment_soft_delete()`."
--
-- This migration is that function. The reason it cannot be an ordinary statement
-- in the API is structural: every request runs inside `UnitOfWork`, which does
-- `SET LOCAL ROLE authenticated`, so the caller is bound by the column grants no
-- matter how the repository is written — and there is no DELETE grant to bind.
-- "A draft is deletable by its creator only" is also three conditions at once
-- (creator, draft, no splits), which is precisely the shape a row policy cannot
-- express: a policy decides rows, not which of several rules a refusal came from.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- The rules, and the order they are checked in
-- ─────────────────────────────────────────────────────────────────────────────
--
--   1. `assert_society_membership` — a non-member (or a removed one) cannot tell
--      this society from a non-existent one, so 404 comes before anything else
--      (PRD T041). The same call every expense RPC makes.
--   2. The row is resolved `FOR UPDATE` scoped by `id AND society_id`: a
--      cross-society id is *absent* rather than forbidden, and locking it means a
--      concurrent transition cannot slip between the checks and the DELETE.
--   3. **Creator only** — PRD §3.5.3: "Drafts can be hard-deleted by their
--      creator." Not "their creator or a manager": the Roadmap's acceptance is
--      "Drafts hard-deletable by their creator only", and a manager who could
--      delete somebody's draft would erase work rather than review it. The
--      comparison is against the caller's membership id, resolved from
--      `auth.uid()` — never a value the caller sends.
--   4. **Draft only** — a published expense is voided (PRD §3.5.3, T061's matrix);
--      `pending_approval` is not a draft and is refused too, because sending a
--      submitted expense back to "deleted" would let a creator erase it after an
--      admin had seen it in the queue.
--   5. **No splits** — the column-level reason the T060 comment names. A draft
--      cannot normally have any, but the check makes the rule total: an expense
--      whose splits exist is a bill in progress and deleting it would walk rows
--      out from under `chk_split_total()`'s ledger.
--
-- 404 before 403 and "who are you" before "what state is it in", matching the
-- API's guard chain: the caller's standing is decided before the record's.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback
-- ─────────────────────────────────────────────────────────────────────────────
--
--   REVOKE ALL ON FUNCTION public.expense_draft_delete(uuid, uuid)
--     FROM PUBLIC, anon, authenticated;
--   DROP FUNCTION IF EXISTS public.expense_draft_delete(uuid, uuid);
--
-- Nothing else changes in either direction: this migration creates no table, no
-- column, no index, no policy and no row. Reverting it removes the ability to
-- delete a draft and nothing else.
CREATE OR REPLACE FUNCTION public.expense_draft_delete(
  p_expense_id uuid,
  p_society_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_created_by uuid;
  v_actor_member_id uuid;
BEGIN
  PERFORM public.assert_society_membership(p_society_id);

  SELECT e.status::text, e.created_by
    INTO v_status, v_created_by
    FROM public.expenses e
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id
     FOR UPDATE;

  IF NOT FOUND THEN
    -- The caller is an active member of this society, so a row that is not here
    -- is one they may not know: not in their society, or never existed — one
    -- answer, because distinguishing them would let a member enumerate another
    -- tenant's expense ids.
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT m.id
    INTO v_actor_member_id
    FROM public.members m
   WHERE m.society_id = p_society_id
     AND m.user_id = (SELECT auth.uid())
     AND m.status = 'active'
   LIMIT 1;

  -- Unreachable after `assert_society_membership`, and kept because the two
  -- resolve the caller by different routes: a NULL here must fail closed rather
  -- than fall through to the creator comparison.
  IF v_actor_member_id IS NULL THEN
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_created_by IS DISTINCT FROM v_actor_member_id THEN
    RAISE EXCEPTION 'EXPENSE_NOT_OWN_DRAFT'
      USING ERRCODE = 'P0003',
            HINT = 'Only the member who created a draft can delete it.';
  END IF;

  IF v_status <> 'draft' THEN
    RAISE EXCEPTION 'EXPENSE_NOT_DRAFT'
      USING ERRCODE = 'P0001',
            HINT = 'Only a draft can be deleted; a published expense is voided instead.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.expense_splits s
     WHERE s.expense_id = p_expense_id
       AND s.society_id = p_society_id
  ) THEN
    RAISE EXCEPTION 'EXPENSE_HAS_SPLITS'
      USING ERRCODE = 'P0001',
            HINT = 'This expense has been split; void it instead of deleting it.';
  END IF;

  DELETE FROM public.expenses
   WHERE id = p_expense_id
     AND society_id = p_society_id;

  IF NOT FOUND THEN
    -- The row was resolved and locked above, so this is unreachable; it is the
    -- same fail-closed guard the category delete keeps.
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.expense_draft_delete(uuid, uuid) IS
  'Hard delete of one draft expense (T065, PRD §3.5). 404 for a non-member or an expense outside the society, 403/P0003 for a member who did not create it, P0001/EXPENSE_NOT_DRAFT for a non-draft, P0001/EXPENSE_HAS_SPLITS while splits exist.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Privileges
-- ─────────────────────────────────────────────────────────────────────────────

-- Revoked from PUBLIC and `anon`, granted to `authenticated`, matching every other
-- RPC in this schema. Without the `anon` revoke the function would be callable by
-- a signed-out caller — harmless, because `auth.uid()` is NULL and the membership
-- assertion refuses, but "harmless because something else fails closed" is not a
-- privilege model.
REVOKE ALL ON FUNCTION public.expense_draft_delete(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expense_draft_delete(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.expense_draft_delete(uuid, uuid) TO authenticated;
