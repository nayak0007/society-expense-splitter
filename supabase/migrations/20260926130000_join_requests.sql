-- ============================================================================
-- T049 · Join requests and approval queue (PRD §3.2, §3.3)
-- ============================================================================
--
-- "Join Society" (PRD §3.2): enter code → preview → **select the flat** → declare
-- occupancy → submit → `pending` → Admin/Treasurer approves → role assigned. And PRD
-- §3.2's rule for a collision: "If someone claims an already-claimed flat, route it to
-- the Admin with both claims visible — do not auto-reject."
--
-- ## A join request is a pending membership — there is no `join_requests` table
--
-- PRD §7 defines no such relation, and `members` already holds every field a request
-- needs: the society, the subject, the flat, the occupancy, a status and a creation
-- time. `status = 'pending'` *is* "asked, undecided", and the table's own trigger states
-- the rule (`chk_member_self_change()`: pending|active → removed, removed → pending,
-- "everything else — above all → active — is an approval"). So this migration adds the
-- fields a *request* carries that a membership did not, the self-service transition a
-- re-ask needs, and the two decisions — never a second table. Two rows that must agree
-- about one fact is one row too many, and the first thing the pair would disagree about
-- is which of them is pending.
--
-- What this migration guarantees, and where:
--
--   1. **The request's own record.** `request_note` (the requester's optional message),
--      `rejection_reason`, `rejected_at`, `rejected_by`. A rejection always carries a
--      reason (`chk_members_rejection_reason`), because the requester is a person waiting
--      for an answer and "no" is not one.
--   2. **A re-ask after a rejection.** `chk_member_self_change()` gains exactly one
--      transition — `rejected → pending` — so somebody refused a claim can correct it
--      and ask again. The previous decision's stamps survive, so the next reviewer sees
--      what the last one said rather than a blank row.
--   3. **Approval and rejection are atomic, single-use and reviewed.** Both are
--      `SECURITY DEFINER` functions that lock the row `FOR UPDATE`, re-check
--      `status = 'pending'`, resolve the *caller's own* membership and require
--      `member.approve` (Admin or Treasurer) in that society — so two simultaneous
--      approvals produce exactly one active membership and exactly one decision, and a
--      Treasurer (whom `members_update_self_or_admin` cannot let write somebody else's
--      row) can still do their job.
--   4. **The flat list the join screen selects from.** `society_join_options()` — a
--      definer function keyed by the join code, because a *requester is not a member yet*
--      and `apartments_select_member` requires `is_society_member(society_id, true)`.
--      Deliberately **not** part of `society_join_preview()`: that one is reachable
--      without an identity (the public `/societies/lookup`), and its contract is "name,
--      city and member count only" (T040).
--   5. **No double billing.** `join_request_blocking_shadow()` refuses a join request from
--      somebody whose phone is already recorded as a live *shadow* member of that society
--      — the case where the Admin's record and the requester's own row would both be
--      billed. The designed path for that person is T047's invitation, which **links** the
--      shadow row instead of duplicating it; this guard makes the join path say so.
--
-- What it deliberately does NOT do, because it belongs to another task:
--
--   * **No notifications.** "Approval … notifies the requester" (T049) is the notifications
--     phase (T102+): there is no `INotificationChannel` implementation to call. The
--     integration seam is the row itself — `approved_by`/`joined_at`/`rejected_by`/
--     `rejected_at` and the status, which is what a dispatcher would read.
--   * **No audit table** (T050). Every decision is stamped with who made it and when.
--   * **No expiry sweep.** Neither the PRD nor the roadmap gives a join request a TTL.
--   * **No `join_requests` view.** A view is a second definition of this row; the API's
--     queue read is a query, and the domain's `JoinRequest` is a type over `Member`.
--
-- ── down ────────────────────────────────────────────────────────────────────
--   DROP FUNCTION IF EXISTS public.society_join_options(text, text, integer);
--   DROP FUNCTION IF EXISTS public.join_request_blocking_shadow(uuid, uuid);
--   DROP FUNCTION IF EXISTS public.is_live_society_apartment(uuid, uuid);
--   DROP FUNCTION IF EXISTS public.member_reject_join(uuid, uuid, uuid, text);
--   DROP FUNCTION IF EXISTS public.member_approve_join(uuid, uuid, uuid, jsonb);
--   DROP INDEX IF EXISTS public.idx_members_join_queue;
--   ALTER TABLE public.members DROP CONSTRAINT IF EXISTS chk_members_rejection_reason;
--   ALTER TABLE public.members DROP CONSTRAINT IF EXISTS chk_members_request_note_length;
--   ALTER TABLE public.members DROP CONSTRAINT IF EXISTS fk_members_rejected_by;
--   ALTER TABLE public.members
--     DROP COLUMN IF EXISTS request_note,
--     DROP COLUMN IF EXISTS rejection_reason,
--     DROP COLUMN IF EXISTS rejected_at,
--     DROP COLUMN IF EXISTS rejected_by;
--   GRANT UPDATE (request_note) ON public.members TO authenticated;  -- keep the grant
--   (and `chk_member_self_change` re-created from
--    `20260925120000_members_directory.sql`, and `members_insert_self_pending`
--    re-created from `20260920130100_society_rls.sql` without the `NOT is_primary`
--    clause)
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The request's own fields
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS request_note text;

