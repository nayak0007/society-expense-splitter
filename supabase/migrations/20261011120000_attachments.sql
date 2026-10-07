-- ─────────────────────────────────────────────────────────────────────────────
-- 20261011120000_attachments.sql — T071, migration #33
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT THIS FILE DOES (ADR-0012, accepted 2026-10-07).
--
--   1. **`public.attachments`** — one verified reference to one object in the
--      object store. It merges the three sources the audit found disagreeing:
--      PRD §7.4's columns, SAD §8.5's indexes and `CHECK (size_bytes <=
--      10485760)`, and SAD §10.7's `scan_status`.
--   2. **The quota lock edge** — `public.attachment_presign_lock(uuid)`, a
--      `SECURITY DEFINER` function that takes the *society* row `FOR UPDATE`.
--      ADR-0012 D2 fixes the lock order `societies → attachments`; this is the
--      first and only place that edge is created, and it exists because
--      `authenticated` holds only column-level `UPDATE` on `societies` and
--      therefore cannot take the lock itself.
--   3. **RLS** — `ENABLE` + `FORCE`, one policy per operation, plus two
--      `SECURITY DEFINER` helpers so a policy can read `expenses` without
--      depending on the caller's own visibility of that table.
--   4. **Least-privilege grants** — the bootstrap's `ALTER DEFAULT PRIVILEGES`
--      hands `authenticated` `SELECT, INSERT, UPDATE, DELETE` on every new table,
--      so this file revokes all of it and grants back exactly: `SELECT`, a
--      column-scoped `INSERT`, `UPDATE (completed_at, updated_at)`, and `DELETE`.
--      An attachment's `storage_key`, `checksum`, `size_bytes`, `scan_status` and
--      tenancy are therefore **not writable through any client grant at all** —
--      the forgery cases the audit listed are closed by privilege rather than by
--      a rule somebody has to remember to apply.
--
-- WHY ONE MIGRATION. The table, its policies and its grants are one decision: a
-- window in which the table exists with the bootstrap's default grants and no
-- policy is a window in which any authenticated caller may write any column of
-- any society's attachment row. SQL is transactional, so they land together.
--
-- NOT changed, deliberately: no existing table, function, policy, grant or row is
-- touched, and migrations #1–32 are immutable and untouched. In particular this
-- file adds **no** column to `expenses` — attachments are not versioned content
-- (ADR-0012, "cross-cutting properties"), so there is no `has_attachments` flag
-- and no approval interaction: T070's `trg_expenses_approval_guard` reads a fixed
-- column list that does not include anything here, so an attachment cannot clear
-- `approved_by`/`approved_at`. That is why the T070 invariant is proven by a test
-- rather than by a line of SQL.
--
-- POLYMORPHIC INTEGRITY. `(entity_type, entity_id)` cannot carry a real foreign
-- key, so a row's parent expense is application-enforced (ADR-0012 Consequences).
-- What the database *can* enforce, it does: the storage key must be prefixed with
-- the row's own society and entity, the parent expense must exist in that society
-- and must not be `void`, and — section 7 below — the authoritative draft-deletion
-- path removes a draft's attachment rows in the same transaction that removes the
-- draft, so no attachment row can outlive its parent.
--
-- Section 7 is in this file rather than a second one because the user's brief for
-- T071 is one forward-only migration, and because the two halves are one decision:
-- a table whose rows a deleted parent could strand is not the table this file is
-- describing. The `CREATE OR REPLACE` keeps `expense_draft_delete`'s `RETURNS void`
-- signature, which is why it may be replaced in place at all (PostgreSQL refuses a
-- return-type change there).
--
-- Down (run by hand — the runner is forward-only, same convention as the other
-- thirty-two files):
--   -- and restore the previous body of public.expense_draft_delete(uuid, uuid)
--   -- from 20261004120000_expense_draft_delete.sql (replaced, not merely extended,
--   -- in section 7 below).
--   DROP POLICY IF EXISTS attachments_select_member ON public.attachments;
--   DROP POLICY IF EXISTS attachments_insert_author ON public.attachments;
--   DROP POLICY IF EXISTS attachments_update_owner ON public.attachments;
--   DROP POLICY IF EXISTS attachments_delete_owner ON public.attachments;
--   DROP TRIGGER IF EXISTS trg_attachments_touch ON public.attachments;
--   DROP FUNCTION IF EXISTS public.can_delete_attachment(uuid, uuid, uuid);
--   DROP FUNCTION IF EXISTS public.attachment_expense_is_attachable(uuid, uuid);
--   DROP FUNCTION IF EXISTS public.attachment_presign_lock(uuid);
--   DROP TABLE IF EXISTS public.attachments;
-- Lossless: this migration writes no row and reads none.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · The table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES public.societies (id) ON DELETE CASCADE,

  -- The polymorphic parent. `expense` is T071's only live value (Roadmap: "for
  -- expense attachments"), and the CHECK says so out loud rather than leaving a
  -- free-text column that a later task widens without a review. Adding
  -- `complaint`, `notice`, `payment` or `meter` is an `ALTER … DROP CONSTRAINT` +
  -- `ADD CONSTRAINT` in that task's own migration — a visible, reviewable change,
  -- which is the point.
  entity_type varchar(32) NOT NULL,
  entity_id uuid NOT NULL,

  -- The object's address in the bucket, minted by the API and never by a client:
  -- SAD §10.3's `societies/{societyId}/{entityType}/{entityId}/{attachmentId}.{ext}`,
  -- with `entity_type` spelled `expenses` in the path for the same reason the
  -- route is `/v1/expenses/…`.
  storage_key varchar(512) NOT NULL,

  -- PRD §7.4's `file_name`, renamed because the name a device reports is not the
  -- name anything is stored under and conflating the two is how a path traversal
  -- arrives. Metadata only: the extension is never authoritative (ADR-0012 D1's
  -- layer 3 is a magic-byte check on the stored bytes).
  original_filename varchar(200) NOT NULL,
  -- The declared type. Metadata only, for the same reason.
  mime_type varchar(80) NOT NULL,
  size_bytes integer NOT NULL,
  -- Nullable, and unpopulated in T071: PRD §7.4 carries them for the image
  -- pipeline T073/T132 will fill. Present so the later task is a write, not a
  -- migration of a live table.
  width integer,
  height integer,
  -- SHA-256 of the stored bytes, lowercase hex — verified at completion against
  -- the object itself, never against the upload request (ADR-0012 D1 layer 3).
  checksum varchar(64) NOT NULL,

  -- PRD §7.4's `uploaded_by`, composite-keyed to the society below.
  uploaded_by uuid NOT NULL,

  -- SAD §10.7's lifecycle. `pending` is the only value any writer may produce in
  -- T071, and the gate that reads it is inert until a scanner is configured
  -- (ADR-0012 D3) — the column ships now so arming the gate is configuration plus
  -- a scanner job, not a migration and a reshaped serving path.
  scan_status varchar(16) NOT NULL DEFAULT 'pending',

  -- Null while the upload is still an outstanding reservation, stamped once
  -- completion has verified the stored object. This is the column the quota read
  -- turns on (ADR-0012 D2), and it is the *only* column `authenticated` may
  -- update.
  completed_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- No `version`: ADR-0012 records that attachments are not versioned content and
  -- cannot be raced into a stale write, so there is no `expectedVersion` and a
  -- column no rule reads would be an invitation to invent one.

  -- ── the rules ──────────────────────────────────────────────────────────────
  CONSTRAINT chk_attachments_entity_type CHECK (entity_type IN ('expense')),

  -- SAD §8.5's ceiling, verbatim, as the database's half of the per-type cap.
  -- The API enforces the per-type map (ADR-0012 D1 layer 2/3); this is the global
  -- backstop that holds even if an endpoint is added carelessly.
  CONSTRAINT chk_attachments_size_positive CHECK (size_bytes > 0),
  CONSTRAINT chk_attachments_size_max CHECK (size_bytes <= 10485760),

  -- SHA-256, lowercase hex, exactly 64 characters. A shape check and not a
  -- content check: the database cannot re-hash an object it does not hold, but it
  -- can refuse a row that claims a digest no digest could be.
  CONSTRAINT chk_attachments_checksum_sha256
    CHECK (checksum ~ '^[0-9a-f]{64}$'),

  -- The key's shape, in the table rather than only in a policy: server-minted
  -- prefix, no traversal segment, and a length the column can hold.
  CONSTRAINT chk_attachments_storage_key_shape CHECK (
    storage_key LIKE 'societies/%'
    AND position('..' in storage_key) = 0
    AND length(storage_key) <= 512
  ),
  CONSTRAINT uq_attachments_storage_key UNIQUE (storage_key),

  CONSTRAINT chk_attachments_scan_status
    CHECK (scan_status IN ('pending', 'clean', 'infected', 'failed')),

  -- A quarantined or failed row is one the completion path judged, so it can
  -- never be a row that was never completed.
  CONSTRAINT chk_attachments_scan_implies_completed CHECK (
    scan_status IN ('pending', 'clean') OR completed_at IS NOT NULL
  ),

  -- The composite tenancy key, the shape `expenses.created_by` and
  -- `expenses.approved_by` use: an attachment can never name an uploader from
  -- another society.
  CONSTRAINT fk_attachments_uploaded_by FOREIGN KEY (uploaded_by, society_id)
    REFERENCES public.members (id, society_id)
);

