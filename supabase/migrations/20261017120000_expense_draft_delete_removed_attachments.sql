-- 20261017120000_expense_draft_delete_removed_attachments.sql
--
-- `public.expense_draft_delete(uuid, uuid)` now **returns the attachment rows it
-- removed** instead of `void` — T050 Stage E2, ADR-0014 D16.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- The gap this closes, and why it is exactly this shape
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Since T071 (ADR-0012 D6.5) this function hard-deletes a draft's `attachments`
-- rows in the same transaction that deletes the draft. The audit trail recorded the
-- *expense's* removal and nothing about the bills that went with it: the log held an
-- `attachment.created` for each reservation and one `expense.deleted`, with no row
-- saying which attachment rows the cascade took. ADR-0014 D12 recorded that as a
-- **finding** and named five ways to give it accountability without implementing any
-- of them. This migration implements the second, smallest complete one: **name the
-- removed attachments in the single `expense.deleted` entry's `metadata`**.
--
-- The other four are still rejected, for the reasons D12 and D16 record:
--
--   * reading the cascade off the existing `attachment.created` rows needs no change
--     but cannot say *when* a row went or by whose request, which is the half a
--     support question actually asks;
--   * one `attachment.deleted` per cascaded row is complete but noisy (several rows
--     for one request) and needs the same locking this does;
--   * an `AFTER DELETE` trigger on `attachments` is complete by construction but
--     moves the entry's construction into SQL, where the redaction rule, the action
--     vocabulary and the writer's descriptor seam all live in TypeScript — it would
--     be the first audit row in this schema assembled outside `@ses/domain`;
--   * refusing the draft delete while attachment rows exist
--     (`EXPENSE_HAS_ATTACHMENTS`) is race-free and complete, but it is a **product**
--     rule — the user would have to remove the bill before the draft — and D16
--     records it as a decision for the product, not for the log.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why the return type has to change, rather than the caller reading first
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The API *can* read a draft's attachment rows before calling this (it already does,
-- for the storage keys its best-effort object cleanup needs). That read is not
-- sufficient and D12 says why: a reservation committing between the read and the
-- delete is removed by the cascade but absent from the read, so the log would be
-- incomplete in exactly the case an auditor cares about. The `DELETE ... RETURNING`
-- **inside** the function is the statement that removed the rows, so its result is
-- complete by construction — the same reasoning `AttachmentRepository.deleteById`
-- records for taking its `before` snapshot from `RETURNING` rather than a second
-- query that could race it.
--
-- The value crosses as `jsonb` (a JSON array of id strings), not as `uuid[]`. That is
-- deliberate: `uuid[]` has no parser in the driver this project uses, so it would
-- arrive as the literal text `{a,b}` and every caller would hand-parse PostgreSQL's
-- array syntax; `jsonb` is already how every other RPC response in this schema
-- crosses (`expense_approve`, `expense_recalculate`, the society RPCs), and the
-- repository validates it with the same zod schema it validates every other row with.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Nothing else changes
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Every rule, its order, and every refusal (404 `EXPENSE_NOT_FOUND` for a non-member
-- or a foreign expense, 403/P0003 `EXPENSE_NOT_OWN_DRAFT`, P0001 `EXPENSE_NOT_DRAFT`,
-- P0001 `EXPENSE_HAS_SPLITS`) are unchanged, character for character, from the body
-- `20261011120000_attachments.sql` last wrote. The only edits are the `DECLARE` of the
-- accumulator, the `RETURNING id` on the attachments delete, and the `RETURN`. No
-- table, column, index, policy, grant or row is touched, and migrations #1–38 are
-- immutable and untouched.
--
-- `DROP` + `CREATE` rather than `CREATE OR REPLACE`: PostgreSQL refuses a return-type
-- change in place ("cannot change return type of existing function"), and the
-- signature keeps the same identity `expense_draft_delete(uuid, uuid)` — the return
-- type is not part of a function's name — so the `COMMENT` and the three privilege
-- statements below address exactly the function they did before. Both statements run
-- in the migration runner's one transaction, so no session can observe the function
-- absent.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback
-- ─────────────────────────────────────────────────────────────────────────────
--
--   -- and restore `RETURNS void` from 20261011120000_attachments.sql section 7,
--   -- which is itself the replacement of 20261004120000_expense_draft_delete.sql.
--   DROP FUNCTION IF EXISTS public.expense_draft_delete(uuid, uuid);
--   -- then re-run the CREATE/COMMENT/REVOKE/GRANT block of that migration.
--
-- Lossless: this migration writes no row and reads none.

