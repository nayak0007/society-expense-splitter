-- 20261014120000_expense_comments.sql
--
-- Expense comments — the flat discussion stream on an expense (PRD §3.5.3
-- "Notes", Roadmap T072, decisions D1/D2/D8).
--
-- WHY THIS TABLE
--
-- The PRD puts the argument about a bill *in context*: "residents can ask 'why did
-- this cost ₹40,000?'". This table is that stream. It is deliberately **flat** —
-- no `parent_id`, no nesting (D1) — because the expense is the thread; a reply's
-- position depending on its parent's is the one structure that makes an
-- append-only stream hard to order.
--
-- ORDERING IS THE DATABASE'S (D1)
--
-- `sequence` is a monotonic identity, assigned by Postgres. The application never
-- computes `MAX(sequence) + 1`: two members commenting at once would read the same
-- maximum and produce the same position, and the requirement is explicit that
-- concurrent inserts must all survive with a deterministic order. The unique
-- constraint makes a duplicate position unrepresentable rather than merely
-- unlikely.
--
-- SOFT DELETE ONLY (D1/D8)
--
-- There is no application or API path that issues SQL `DELETE`. A deletion stamps
-- `deleted_at`/`deleted_by`; the row keeps its position. `DELETE` is not granted
-- to any client role, and the only writer is `expense_comment_soft_delete()`,
-- which is SECURITY DEFINER for the one reason `expense_draft_delete()` is: it has
-- to force `deleted_by` to the caller's own membership, which a column-scoped
-- `UPDATE` grant cannot express (see the note on privileges below).
--
-- WHY THE AUTHOR KEY IS SINGLE-COLUMN, NOT COMPOSITE
--
-- `20261013120000_attachments_uploader_fk.sql` records the lesson: a composite
-- `(author_id, society_id)` key would depend on `uq_members_id_society` and block
-- `20261001120000_expense_schema.sql`'s documented Down block with `2BP01`. The
-- same-society guarantee is therefore the insert policy's, and it is stronger
-- there: the author must be *the caller's own active membership of this row's own
-- society*, not merely some member of the same society.
--
-- Down (run by hand — `supabase db push` is forward-only):
--   DROP FUNCTION IF EXISTS public.expense_comment_soft_delete(uuid, uuid, uuid);
--   DROP TABLE IF EXISTS public.expense_comments;

-- ─────────────────────────────────────────────────────────────────────────────
-- The table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.expense_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES public.societies (id) ON DELETE CASCADE,
  expense_id uuid NOT NULL,
  author_id uuid NOT NULL,
  body text NOT NULL,
  -- The per-stream position: monotonic, database-assigned, never client-supplied.
  sequence bigint GENERATED ALWAYS AS IDENTITY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,

  -- The expense is the row's parent, and the composite key keeps the comment in
  -- its expense's society (the shape `expense_gst_details` already uses).
  CONSTRAINT fk_expense_comments_expense FOREIGN KEY (expense_id, society_id)
    REFERENCES public.expenses (id, society_id) ON DELETE CASCADE,
  -- The author is a member; the society guarantee is the insert policy's (see the
  -- header). ON DELETE CASCADE because the row is a child of the membership.
  CONSTRAINT fk_expense_comments_author FOREIGN KEY (author_id)
    REFERENCES public.members (id) ON DELETE CASCADE,
  -- Who deleted the comment, when it was soft-deleted. SET NULL on member removal
  -- so a deleted comment can never block a membership removal.
  CONSTRAINT fk_expense_comments_deleted_by FOREIGN KEY (deleted_by)
    REFERENCES public.members (id) ON DELETE SET NULL,
  -- A blank or whitespace-only comment is not a comment (D1: "body rejects
  -- empty/blank").
  CONSTRAINT chk_expense_comments_body_not_blank CHECK (btrim(body) <> ''),
  -- The tombstone is all-or-nothing: half a deletion is a corrupt row.
  CONSTRAINT chk_expense_comments_deleted_pair CHECK (
    (deleted_at IS NULL AND deleted_by IS NULL)
    OR (deleted_at IS NOT NULL AND deleted_by IS NOT NULL)
  ),
  -- No two comments in one stream can share a position. This is what makes the
  -- order deterministic under concurrent inserts.
  CONSTRAINT uq_expense_comments_order UNIQUE (expense_id, sequence)
);

COMMENT ON TABLE public.expense_comments IS
  'Flat, append-only discussion stream on an expense (PRD §3.5.3, T072). Ordered by a database-assigned sequence; soft-deleted by author or Admin, never hard-deleted.';
COMMENT ON COLUMN public.expense_comments.sequence IS
  'Monotonic, database-assigned position within the expense''s stream; unique per expense (uq_expense_comments_order). Never set by a client.';
COMMENT ON COLUMN public.expense_comments.deleted_at IS
  'Soft-delete tombstone. A deleted comment keeps its row and position; its body is no longer returned to clients.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Row level security
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.expense_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_comments FORCE ROW LEVEL SECURITY;