COMMENT ON TABLE public.attachments IS
  'One verified reference to one object in the object store (T071, ADR-0012). Bytes never pass through the API: the row is created before the presigned PUT is issued and is stamped complete only after the stored object''s size, type and SHA-256 have been checked. Integrity of the polymorphic (entity_type, entity_id) pair is application-enforced — the storage key''s prefix and the parent expense''s existence are the database''s half.';
COMMENT ON COLUMN public.attachments.entity_type IS
  'The parent kind. ''expense'' is the only value T071 permits; a later multi-entity task widens this CHECK in its own migration.';
COMMENT ON COLUMN public.attachments.entity_id IS
  'The parent expense id. No foreign key: the column is polymorphic, so the reference is application-enforced (ADR-0012).';
COMMENT ON COLUMN public.attachments.storage_key IS
  'Server-minted SAD §10.3 key. Never client-supplied. Not writable through any client grant, and constrained to the row''s own society and entity by the insert policy.';
COMMENT ON COLUMN public.attachments.original_filename IS
  'The name the uploader''s device reported. Display metadata only — never a storage path, and never an authority on the file''s type.';
COMMENT ON COLUMN public.attachments.mime_type IS
  'The declared content type. Metadata only: completion verifies the stored bytes'' magic number against it (ADR-0012).';