DROP FUNCTION IF EXISTS public.expense_draft_delete(uuid, uuid);

CREATE FUNCTION public.expense_draft_delete(
  p_expense_id uuid,
  p_society_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_created_by uuid;
  v_actor_member_id uuid;
  -- The ids of the attachment rows this call removed, as a JSON array. Starts as the
  -- empty array rather than NULL so a draft with no attachments answers `[]` — "there
  -- were none" is a fact the caller records, not an absence it has to guess at.
  v_removed_attachment_ids jsonb := '[]'::jsonb;
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

  -- T071 (ADR-0012 D6.5). Before the parent row, per the row-first/object-second
  -- philosophy: after this statement no attachment row references the draft, and
  -- any object still in the bucket is invisible to the application and sweepable.
  -- The whole society's expense prefix is not swept here — only the rows this
  -- draft owns, each of whose keys the API has already read for its own cleanup.
  --
  -- `RETURNING id` is the whole reason this migration exists (ADR-0014 D16): the
  -- statement that removes the rows is the only complete record of which rows they
  -- were, and the accumulator carries that answer out to the caller's audit entry.
  -- The child rows are removed by the cascade rather than by an `ON DELETE` action
  -- on a foreign key — the polymorphic `(entity_type, entity_id)` pair cannot carry
  -- one — so there is no other place the set is known.
  WITH removed AS (
    DELETE FROM public.attachments
     WHERE entity_type = 'expense'
       AND entity_id = p_expense_id
       AND society_id = p_society_id
    RETURNING id
  )
  SELECT coalesce(
           jsonb_agg(to_jsonb(removed.id) ORDER BY removed.id),
           '[]'::jsonb
         )
    INTO v_removed_attachment_ids
    FROM removed;

  DELETE FROM public.expenses
   WHERE id = p_expense_id
     AND society_id = p_society_id;

  IF NOT FOUND THEN
    -- The row was resolved and locked above, so this is unreachable; it is the
    -- same fail-closed guard the category delete keeps.
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  RETURN v_removed_attachment_ids;
END;
$$;

COMMENT ON FUNCTION public.expense_draft_delete(uuid, uuid) IS
  'Hard delete of one draft expense (T065, PRD §3.5). 404 for a non-member or an expense outside the society, 403/P0003 for a member who did not create it, P0001/EXPENSE_NOT_DRAFT for a non-draft, P0001/EXPENSE_HAS_SPLITS while splits exist. Since T071 it also removes the draft''s attachment rows in the same transaction (ADR-0012 D6.5); their objects are removed best-effort by the caller. Since T050 Stage E2 (ADR-0014 D16) it RETURNS the ids of the attachment rows it removed, as a jsonb array, so the caller''s single expense.deleted audit entry can name them.';

-- Restated rather than assumed, exactly as the T071 file restates them: a reader of
-- the function should not have to open two more migrations to learn who may call it.
-- `CREATE FUNCTION` above applies the bootstrap's default privileges, so this block is
-- an edit here rather than the no-op it was in `20261011120000`.
REVOKE ALL ON FUNCTION public.expense_draft_delete(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expense_draft_delete(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.expense_draft_delete(uuid, uuid) TO authenticated;
