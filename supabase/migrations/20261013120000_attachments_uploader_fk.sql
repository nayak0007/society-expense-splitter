-- 20261013120000_attachments_uploader_fk.sql
--
-- Attachments — the uploader's foreign key becomes a single-column reference, and
-- the same-society guarantee moves into the policy, where it is stronger (Roadmap
-- T071, ADR-0012 D5/D6.4).
--
-- WHY THE COMPOSITE KEY IS REPLACED
--
-- #33 declared `fk_attachments_uploaded_by (uploaded_by, society_id) REFERENCES
-- public.members (id, society_id)`, the shape `expenses.created_by` uses. That key
-- is what makes a cross-society uploader unrepresentable — and it also makes a
-- documented rollback unexecutable, which the real-PostgreSQL suite caught:
-- `20261001120000_expense_schema.sql`'s Down block ends with
-- `ALTER TABLE public.members DROP CONSTRAINT IF EXISTS uq_members_id_society`,
-- and Postgres refuses it with `2BP01` while another table's foreign key still
-- depends on the anchor. `expense-schema.integration-spec.ts` replays that block
-- against a database at HEAD, which is where the refusal surfaced.
--
-- The repository has already decided this once, in
-- `20261006120000_member_balances.sql`: its foreign keys are deliberately
-- single-column rather than composite *for exactly this reason*, and its comment
-- records that a composite key "would make `ALTER TABLE public.members DROP
-- CONSTRAINT` fail with a dependent object". #33 broke that rule; this migration
-- restores it rather than weakening the rehearsal, because a rehearsal that only
-- passes after the dependent object is dropped by a test would leave the shared
-- container diverged from HEAD for every suite that ran afterwards — the trap
-- T070 already paid for once.
--
-- WHAT IS NOT WEAKENED
--
-- The guarantee the composite key carried is that an attachment's uploader belongs
-- to the row's own society. It is replaced by a predicate that is *strictly
-- stronger*, in the one place where the fact is actually decided — the insert
-- policy: `uploaded_by` must be the **caller's own active membership row of the
-- row's own society**, not merely "some member of the same society". A
-- claim-the-society loses its post; a claim-anyone-in-it never had one.
--
-- Everything else is unchanged. The single-column reference still makes an uploader
-- who is not a member at all unrepresentable, `uploaded_by` is still outside every
-- UPDATE grant, and `can_delete_attachment`'s uploader arm still re-derives the
-- caller from `auth.uid()` and the member row rather than trusting the column.
--
-- Lock order and write path: unchanged. The API passes `membership.id` from the
-- caller's own resolved membership, so no legitimate write can fail this predicate.
--
-- Lossless: this migration writes no row and reads none. The old constraint is
-- dropped and immediately replaced, so `attachments` is never left without a
-- foreign key on `uploaded_by`.
--
-- Down (run by hand — `supabase db push` is forward-only; it would also require
-- deleting every attachment row whose uploader is not a member of its own society,
-- because the composite key makes such a row unrepresentable):
--   ALTER TABLE public.attachments DROP CONSTRAINT IF EXISTS fk_attachments_uploaded_by;
--   ALTER TABLE public.attachments
--     ADD CONSTRAINT fk_attachments_uploaded_by FOREIGN KEY (uploaded_by, society_id)
--     REFERENCES public.members (id, society_id);
--   (and restore #33's `attachments_insert_author` from that file)

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · The foreign key, single-column
-- ─────────────────────────────────────────────────────────────────────────────

-- `ON DELETE CASCADE` matches `member_balances.member_id`'s: this row is a child of
-- the membership that created it and has no meaning without it. It does not make a
-- membership deletable — nothing in the product hard-deletes one (`status` moves to
-- `removed`), and the row is guarded by `uq_members_id_society`, the last-admin and
-- role-cap checks.
ALTER TABLE public.attachments
  DROP CONSTRAINT IF EXISTS fk_attachments_uploaded_by;

ALTER TABLE public.attachments
  ADD CONSTRAINT fk_attachments_uploaded_by
  FOREIGN KEY (uploaded_by) REFERENCES public.members (id) ON DELETE CASCADE;

COMMENT ON CONSTRAINT fk_attachments_uploaded_by ON public.attachments IS
  'The uploader is a member. Deliberately single-column rather than the (id, society_id) composite key: the composite key would depend on uq_members_id_society and block 20261001120000_expense_schema.sql''s documented Down block (2BP01). The same-society guarantee is the insert policy''s, and is stronger there — the uploader must be the caller''s own active membership of the row''s own society.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · The insert policy, carrying the guarantee the key used to carry
-- ─────────────────────────────────────────────────────────────────────────────

-- Recreated rather than altered (policies have no ALTER form). Every predicate from
-- #33 is preserved verbatim; the last one is the replacement.
--
-- Why the membership row is read as `status = 'active'`: an invitation that has not
-- been accepted has no member row yet, and a removed member must not be able to
-- attribute a new upload to themselves. `can_draft_expenses` already requires an
-- active membership, so this adds no reachable refusal — it makes the *attribution*
-- subject to the same rule as the capability, which is what keeps the two from
-- drifting.
DROP POLICY IF EXISTS attachments_insert_author ON public.attachments;
CREATE POLICY attachments_insert_author
  ON public.attachments
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.can_draft_expenses(society_id)
    AND scan_status = 'pending'
    AND completed_at IS NULL
    AND storage_key LIKE (
      'societies/' || society_id::text || '/expenses/' || entity_id::text || '/%'
    )
    AND public.attachment_expense_is_attachable(entity_id, society_id)
    -- The composite key's job, done where it can be done exactly: the uploader is
    -- the caller, and the caller is an active member of this row's society.
    AND EXISTS (
      SELECT 1
        FROM public.members m
       WHERE m.id = uploaded_by
         AND m.society_id = society_id
         AND m.user_id = (SELECT auth.uid())
         AND m.status = 'active'
    )
  );

COMMENT ON POLICY attachments_insert_author ON public.attachments IS
  'ADR-0012 D5/D6.1: an active member who can draft expenses, attaching to an expandable expense of their own society, under a key confined to that row''s society and entity — and naming themselves as the uploader. Server-written facts (`scan_status`, `completed_at`) are asserted rather than trusted.';