COMMENT ON COLUMN public.attachments.checksum IS
  'SHA-256 of the stored bytes, lowercase hex. Computed by the API from the object itself at completion, never taken from the upload request.';
COMMENT ON COLUMN public.attachments.scan_status IS
  'pending → clean | infected | failed (SAD §10.7). T071 ships it with the serving gate inert because no scanner exists (ADR-0012 D3); no writer for ''clean'' ships either, so the gate must not be armed yet.';
COMMENT ON COLUMN public.attachments.completed_at IS
  'When completion verified the stored object. NULL means the row is an outstanding presign reservation and still counts against the society''s plan quota (ADR-0012 D2).';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · Indexes — only the three queries that exist
-- ─────────────────────────────────────────────────────────────────────────────

-- The expense-detail read (T073) and the draft-deletion sweep: every attachment
-- of one parent.
CREATE INDEX IF NOT EXISTS idx_attachments_entity
  ON public.attachments (entity_type, entity_id);

-- The quota read (ADR-0012 D2) and every society-scoped listing.
CREATE INDEX IF NOT EXISTS idx_attachments_society
  ON public.attachments (society_id);

-- The outstanding-reservation half of the quota read alone. Partial because the
-- predicate is fixed in one place: completed rows are excluded from it entirely,
-- so the index stays proportional to in-flight uploads rather than to history.
CREATE INDEX IF NOT EXISTS idx_attachments_society_outstanding
  ON public.attachments (society_id)
  WHERE completed_at IS NULL;

-- No index on `storage_key`: the UNIQUE constraint already creates one, and a
-- second would be a duplicate the planner has to choose between.

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · Timestamps
-- ─────────────────────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_attachments_touch ON public.attachments;
CREATE TRIGGER trg_attachments_touch
  BEFORE UPDATE ON public.attachments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4 · Helpers the policies and the quota path read
-- ─────────────────────────────────────────────────────────────────────────────