-- A rejection's reason and stamps. Not a `reviewed_by`/`reviewed_at` pair: approval
-- already has `approved_by`/`joined_at` (T045), and naming the *outcome* is what makes
-- "who decided this, and when" answerable for each state separately. A generic pair
-- would have to be interpreted against the status to mean anything.
ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS rejection_reason text;
ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
ALTER TABLE public.members
  ADD COLUMN IF NOT EXISTS rejected_by uuid;

ALTER TABLE public.members
  DROP CONSTRAINT IF EXISTS fk_members_rejected_by;
ALTER TABLE public.members
  ADD CONSTRAINT fk_members_rejected_by
  FOREIGN KEY (rejected_by) REFERENCES public.members (id) ON DELETE SET NULL;

-- Mirrors `JOIN_NOTE_MAX_LENGTH` in @ses/domain. The note is a sentence or two — the
-- text box on the join screen, not a dossier — and a bound the form and the column
-- disagree about is a field error that arrives as a database crash.
ALTER TABLE public.members
  DROP CONSTRAINT IF EXISTS chk_members_request_note_length;
ALTER TABLE public.members
  ADD CONSTRAINT chk_members_request_note_length
  CHECK (request_note IS NULL OR char_length(request_note) <= 500);

-- A rejected membership always names a reason, and always carries the stamp of when it
-- was refused. The check is deliberately **one-directional** — "if rejected, then a
-- reason" rather than "rejected = reason IS NOT NULL" — because a re-ask keeps the
-- previous decision's stamps (see §2): an honest history and a biconditional cannot both
-- hold.
ALTER TABLE public.members
  DROP CONSTRAINT IF EXISTS chk_members_rejection_reason;
ALTER TABLE public.members
  ADD CONSTRAINT chk_members_rejection_reason
  CHECK (
    status <> 'rejected'
    OR (
      rejected_at IS NOT NULL
      AND rejection_reason IS NOT NULL
      AND btrim(rejection_reason) <> ''
    )
  );

-- The queue's read: one society's pending rows, oldest first, with the claims joined in.
-- `idx_members_society_status` (society_core) already covers `(society_id, status)`; this
-- partial index is about the *order* the queue is rendered in, and it is partial for the
-- same reason every other member index is — a society's decided rows outnumber its pending
-- ones by an order of magnitude, and they are never in this list.
CREATE INDEX IF NOT EXISTS idx_members_join_queue
  ON public.members (society_id, created_at)
  WHERE status = 'pending';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Asking again after a rejection
-- ─────────────────────────────────────────────────────────────────────────────