-- Read: the same cell that sees the expense (expense.view). A Guest sees nothing
-- and therefore cannot comment either.
DROP POLICY IF EXISTS expense_comments_select_member ON public.expense_comments;
CREATE POLICY expense_comments_select_member
  ON public.expense_comments
  FOR SELECT
  TO authenticated
  USING (public.can_view_expenses(society_id));

-- Write (append): an active member who can see expenses, and the author is that
-- member's own membership row of this row's own society. This restates the
-- composite key the author FK deliberately does not carry.
DROP POLICY IF EXISTS expense_comments_insert_author ON public.expense_comments;
CREATE POLICY expense_comments_insert_author
  ON public.expense_comments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.can_view_expenses(society_id)
    AND EXISTS (
      SELECT 1
        FROM public.members m
       WHERE m.id = author_id
         AND m.society_id = society_id
         AND m.user_id = (SELECT auth.uid())
         AND m.status = 'active'
    )
  );

-- No UPDATE policy and no DELETE policy: the only mutation is the tombstone, and
-- it goes through `expense_comment_soft_delete()` below. `updated_at` is written
-- there too.

-- ─────────────────────────────────────────────────────────────────────────────
-- The soft-delete definer function (D8)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.expense_comment_soft_delete(
  p_comment_id uuid,
  p_expense_id uuid,
  p_society_id uuid
)
RETURNS SETOF public.expense_comments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.expense_comments;
  v_actor_member_id uuid;
BEGIN
  PERFORM public.assert_society_membership(p_society_id);

  -- Lock the row, scoped by both the comment's own id and its parent, so a
  -- comment id from another expense or another tenant is not addressable.
  SELECT c.*
    INTO v_row
    FROM public.expense_comments c
   WHERE c.id = p_comment_id
     AND c.expense_id = p_expense_id
     AND c.society_id = p_society_id
     FOR UPDATE;

  IF NOT FOUND THEN
    -- The caller is an active member of this society, so a row that is not here is
    -- one they may not know (PRD T041): not in their society, or never existed.
    RAISE EXCEPTION 'EXPENSE_COMMENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT m.id
    INTO v_actor_member_id
    FROM public.members m
   WHERE m.society_id = p_society_id
     AND m.user_id = (SELECT auth.uid())
     AND m.status = 'active'
   LIMIT 1;

  IF v_actor_member_id IS NULL THEN
    RAISE EXCEPTION 'EXPENSE_COMMENT_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  -- D2: the author may delete their own comment; otherwise the caller must hold
  -- the Admin-only `expense.approve` capability. `is_society_admin()` is exactly
  -- that cell (Admin-only), and it is read here rather than an inline role string
  -- so the population has one definition.
  IF v_row.author_id IS DISTINCT FROM v_actor_member_id
     AND NOT public.is_society_admin(p_society_id) THEN
    RAISE EXCEPTION 'EXPENSE_COMMENT_DELETE_FORBIDDEN'
      USING ERRCODE = 'P0003',
            HINT = 'Only the comment''s author or a society Admin can delete it.';
  END IF;

  -- Idempotent and deterministic: a second delete of an already-tombstoned row
  -- returns it unchanged rather than moving the timestamp or forging metadata.
  IF v_row.deleted_at IS NOT NULL THEN
    RETURN NEXT v_row;
    RETURN;
  END IF;

  UPDATE public.expense_comments
     SET deleted_at = now(),
         deleted_by = v_actor_member_id,
         updated_at = now()
   WHERE id = p_comment_id
     AND society_id = p_society_id
  RETURNING * INTO v_row;

  RETURN NEXT v_row;
END;
$$;

COMMENT ON FUNCTION public.expense_comment_soft_delete(uuid, uuid, uuid) IS
  'Soft-deletes one expense comment (T072, D2/D8): author or Active Admin only, idempotent, and the only path that writes the tombstone. 404/P0002 for a non-member or a comment outside the expense; 403/P0003 for a member who is neither the author nor an Admin.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Privileges
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE ALL ON public.expense_comments FROM anon;
REVOKE ALL ON public.expense_comments FROM authenticated;

GRANT SELECT ON public.expense_comments TO authenticated;
-- Only the fields a client may supply. `id`, `sequence`, `created_at`,
-- `updated_at`, `deleted_at` and `deleted_by` are absent: a client that can set
-- `sequence` can reorder the stream, and one that can set the tombstone can forge
-- a deletion. Appending is the only direct write a client role has.
GRANT INSERT (society_id, expense_id, author_id, body)
  ON public.expense_comments TO authenticated;
-- No UPDATE and no DELETE: the tombstone is the definer function's.

REVOKE ALL ON FUNCTION public.expense_comment_soft_delete(uuid, uuid, uuid)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expense_comment_soft_delete(uuid, uuid, uuid)
  FROM anon;
GRANT EXECUTE ON FUNCTION public.expense_comment_soft_delete(uuid, uuid, uuid)
  TO authenticated;