-- The parent expense's half of the insert rule. `SECURITY DEFINER` on purpose: a
-- policy that read `expenses` directly would be evaluated with the caller's own
-- visibility of that table, so "the parent expense is attachable" would depend on
-- a *different* policy's answer and a change to expenses' read policy could
-- silently widen attachment writes. Reading it here makes one question have one
-- answer.
--
-- `void` is excluded (ADR-0012 D6.1): a voided expense is immutable historical
-- financial evidence and may not acquire new attachments. `draft`,
-- `pending_approval` and `published` are all permitted, which is exactly D6.1's
-- list. There is no state in the enum that is attachable but not listed, so the
-- predicate is total.
CREATE OR REPLACE FUNCTION public.attachment_expense_is_attachable(
  p_expense_id uuid,
  p_society_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.expenses e
     WHERE e.id = p_expense_id
       AND e.society_id = p_society_id
       AND e.status IN ('draft', 'pending_approval', 'published')
  );
$$;

COMMENT ON FUNCTION public.attachment_expense_is_attachable(uuid, uuid) IS
  'True when the parent expense exists in this society and is not void (ADR-0012 D6.1: attachments may be added while draft, pending_approval or published, never while void).';

-- ADR-0012 D6.4: delete is permitted to the uploader **or** to a caller
-- authorized to manage the expense. The API decides this with `canOnResource`
-- against the persisted row (D5) and answers 404/403 accordingly; this is the
-- database's independent half, so a direct PostgREST delete cannot reach another
-- member's attachment.
--
-- The three branches are the matrix's own cells, not a new family: the uploader
-- (their own row), an Admin/Treasurer (`expense.void`'s full cell, via
-- `can_publish_expenses`), and a Committee Member on *their own unpublished*
-- expense (`expense.void`'s 🟡 cell) — the third branch reads the parent's
-- `created_by` and status, which is the same narrowing the application makes.
CREATE OR REPLACE FUNCTION public.can_delete_attachment(
  p_society_id uuid,
  p_uploaded_by uuid,
  p_entity_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    public.can_publish_expenses(p_society_id)
    OR EXISTS (
      SELECT 1
        FROM public.members m
       WHERE m.society_id = p_society_id
         AND m.id = p_uploaded_by
         AND m.user_id = (SELECT auth.uid())
         AND m.status = 'active'
    )
    OR (
      public.can_draft_expenses(p_society_id)
      AND EXISTS (
        SELECT 1
          FROM public.expenses e
          JOIN public.members m
            ON m.id = e.created_by
           AND m.society_id = e.society_id
         WHERE e.id = p_entity_id
           AND e.society_id = p_society_id
           AND e.status IN ('draft', 'pending_approval')
           AND m.user_id = (SELECT auth.uid())
      )
    );
$$;

COMMENT ON FUNCTION public.can_delete_attachment(uuid, uuid, uuid) IS
  'ADR-0012 D6.4: the uploader, an Admin/Treasurer, or a Committee Member on their own unpublished expense. The API''s canOnResource decision is the primary gate; this is the database''s.';

-- The quota lock (ADR-0012 D2). `authenticated` holds only column-level UPDATE on
-- `societies`, so `SELECT … FOR UPDATE` is not available to the API — and it must
-- not be widened to give it, because a table-level grant would also let a caller
-- write `societies` columns the product deliberately withholds (the derived ones
-- live behind `society_update()`). A definer function that takes exactly one row
-- lock is the narrow instrument.
--
-- Why any lock at all: two presigns that each read the society's used bytes
-- before either writes can both observe the same headroom and both reserve it, so
-- the plan cap holds only in the absence of concurrency. Serializing on the
-- society row makes the read-then-insert atomic per society without Redis state
-- (ADR-0012 D2's rejection of a cache) and without a table-wide lock.
--
-- Why it cannot deadlock: `societies` is the first and only lock the attachment
-- transaction takes, and nothing else in the schema locks `attachment` rows, so
-- no cycle exists. Verified against the money ordering — no migration takes
-- `societies … FOR UPDATE`, so the attachment path cannot be the second half of a
-- cycle with `expense → dues → member_balances`.
CREATE OR REPLACE FUNCTION public.attachment_presign_lock(p_society_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  -- Membership first: a stranger must not be able to take a lock on a society
  -- they cannot see, and 404-before-403 is the established rule (PRD T041).
  PERFORM public.assert_society_membership(p_society_id);

  SELECT s.id
    INTO v_id
    FROM public.societies s
   WHERE s.id = p_society_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'SOCIETY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.attachment_presign_lock(uuid) IS
  'Takes the society row FOR UPDATE so a presign''s read-then-insert quota check is atomic (ADR-0012 D2, lock order societies → attachments). 404 for a non-member.';

REVOKE ALL ON FUNCTION public.attachment_expense_is_attachable(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.can_delete_attachment(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.attachment_presign_lock(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.attachment_expense_is_attachable(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_delete_attachment(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.attachment_presign_lock(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5 · RLS (SAD §8.7: "applied to every tenant table without exception")
-- ─────────────────────────────────────────────────────────────────────────────

-- FORCE, not just ENABLE: without it the table owner bypasses its own policies,
-- which is the commonest way an RLS setup fails open.
ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attachments FORCE ROW LEVEL SECURITY;

-- Read: every member who may see the society's expenses — the audience T073's
-- expense detail and T132's OCR both read as, and the audience PRD §2.2's
-- transparency principle gives a Resident. The `scan_status` gate (SAD §10.7)
-- deliberately does not appear here: it gates *serving bytes*, which is a
-- `presignDownload` decision, not row visibility. Gating the row would hide the
-- fact that a bill was uploaded at all.
DROP POLICY IF EXISTS attachments_select_member ON public.attachments;
CREATE POLICY attachments_select_member
  ON public.attachments
  FOR SELECT
  TO authenticated
  USING (public.can_view_expenses(society_id));

-- Insert: the same population that may draft an expense (Admin, Treasurer,
-- Committee — the `expense.create` cell), plus four column-level refusals that
-- make the forgery list from the audit unrepresentable:
--
--   * the key must be prefixed with *this row's* society and entity, so a caller
--     cannot point a row at another tenant's prefix;
--   * `scan_status` must be `pending`, so nobody can declare their own upload
--     clean — the one value the future serving gate trusts;
--   * `completed_at` must be null, so a row cannot claim to be verified before
--     any bytes exist;
--   * the parent expense must exist in this society and not be void.
--
-- `uploaded_by` is not constrained to the caller by a policy because a policy
-- cannot read the caller's membership id; it is a composite FK to `members`, and
-- the API always writes the caller's own membership.
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
  );

-- Update: the completion stamp, and nothing else. The column grant below already
-- limits a client to `completed_at`/`updated_at`; this policy adds *who* and
-- *which row*, and re-asserts `scan_status = 'pending'` so that a caller who
-- somehow held a wider grant still could not flip a row to `clean`.
--
-- `USING` reads the stored row, `WITH CHECK` the new one: the parent must be
-- attachable in both, which refuses completing an upload against an expense that
-- was voided while the upload was in flight (ADR-0012 D6.1).
DROP POLICY IF EXISTS attachments_update_owner ON public.attachments;
CREATE POLICY attachments_update_owner
  ON public.attachments
  FOR UPDATE
  TO authenticated
  USING (
    public.can_draft_expenses(society_id)
    AND scan_status = 'pending'
    AND public.attachment_expense_is_attachable(entity_id, society_id)
  )
  WITH CHECK (
    public.can_draft_expenses(society_id)
    AND scan_status = 'pending'
    AND public.attachment_expense_is_attachable(entity_id, society_id)
  );

-- Delete: ADR-0012 D6.4's three branches, in `can_delete_attachment`.
DROP POLICY IF EXISTS attachments_delete_owner ON public.attachments;
CREATE POLICY attachments_delete_owner
  ON public.attachments
  FOR DELETE
  TO authenticated
  USING (public.can_delete_attachment(society_id, uploaded_by, entity_id));

-- ─────────────────────────────────────────────────────────────────────────────
-- 6 · Privileges — the other half of every policy above
-- ─────────────────────────────────────────────────────────────────────────────

-- The bootstrap's `ALTER DEFAULT PRIVILEGES` granted
-- `SELECT, INSERT, UPDATE, DELETE` to `authenticated` on this table the moment it
-- was created (and `ALL` to `service_role`, which is not a user-facing path).
-- These REVOKEs are what turn the policies into the only path, and what make the
-- columns below the *only* writable ones.
REVOKE ALL ON public.attachments FROM anon;
REVOKE ALL ON public.attachments FROM authenticated;

GRANT SELECT ON public.attachments TO authenticated;

-- Insertable: the row's facts as the API mints them.
--
-- Not insertable: `id` (the server mints it — a client-supplied primary key is
-- the "client-generated attachment IDs used as authority" case the audit forbids),
-- `scan_status` and `completed_at` (server state, and both are re-asserted by the
-- insert policy), `created_at`/`updated_at` (the trigger's), and — deliberately —
-- `width`/`height`, which carry no value until the image pipeline exists and
-- which a client could otherwise use to make a bill render at a size it is not.
GRANT INSERT (
  society_id, entity_type, entity_id, storage_key, original_filename,
  mime_type, size_bytes, checksum, uploaded_by
) ON public.attachments TO authenticated;

-- Updatable: the completion stamp. That is the whole list.
--
-- Not updatable, and this is the strongest statement in the file: `checksum`,
-- `size_bytes`, `mime_type`, `storage_key`, `entity_type`, `entity_id`,
-- `society_id`, `uploaded_by` and `scan_status` cannot be rewritten by any
-- authenticated caller, because no grant admits the column. "A client cannot
-- rewrite a verified checksum" is therefore a privilege, not a rule.
GRANT UPDATE (completed_at, updated_at) ON public.attachments TO authenticated;

-- Delete is granted because the delete use case removes the row before the object
-- (ADR-0012 D6.3) and the draft-deletion path removes a draft's rows with it.
-- What a caller may delete is the policy's answer, not the grant's.
GRANT DELETE ON public.attachments TO authenticated;

-- No grant to `anon` at all, and no public object access anywhere: an attachment
-- is served only through a time-limited URL (PRD §11.4).

-- ─────────────────────────────────────────────────────────────────────────────
-- 7 · Draft hard deletion removes its attachments (ADR-0012 D6.5)
-- ─────────────────────────────────────────────────────────────────────────────

-- The polymorphic pair cannot carry an FK, so nothing at the table level stops an
-- attachment row from outliving the draft it points at — `entity_id` would simply
-- name an expense that is gone. ADR-0012 D6.5 makes the authoritative draft path
-- responsible for the cleanup, and this is that path: one extra `DELETE` inside
-- the transaction that already locks the draft row, holds the creator-only and
-- draft-only checks, and refuses while splits exist.
--
-- Why the *existing* function rather than a new one the API calls first: the
-- ordering matters and there is exactly one order that is safe. Deleting the rows
-- first, in the same transaction and after the same lock, means a draft can never
-- be observable in a state where it is gone and its attachment rows are not.
-- Doing it from the API as a second statement would leave a window in which a
-- concurrent reader sees a deleted draft with live child rows — and, worse, the
-- window would be *outside* the row lock that closes the same race for splits.
--
-- Why this does not duplicate the attachment-delete authorization path: the
-- caller has already passed creator-only, draft-only and no-splits to reach this
-- point, and the rows being removed are children of the row being deleted. There
-- is no per-attachment decision to make — no uploader check, no manager check,
-- and no route that could be used to delete one attachment of somebody else's
-- draft. It is cascade cleanup, expressed as SQL because the schema cannot say
-- `ON DELETE CASCADE` for a polymorphic reference.
--
-- Storage is deliberately **not** touched here. A database function cannot delete
-- an object; the API removes the rows' objects afterwards, best-effort, and a
-- failure leaves a sweepable orphan rather than a broken live reference
-- (ADR-0012 D6.3 and its Consequences).
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
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  SELECT m.id
    INTO v_actor_member_id
    FROM public.members m
   WHERE m.society_id = p_society_id
     AND m.user_id = (SELECT auth.uid())
     AND m.status = 'active'
   LIMIT 1;

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
  DELETE FROM public.attachments
   WHERE entity_type = 'expense'
     AND entity_id = p_expense_id
     AND society_id = p_society_id;

  DELETE FROM public.expenses
   WHERE id = p_expense_id
     AND society_id = p_society_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.expense_draft_delete(uuid, uuid) IS
  'Hard delete of one draft expense (T065, PRD §3.5). 404 for a non-member or an expense outside the society, 403/P0003 for a member who did not create it, P0001/EXPENSE_NOT_DRAFT for a non-draft, P0001/EXPENSE_HAS_SPLITS while splits exist. Since T071 it also removes the draft''s attachment rows in the same transaction (ADR-0012 D6.5); their objects are removed best-effort by the caller.';

-- The privileges are unchanged from T065's file and are restated rather than
-- assumed: `CREATE OR REPLACE` preserves them, so this block is a no-op that
-- documents the surface instead of an edit. It is kept because a reader of the
-- function should not have to open a second migration to learn who may call it.
REVOKE ALL ON FUNCTION public.expense_draft_delete(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expense_draft_delete(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.expense_draft_delete(uuid, uuid) TO authenticated;