-- Same rule as `20260925120000_members_directory.sql`, with one new branch:
--
--     pending|active → removed   (leave / withdraw)
--     removed        → pending   (ask to rejoin)
--     rejected       → pending   (correct the claim and ask again)   ← new in T049
--
-- Why the new branch: a rejection is a decision about *one claim* ("that flat is not
-- yours", "we cannot admit you without an Admin's approval"), not about a person. Without
-- it, a requester whose only mistake was a wrong flat has no self-service path at all —
-- their row is neither pending (so they cannot withdraw) nor removed (so they cannot
-- re-ask), and the society's answer becomes "ask an Admin to fix it for you" for something
-- the requester can see and correct themselves.
--
-- What deliberately does NOT change: `→ active` is still not a self-service transition, on
-- any path. Approval is a decision by somebody else, which is the whole point of the queue.
--
-- The previous rejection's `rejection_reason`/`rejected_at`/`rejected_by` survive the
-- re-ask, and that is a decision rather than an oversight: the next reviewer sees what the
-- last one decided and why, which is exactly the context a re-ask needs. They are
-- overwritten by the next decision.
CREATE OR REPLACE FUNCTION public.chk_member_self_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  caller uuid := (SELECT auth.uid());
BEGIN
  -- No JWT (service_role, a migration, the API's own connection, or the
  -- `ON DELETE SET NULL` cascade from `auth.users`): the server path, which is
  -- trusted and audited elsewhere. The ordering matters — the cascade that
  -- nulls `user_id` when an account is deleted (PRD §3.1 keeps the financial
  -- rows) must not be mistaken for a client rewriting a membership.
  IF caller IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.society_id <> OLD.society_id THEN
    RAISE EXCEPTION 'MEMBER_SOCIETY_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;

  -- The membership's subject never changes. (A NULL ⇄ value change would move
  -- a shadow member's history onto someone else.) Column grants already exclude
  -- both columns; this is the second lock on the same door.
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'MEMBER_USER_IMMUTABLE' USING ERRCODE = 'P0001';
  END IF;

  -- Someone else's row: governed by RLS and the admin paths, not by this rule.
  IF OLD.user_id IS DISTINCT FROM caller THEN
    RETURN NEW;
  END IF;

  IF NEW.role IS DISTINCT FROM OLD.role THEN
    RAISE EXCEPTION 'MEMBER_ROLE_CHANGE_FORBIDDEN'
      USING ERRCODE = 'P0001',
            HINT = 'Only a society Admin can change roles.';
  END IF;

  -- Primacy is never self-served: a member who could set `is_primary` on their own row would be
  -- claiming the flat's primary occupancy without an Admin deciding it.
  IF NEW.is_primary IS DISTINCT FROM OLD.is_primary THEN
    RAISE EXCEPTION 'MEMBER_APARTMENT_CHANGE_FORBIDDEN'
      USING ERRCODE = 'P0001',
            HINT = 'Only a society Admin can decide a flat''s primary occupant.';
  END IF;

  -- The flat is an Admin's decision for a *membership* and the requester's own declaration for
  -- a *request*. T045 wrote the stricter rule when every row that could carry a flat was a live
  -- membership; `pending` is a claim with no billing behind it, and T049's flow is "pick your
  -- flat, the Admin confirms or corrects it at approval". So a self-move is refused unless the
  -- row is a request on one side of the write — entering it (`removed|rejected → pending`, which
  -- is how a refused claim gets corrected) or leaving it (`pending → removed`, a withdrawal).
  -- Once admitted, moving yourself is refused exactly as before.
  IF NEW.apartment_id IS DISTINCT FROM OLD.apartment_id
     AND NOT (OLD.status = 'pending' OR NEW.status = 'pending') THEN
    RAISE EXCEPTION 'MEMBER_APARTMENT_CHANGE_FORBIDDEN'
      USING ERRCODE = 'P0001',
            HINT = 'Only a society Admin can move a membership to another flat.';
  END IF;

  -- Self-service is leaving, withdrawing a request and asking again:
  --   pending|active → removed          (leave / withdraw)
  --   removed        → pending          (ask to rejoin)
  --   rejected       → pending          (ask again after a refusal — T049)
  -- Everything else — above all `→ active` — is an approval, and an approval by
  -- the person being approved is how a join queue becomes decorative.
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (
       (NEW.status = 'removed' AND OLD.status IN ('pending', 'active'))
       OR (NEW.status = 'pending' AND OLD.status IN ('removed', 'rejected'))
     ) THEN
    RAISE EXCEPTION 'MEMBER_STATUS_CHANGE_FORBIDDEN'
      USING ERRCODE = 'P0001',
            HINT = 'Joining a society needs an Admin to approve it.';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.chk_member_self_change() IS
  'A member may leave, withdraw a request and ask again (pending|active → removed, removed|rejected → pending). Approval (→ active) is never self-service.';

-- Primacy is a decision, not a request field. `members_insert_self_pending` (society RLS)
-- pins a self-join to the caller's own row, `pending`, `resident` — and says nothing about
-- `is_primary`, which T045 added to the INSERT grant so an Admin could record a flat's
-- primary occupant. A requester could therefore have written `is_primary = true` on their
-- own pending row, and the approval would then confirm it by default: an Admin's decision
-- turned into a self-declaration. The clause below closes that by *narrowing* an existing
-- policy, which is the one direction a policy change is always safe in.
DROP POLICY IF EXISTS members_insert_self_pending ON public.members;
CREATE POLICY members_insert_self_pending
  ON public.members
  FOR INSERT
  TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND status = 'pending'
    AND role = 'resident'
    AND removed_at IS NULL
    AND NOT is_primary
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The decisions
-- ─────────────────────────────────────────────────────────────────────────────

-- The reviewer predicate, as a function so both decisions share one definition.
--
-- `member.approve` is held by Admin and Treasurer (PRD §2.1), which is exactly
-- `is_society_member_manager()` — the invitations migration already created that predicate
-- for `member.invite`, whose holders are the same two roles. Rather than a second function
-- with an identical body (two copies of one matrix cell, which is the drift this schema
-- avoids everywhere else), this one is a *named alias* with its own comment: a reviewer of
-- the queue and a manager of invitations are the same person today, and if the matrix ever
-- separates them, the two functions separate with it.
CREATE OR REPLACE FUNCTION public.is_society_join_reviewer(p_society_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT public.is_society_member_manager(p_society_id);
$$;

COMMENT ON FUNCTION public.is_society_join_reviewer(uuid) IS
  'Active holder of member.approve in this society (Admin or Treasurer, PRD §2.1). Today the same two roles as member.invite; named separately so the queue states its own grant.';

REVOKE ALL ON FUNCTION public.is_society_join_reviewer(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_society_join_reviewer(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_society_join_reviewer(uuid) TO authenticated;

-- Approve one request. One transaction, one lock, one decision:
--
--   * `SELECT … FOR UPDATE` serialises two approvals, so the second sees `active` and is
--     refused with `JOIN_REQUEST_NOT_PENDING` — the request is consumed exactly once;
--   * the reviewer is resolved from `auth.uid()`, never from an argument, and must hold
--     `is_society_join_reviewer` **in the request's own society** — so an Admin of another
--     society cannot reach this row even with its id;
--   * the actor must be the verified caller: a definer function that trusted a parameter
--     would let anybody approve anybody by naming them;
--   * the role, occupancy, flat and primary flag come from the request unless the payload
--     overrides them (`absent` = as requested, `null` apartment = clear it — the same
--     two-modifier shape the member patch uses), and a role above `resident` requires
--     `member.role_change` (Admin), mirroring `stamp_invitation_creator()`;
--   * the flat must be a live flat of the request's society — the composite FK would
--     refuse a foreign one, but a *soft-deleted* flat satisfies it, and moving somebody
--     into a flat that is being removed is not an approval;
--   * the write goes through the table's own triggers, so `chk_role_caps()` still refuses a
--     fourth Admin, `uq_primary_occupant` still refuses a second primary owner of the flat
--     (that refusal is the "both claims visible" rule reaching the database), and
--     `chk_members_primary_requires_apartment` still pairs the flat with the flag.
--
-- The identity is *not* cleared here — unlike `invitation_accept()`, which writes a row on
-- the caller's own behalf. The reviewer is a different person from the requester, so
-- `chk_member_self_change()` returns early on the `OLD.user_id <> caller` branch and the
-- write proceeds with the reviewer's real identity, which is then what the stamps record.
CREATE OR REPLACE FUNCTION public.member_approve_join(
  p_member_id uuid,
  p_society_id uuid,
  p_actor uuid,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target public.members;
  reviewer public.members;
  requested_role public.member_role;
  requested_occupancy public.occupancy_type;
  requested_apartment uuid;
  requested_primary boolean;
  apartment_ok boolean;
BEGIN
  IF p_actor IS NULL OR p_actor IS DISTINCT FROM (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'JOIN_REVIEW_DENIED'
      USING ERRCODE = 'P0001',
            HINT = 'Sign in as the reviewing member to decide a join request.';
  END IF;

  SELECT * INTO target
    FROM public.members m
   WHERE m.id = p_member_id
     AND m.society_id = p_society_id
   FOR UPDATE;

  IF target.id IS NULL THEN
    RAISE EXCEPTION 'JOIN_REQUEST_NOT_FOUND'
      USING ERRCODE = 'P0001',
            HINT = 'That join request is not available to you.';
  END IF;

  SELECT * INTO reviewer
    FROM public.members m
   WHERE m.society_id = target.society_id
     AND m.user_id = p_actor
     AND m.status = 'active'
     AND m.role IN ('admin', 'treasurer')
   LIMIT 1;

  IF reviewer.id IS NULL THEN
    RAISE EXCEPTION 'JOIN_REVIEW_FORBIDDEN'
      USING ERRCODE = 'P0001',
            HINT = 'Only an Admin or Treasurer of this society can decide a join request.';
  END IF;

  IF target.status <> 'pending' THEN
    RAISE EXCEPTION 'JOIN_REQUEST_NOT_PENDING'
      USING ERRCODE = 'P0001',
            HINT = 'That request has already been decided.';
  END IF;

  -- Nobody decides their own request. Structurally unreachable (a pending member holds no
  -- `member.approve`, so the reviewer lookup above would not have found them) and asserted
  -- anyway, because the rule is about *whose* row it is, not about the current schema.
  IF reviewer.id = target.id THEN
    RAISE EXCEPTION 'JOIN_SELF_REVIEW'
      USING ERRCODE = 'P0001',
            HINT = 'Ask another Admin or Treasurer to decide your own request.';
  END IF;

  -- ── the values the approval settles ────────────────────────────────────────

  IF p_payload ? 'role' THEN
    IF NOT EXISTS (
      SELECT 1 FROM unnest(enum_range(NULL::public.member_role)) AS r(value)
       WHERE r.value::text = p_payload ->> 'role'
    ) THEN
      RAISE EXCEPTION 'JOIN_ROLE_INVALID'
        USING ERRCODE = 'P0001', HINT = 'That is not a role this society has.';
    END IF;
    requested_role := (p_payload ->> 'role')::public.member_role;
  ELSE
    requested_role := target.role;
  END IF;

  IF requested_role <> 'resident' AND reviewer.role <> 'admin' THEN
    RAISE EXCEPTION 'JOIN_ROLE_NOT_ASSIGNABLE'
      USING ERRCODE = 'P0001',
            HINT = 'Only a society Admin can admit somebody at a role above Resident.';
  END IF;

  IF p_payload ? 'occupancy' THEN
    IF NOT EXISTS (
      SELECT 1 FROM unnest(enum_range(NULL::public.occupancy_type)) AS o(value)
       WHERE o.value::text = p_payload ->> 'occupancy'
    ) THEN
      RAISE EXCEPTION 'JOIN_OCCUPANCY_INVALID'
        USING ERRCODE = 'P0001', HINT = 'That is not an occupancy this society records.';
    END IF;
    requested_occupancy := (p_payload ->> 'occupancy')::public.occupancy_type;
  ELSE
    requested_occupancy := target.occupancy;
  END IF;

  IF p_payload ? 'apartment_id' THEN
    requested_apartment := NULLIF(p_payload ->> 'apartment_id', '')::uuid;
  ELSE
    requested_apartment := target.apartment_id;
  END IF;

  IF p_payload ? 'is_primary' THEN
    IF p_payload ->> 'is_primary' NOT IN ('true', 'false') THEN
      RAISE EXCEPTION 'JOIN_PRIMARY_INVALID'
        USING ERRCODE = 'P0001', HINT = 'The primary flag is a yes or a no.';
    END IF;
    requested_primary := (p_payload ->> 'is_primary')::boolean;
  ELSE
    requested_primary := target.is_primary;
  END IF;

  IF requested_apartment IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.apartments a
       WHERE a.id = requested_apartment
         AND a.society_id = target.society_id
         AND a.deleted_at IS NULL
    ) INTO apartment_ok;
    IF NOT apartment_ok THEN
      RAISE EXCEPTION 'JOIN_APARTMENT_INVALID'
        USING ERRCODE = 'P0001',
              HINT = 'That flat is not an available flat of this society.';
    END IF;
  END IF;

  IF requested_primary AND requested_apartment IS NULL THEN
    RAISE EXCEPTION 'JOIN_PRIMARY_REQUIRES_APARTMENT'
      USING ERRCODE = 'P0001',
            HINT = 'A primary occupant needs a flat.';
  END IF;

  UPDATE public.members m
     SET status = 'active',
         role = requested_role,
         occupancy = requested_occupancy,
         apartment_id = requested_apartment,
         is_primary = requested_primary,
         joined_at = COALESCE(m.joined_at, now()),
         approved_by = reviewer.id
   WHERE m.id = target.id;

  -- A rejection this approval overrides: the decision changes, so its outcome stamps go.
  -- The reason is cleared with them, because a row that is `active` and carries a
  -- rejection reason reads as though it were still being argued about. (A *re-ask* keeps
  -- them, deliberately — see §2 — which is why this is an explicit clear here rather than
  -- a rule in the trigger.)
  UPDATE public.members m
     SET rejection_reason = NULL,
         rejected_at = NULL,
         rejected_by = NULL
   WHERE m.id = target.id
     AND m.rejected_at IS NOT NULL;

  RETURN jsonb_build_object('id', target.id, 'status', 'active');
END;
$$;

COMMENT ON FUNCTION public.member_approve_join(uuid, uuid, uuid, jsonb) IS
  'Approve one join request: locks the row, requires member.approve in that society, and activates the membership exactly once (T049).';

REVOKE ALL ON FUNCTION public.member_approve_join(uuid, uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.member_approve_join(uuid, uuid, uuid, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.member_approve_join(uuid, uuid, uuid, jsonb) TO authenticated;

-- Reject one request. Same lock, same reviewer resolution, same "must still be pending".
--
-- The reason is a **required argument rather than an optional field**, which is the one
-- place this schema insists on something the caller might not have: the requester is a
-- person waiting for an answer, and the PRD's rejection path is what gives them one. The
-- trigger and `chk_members_rejection_reason` enforce the same rule underneath, so a writer
-- that skips this function cannot leave a reasonless refusal behind either.
CREATE OR REPLACE FUNCTION public.member_reject_join(
  p_member_id uuid,
  p_society_id uuid,
  p_actor uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  target public.members;
  reviewer public.members;
  reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF p_actor IS NULL OR p_actor IS DISTINCT FROM (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'JOIN_REVIEW_DENIED'
      USING ERRCODE = 'P0001',
            HINT = 'Sign in as the reviewing member to decide a join request.';
  END IF;

  IF char_length(reason) < 4 THEN
    RAISE EXCEPTION 'JOIN_REJECTION_REASON_REQUIRED'
      USING ERRCODE = 'P0001',
            HINT = 'Give a reason the requester can act on.';
  END IF;

  SELECT * INTO target
    FROM public.members m
   WHERE m.id = p_member_id
     AND m.society_id = p_society_id
   FOR UPDATE;

  IF target.id IS NULL THEN
    RAISE EXCEPTION 'JOIN_REQUEST_NOT_FOUND'
      USING ERRCODE = 'P0001',
            HINT = 'That join request is not available to you.';
  END IF;

  SELECT * INTO reviewer
    FROM public.members m
   WHERE m.society_id = target.society_id
     AND m.user_id = p_actor
     AND m.status = 'active'
     AND m.role IN ('admin', 'treasurer')
   LIMIT 1;

  IF reviewer.id IS NULL THEN
    RAISE EXCEPTION 'JOIN_REVIEW_FORBIDDEN'
      USING ERRCODE = 'P0001',
            HINT = 'Only an Admin or Treasurer of this society can decide a join request.';
  END IF;

  IF target.status <> 'pending' THEN
    RAISE EXCEPTION 'JOIN_REQUEST_NOT_PENDING'
      USING ERRCODE = 'P0001',
            HINT = 'That request has already been decided.';
  END IF;

  IF reviewer.id = target.id THEN
    RAISE EXCEPTION 'JOIN_SELF_REVIEW'
      USING ERRCODE = 'P0001',
            HINT = 'Ask another Admin or Treasurer to decide your own request.';
  END IF;

  UPDATE public.members m
     SET status = 'rejected',
         rejection_reason = reason,
         rejected_at = now(),
         rejected_by = reviewer.id
   WHERE m.id = target.id;

  RETURN jsonb_build_object('id', target.id, 'status', 'rejected');
END;
$$;

COMMENT ON FUNCTION public.member_reject_join(uuid, uuid, uuid, text) IS
  'Reject one join request with a required reason: locks the row, requires member.approve in that society, and stamps rejected_at/rejected_by (T049).';

REVOKE ALL ON FUNCTION public.member_reject_join(uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.member_reject_join(uuid, uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.member_reject_join(uuid, uuid, uuid, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. What the join screen may choose from
-- ─────────────────────────────────────────────────────────────────────────────

-- The flats a join code's society will let somebody ask for.
--
-- PRD §3.2's flow selects "building/wing/flat from the actual apartment list", and the
-- person selecting is **not a member yet** — `apartments_select_member` requires
-- `is_society_member(society_id, true)`, so no policy can serve this read. Hence a definer
-- function keyed by the code: the code *is* the credential (it is what grants the ability
-- to join at all), which is why this is not an id-addressed `society_flats(uuid)` — that
-- signature would be an enumeration endpoint for anyone with a guess.
--
-- The projection is the selector's, not the inventory's: the flat's id, number, floor and
-- its building's and wing's *names*. No areas, no billing flags, no occupants, no member
-- count per flat — nothing an owner could price a flat with, and nothing about who lives
-- where. `apartment_id` is returned because the request that follows names a flat by id;
-- a client that had to send a flat *number* would be sending a label the server then has
-- to resolve, which is how two flats end up claiming one number.
--
-- `p_query` narrows by flat number (contains, case-insensitive) or building name, so a
-- 300-flat society is searchable instead of scrollable. `truncated` says whether the cap
-- was reached, so a client renders "keep typing" rather than a list it believes is whole.
CREATE OR REPLACE FUNCTION public.society_join_options(
  p_code text,
  p_query text DEFAULT NULL,
  p_limit integer DEFAULT 50
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  society_id uuid;
  cap integer := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  needle text := NULLIF(btrim(COALESCE(p_query, '')), '');
  flats jsonb;
  total integer;
BEGIN
  SELECT s.id INTO society_id
    FROM public.societies s
   WHERE s.deleted_at IS NULL
     AND s.join_code = upper(btrim(p_code))
   LIMIT 1;

  IF society_id IS NULL THEN
    RAISE EXCEPTION 'SOCIETY_JOIN_CODE_INVALID'
      USING ERRCODE = 'P0001',
            HINT = 'That join code does not match any society.';
  END IF;

  SELECT count(*)::int INTO total
    FROM public.apartments a
    JOIN public.buildings b ON b.id = a.building_id
   WHERE a.society_id = society_id
     AND a.deleted_at IS NULL
     AND (
       needle IS NULL
       OR a.apartment_number ILIKE '%' || needle || '%'
       OR b.name ILIKE '%' || needle || '%'
     );

  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'id', flat.id,
               'number', flat.apartment_number,
               'buildingId', flat.building_id,
               'buildingName', flat.building_name,
               'wingId', flat.wing_id,
               'wingName', flat.wing_name,
               'floor', flat.floor
             )
             ORDER BY flat.building_name, flat.apartment_number
           ),
           '[]'::jsonb
         )
    INTO flats
    FROM (
      SELECT a.id,
             a.apartment_number,
             a.building_id,
             a.wing_id,
             a.floor,
             b.name AS building_name,
             w.name AS wing_name
        FROM public.apartments a
        JOIN public.buildings b ON b.id = a.building_id
        LEFT JOIN public.wings w ON w.id = a.wing_id
       WHERE a.society_id = society_id
         AND a.deleted_at IS NULL
         AND (
           needle IS NULL
           OR a.apartment_number ILIKE '%' || needle || '%'
           OR b.name ILIKE '%' || needle || '%'
         )
       ORDER BY b.name, a.apartment_number
       LIMIT cap
    ) AS flat;

  RETURN jsonb_build_object(
    'society_id', society_id,
    'flats', flats,
    'total', total,
    'truncated', total > cap
  );
END;
$$;

COMMENT ON FUNCTION public.society_join_options(text, text, integer) IS
  'The flats a join code''s society offers the join screen (id, number, building, wing, floor) — definer, because a requester is not a member yet (T049).';

REVOKE ALL ON FUNCTION public.society_join_options(text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.society_join_options(text, text, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.society_join_options(text, text, integer) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. No double billing: the shadow record this person already has
-- ─────────────────────────────────────────────────────────────────────────────

-- Returns the id of a live **shadow** member of this society whose phone is the caller's
-- own, or NULL.
--
-- PRD §3.3: a shadow member is "linked when that phone signs up" — the designed path is an
-- invitation (T047's `invitation_accept()` links rather than duplicates). A *join request*
-- is the other door into the same society, and without this check the society ends up with
-- two live rows for one person: the Admin's shadow row (billable, unreachable) and the
-- requester's own (billable, reachable). Two bills for one flat's occupant is a money bug
-- wearing a directory bug's clothes.
--
-- Definer because the caller cannot read the roster yet (`members_select_self_or_roster`
-- grants the whole roster only to an *active* member), and it answers with an id — not a
-- row, not a name, not a number — so the refusal can name the situation without disclosing
-- anything the caller did not already know about themselves.
CREATE OR REPLACE FUNCTION public.join_request_blocking_shadow(
  p_society_id uuid,
  p_actor uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.id
    FROM public.members m
    JOIN public.profiles p ON p.id = p_actor
   WHERE m.society_id = p_society_id
     AND m.user_id IS NULL
     AND m.status <> 'removed'
     AND m.phone IS NOT NULL
     AND p.phone IS NOT NULL
     AND m.phone = p.phone
   LIMIT 1;
$$;

COMMENT ON FUNCTION public.join_request_blocking_shadow(uuid, uuid) IS
  'The live shadow member already recorded for the caller''s number, if any: the join path refuses rather than billing one person twice (T049; the invitation path links instead).';

REVOKE ALL ON FUNCTION public.join_request_blocking_shadow(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.join_request_blocking_shadow(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.join_request_blocking_shadow(uuid, uuid) TO authenticated;

-- Is this a live flat of this society? The join request's flat, checked before the row is
-- written rather than after.
--
-- Definer for the same reason the options function is: a requester is not a member yet, so
-- `apartments_select_member` shows them nothing and a policy-filtered `EXISTS` would answer
-- "no" to every flat. The alternatives are worse than a predicate: the composite foreign key
-- (`fk_members_apartment_society`) accepts a *soft-deleted* flat — the row is still there — so
-- a request could claim a flat that is being removed and only fail at approval, with the
-- message meant for a different situation.
CREATE OR REPLACE FUNCTION public.is_live_society_apartment(
  p_apartment_id uuid,
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
      FROM public.apartments a
     WHERE a.id = p_apartment_id
       AND a.society_id = p_society_id
       AND a.deleted_at IS NULL
  );
$$;

COMMENT ON FUNCTION public.is_live_society_apartment(uuid, uuid) IS
  'True when the id names a live flat of that society. Definer, because a join requester is not a member yet (T049).';

REVOKE ALL ON FUNCTION public.is_live_society_apartment(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_live_society_apartment(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_live_society_apartment(uuid, uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Privileges
-- ─────────────────────────────────────────────────────────────────────────────

-- `request_note` joins the columns a caller may write on their own row. The two grants
-- together are what let the *same* code path both create a request and re-ask after a
-- rejection (`insert … request_note` / `update … set status='pending', request_note=…`) —
-- a column that could be set on the first ask but never corrected would send a requester to
-- an Admin to fix a typo.
--
-- Nothing else is granted: `rejection_reason`, `rejected_at`, `rejected_by` and `status`'s
-- transitions to `active`/`rejected` are the two decision functions' to write, and
-- `members_update_self_or_admin` still decides whose row these grants reach.
GRANT INSERT (request_note) ON public.members TO authenticated;
GRANT UPDATE (request_note) ON public.members TO authenticated;
