-- ============================================================================
-- T047 · Invitations — single and targeted (PRD §3.3, §7.2)
-- ============================================================================
--
-- "Invite Members" (PRD §3.3): a targeted invite binds a flat and auto-approves on
-- acceptance; tokens expire in 14 days, are single-use and are revocable; the funnel is
-- `sent → opened → accepted`.
--
-- What this migration guarantees, and where:
--
--   1. An invitation belongs to exactly one society — the FK, plus every policy and
--      function reading `society_id` rather than trusting a caller.
--   2. Only a member-manager (`member.invite`: Admin and Treasurer) may create, list or
--      revoke one. The INSERT policy and the stamping trigger both insist on it.
--   3. The **token is never stored**: `token_hash` is a sha256 hex digest, `CHECK`ed to
--      that shape, and it is excluded from every column grant — no client can read one,
--      and a database dump does not yield a working link.
--   4. A role above `resident` may only be invited by an Admin (`member.role_change`),
--      and a shared `link` invitation may only carry `resident` at all: an unaddressed
--      link is a bearer credential, and a leaked admin link would be privilege
--      escalation with extra steps.
--   5. Somebody who already has an account in the society is refused
--      (`INVITATION_RECIPIENT_ALREADY_MEMBER`); a *shadow* member is not, because
--      inviting them and linking their row on acceptance is the designed path (PRD
--      §3.3's "shadow member … linked when that phone signs up").
--   6. Two live invitations for one recipient are refused by partial unique indexes —
--      one per address, one per number — so "invite twice" is a deterministic conflict
--      rather than a race.
--   7. **Acceptance is atomic and single-use.** `invitation_accept()` locks the row
--      `FOR UPDATE`, re-checks status/expiry/recipient, writes the membership and marks
--      the invitation in one transaction, so two simultaneous accepts cannot both win
--      and cannot create two memberships.
--
-- What it deliberately does NOT do, because it belongs to another task:
--
--   * **No delivery.** `channel` records what the inviter chose (`whatsapp|sms|email|link`);
--     actually sending it is the notifications phase (SAD §6, `INotificationChannel`).
--     Nothing here logs or stores the token, so delivery is an orchestration concern with
--     the seam already in place (`invitation_create` returns the token to its caller once).
--   * **No bulk/CSV invitations** (T048) and **no resend** — the PRD's API table has
--     neither a resend endpoint nor a bulk one for T047; a revoked invitation is replaced
--     by creating another.
--   * **No `expired` write.** The status enum keeps PRD §7.2's five labels, but expiry is
--     **derived** (`expires_at <= now()`): a sweeper that had to run for correctness would
--     make a stopped worker look like functioning invitations.
--   * **No audit table** (T050). The row itself carries who invited, opened, accepted and
--     revoked, with timestamps — the integration seam for the audit module.
--
-- ── down ────────────────────────────────────────────────────────────────────
--   DROP FUNCTION IF EXISTS public.invitation_accept(text, uuid);
--   DROP FUNCTION IF EXISTS public.invitation_preview(text);
--   DROP FUNCTION IF EXISTS public.is_society_member_manager(uuid);
--   DROP TABLE IF EXISTS public.invitations;
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The predicate the policies share
-- ─────────────────────────────────────────────────────────────────────────────

-- `member.invite` is held by Admin and Treasurer (PRD §2.1), so the database needs a
-- predicate that is deliberately *wider* than `is_society_admin()`. It mirrors the matrix
-- cell rather than inventing a rule: the role list here is `member.invite`'s holders, and
-- `packages/domain/src/member/permission-evaluator.ts` is still the source of truth the API
-- guard reads — this is the policy's copy of one cell, as every policy has.
CREATE OR REPLACE FUNCTION public.is_society_member_manager(p_society_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.members m
     WHERE m.society_id = p_society_id
       AND m.user_id = (SELECT auth.uid())
       AND m.status = 'active'
       AND m.role IN ('admin', 'treasurer')
  );
$$;

COMMENT ON FUNCTION public.is_society_member_manager(uuid) IS
  'Active holder of member.invite in this society (Admin or Treasurer, PRD §2.1). The RLS copy of one matrix cell.';

REVOKE ALL ON FUNCTION public.is_society_member_manager(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_society_member_manager(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.is_society_member_manager(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  society_id uuid NOT NULL REFERENCES public.societies (id) ON DELETE CASCADE,
  apartment_id uuid,
  invited_by uuid NOT NULL REFERENCES public.members (id),
  channel varchar(16) NOT NULL,
  phone varchar(16),
  email citext,
  role public.member_role NOT NULL DEFAULT 'resident',
  token_hash text NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'sent',
  expires_at timestamptz NOT NULL,
  opened_at timestamptz,
  accepted_at timestamptz,
  -- The account that redeemed it. `auth.users` because the accepted identity is an account,
  -- not a membership (the membership is what this row creates), and because a row that
  -- outlives the membership must still name who used the link.
  accepted_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES public.members (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- PRD §7.2's vocabulary, verbatim.
  CONSTRAINT chk_invitations_channel
    CHECK (channel IN ('whatsapp', 'sms', 'email', 'link')),
  CONSTRAINT chk_invitations_status
    CHECK (status IN ('sent', 'opened', 'accepted', 'expired', 'revoked')),
  -- An invitation must reach somebody: an address, a number, or an open link that is
  -- deliberately shareable. The open-link case is narrowed further by the trigger below.
  CONSTRAINT chk_invitations_recipient
    CHECK (email IS NOT NULL OR phone IS NOT NULL OR channel = 'link'),
  -- A sha256 digest in hex, and nothing else. Written by the API (node:crypto) rather than
  -- by the database: the raw token never reaches SQL, so no log, statement trace or dump
  -- can contain one.
  CONSTRAINT chk_invitations_token_hash
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- The flat, when there is one, must be a flat of this society — the members table's
  -- composite key, reused rather than re-derived: a denormalised `society_id` and an
  -- apartment id from another tenant would each satisfy every single-column constraint.
  CONSTRAINT fk_invitations_apartment_society
    FOREIGN KEY (apartment_id, society_id)
    REFERENCES public.apartments (id, society_id) ON DELETE CASCADE,
  CONSTRAINT chk_invitations_expiry CHECK (expires_at > created_at),
  -- A terminal state is terminal: the stamps and the state cannot disagree.
  CONSTRAINT chk_invitations_accepted_stamp
    CHECK ((status = 'accepted') = (accepted_at IS NOT NULL)),
  CONSTRAINT chk_invitations_revoked_stamp
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

ALTER TABLE public.invitations ENABLE ROW LEVEL SECURITY;
-- FORCE, like every other table in this schema (see the note in the society RLS
-- migration): without it a non-bypassing owner reads its own table without policies.
-- The two functions at the bottom are SECURITY DEFINER and owned by the migration
-- role, which is what lets them act outside RLS while a client cannot.
ALTER TABLE public.invitations FORCE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Indexes
-- ─────────────────────────────────────────────────────────────────────────────

-- The token lookup, and the single-use guard: a duplicate hash is refused by the index
-- rather than by a read that a race could pass.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invitations_token_hash
  ON public.invitations (token_hash);

-- PRD §7.2's index.
CREATE INDEX IF NOT EXISTS idx_invitations_society_status
  ON public.invitations (society_id, status);

-- Two live invitations for one recipient are refused, deterministically. `status IN
-- ('sent','opened')` is what makes the rule about *live* invitations: once one is accepted
-- or revoked, a new one for the same person is an ordinary act. `email` is `citext`, so the
-- index is case-insensitive without a `lower()` expression.
CREATE UNIQUE INDEX IF NOT EXISTS uq_invitations_live_email
  ON public.invitations (society_id, email)
  WHERE status IN ('sent', 'opened') AND email IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invitations_live_phone
  ON public.invitations (society_id, phone)
  WHERE status IN ('sent', 'opened') AND phone IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. The rules, as triggers
-- ─────────────────────────────────────────────────────────────────────────────

-- Who invited, and what they were allowed to hand out.
--
-- `invited_by` is **not** a client-settable column: a caller that could name the inviter
-- could attribute an invitation to anybody, which is the same class of bug as a client-set
-- `removed_by`. The trigger resolves it from the caller's own membership row.
--
-- The role rule reuses the domain's decision rather than restating the matrix: a Treasurer
-- holds `member.invite` but not `member.role_change`, so they may invite a Resident and
-- nothing above — and an unaddressed `link` invitation may carry `resident` only, because
-- whoever redeems it is whoever sees the link.
CREATE OR REPLACE FUNCTION public.stamp_invitation_creator()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  inviter_id uuid;
  inviter_role public.member_role;
  apartment_ok boolean;
BEGIN
  SELECT m.id, m.role
    INTO inviter_id, inviter_role
    FROM public.members m
   WHERE m.society_id = NEW.society_id
     AND m.user_id = (SELECT auth.uid())
     AND m.status = 'active'
   LIMIT 1;

  IF inviter_id IS NULL THEN
    RAISE EXCEPTION 'INVITATION_INVITER_REQUIRED'
      USING ERRCODE = 'P0001',
            HINT = 'Only an active member of this society can invite somebody.';
  END IF;

  IF NEW.role <> 'resident' AND inviter_role <> 'admin' THEN
    RAISE EXCEPTION 'INVITATION_ROLE_NOT_ASSIGNABLE'
      USING ERRCODE = 'P0001',
            HINT = 'Only a society Admin can invite somebody at a role above Resident.';
  END IF;

  IF NEW.channel = 'link' AND NEW.email IS NULL AND NEW.phone IS NULL AND NEW.role <> 'resident' THEN
    RAISE EXCEPTION 'INVITATION_OPEN_LINK_ROLE'
      USING ERRCODE = 'P0001',
            HINT = 'A shareable link invitation can only be created at the Resident role.';
  END IF;

  -- A flat that has been soft-deleted is not an address anybody can move into.
  IF NEW.apartment_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.apartments a
       WHERE a.id = NEW.apartment_id
         AND a.society_id = NEW.society_id
         AND a.deleted_at IS NULL
    ) INTO apartment_ok;
    IF NOT apartment_ok THEN
      RAISE EXCEPTION 'INVITATION_APARTMENT_INVALID'
        USING ERRCODE = 'P0001',
              HINT = 'That flat is not an available flat of this society.';
    END IF;
  END IF;

  NEW.invited_by := inviter_id;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.stamp_invitation_creator() IS
  'Fills invited_by from the caller''s own membership and refuses a role the inviter cannot hand out (member.invite vs member.role_change).';

-- Somebody with an account here is already a member; a shadow row is not.
--
-- The distinction is the point: a live *shadow* member is a recorded occupant whose phone
-- is their only identifier, and inviting them so their account can be linked is the
-- designed path. A live *account* member is already in the society, and inviting them again
-- is a mistake worth refusing — deterministically, because the API's own check would race
-- with the acceptance it is meant to prevent.
CREATE OR REPLACE FUNCTION public.chk_invitation_recipient()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Only when the recipient itself is what changed. A revocation of an invitation
  -- whose recipient has since joined would otherwise be refused by this very check —
  -- "that person is already a member" is a reason not to invite them, not a reason
  -- an invitation cannot be closed.
  IF TG_OP = 'UPDATE'
     AND NEW.email IS NOT DISTINCT FROM OLD.email
     AND NEW.phone IS NOT DISTINCT FROM OLD.phone THEN
    RETURN NEW;
  END IF;

  -- The membership row's own address is preferred, and the linked profile's is the
  -- fallback: an occupant an Admin recorded by name alone still has an account, and
  -- inviting that account by the address it signs in with is the same mistake.
  IF EXISTS (
    SELECT 1
      FROM public.members m
      LEFT JOIN public.profiles p ON p.id = m.user_id
     WHERE m.society_id = NEW.society_id
       AND m.user_id IS NOT NULL
       AND m.status <> 'removed'
       AND (
         -- `::public.citext`, spelled in full: with `search_path = ''` an unqualified
         -- `::citext` fails with "type citext does not exist" (bootstrap migration, same trap).
         (NEW.email IS NOT NULL
          AND COALESCE(m.email, p.email::text) IS NOT NULL
          AND COALESCE(m.email, p.email::text)::public.citext = NEW.email)
         OR (NEW.phone IS NOT NULL
             AND COALESCE(m.phone, p.phone) IS NOT NULL
             AND COALESCE(m.phone, p.phone) = NEW.phone)
       )
  ) THEN
    RAISE EXCEPTION 'INVITATION_RECIPIENT_ALREADY_MEMBER'
      USING ERRCODE = 'P0001',
            HINT = 'That person is already a member of this society.';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.chk_invitation_recipient() IS
  'Refuses an invitation to somebody who already has an account in the society; a shadow member stays invite-able so acceptance can link their row.';

-- The status machine, and the stamps that go with it.
--
-- The API may only ever write `revoked`; `opened` and `accepted` are written by the
-- functions below (which is what keeps the funnel honest — a client cannot claim it
-- delivered or opened anything). Anything else is refused here rather than trusted to a
-- caller, and `accepted`/`revoked` are terminal.
CREATE OR REPLACE FUNCTION public.chk_invitation_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT (
    (OLD.status = 'sent' AND NEW.status IN ('opened', 'accepted', 'revoked'))
    OR (OLD.status = 'opened' AND NEW.status IN ('accepted', 'revoked'))
  ) THEN
    RAISE EXCEPTION 'INVITATION_TRANSITION_FORBIDDEN'
      USING ERRCODE = 'P0001',
            HINT = 'That invitation has already been accepted, revoked or expired.';
  END IF;

  IF NEW.status = 'revoked' THEN
    SELECT m.id INTO NEW.revoked_by
      FROM public.members m
     WHERE m.society_id = OLD.society_id
       AND m.user_id = (SELECT auth.uid())
       AND m.status = 'active'
     LIMIT 1;
    NEW.revoked_at := now();
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.chk_invitation_transition() IS
  'The invitation status machine (sent → opened → accepted/revoked, accepted/revoked terminal) and the revocation stamps.';

DROP TRIGGER IF EXISTS stamp_invitation_creator_before_insert ON public.invitations;
CREATE TRIGGER stamp_invitation_creator_before_insert
  BEFORE INSERT ON public.invitations
  FOR EACH ROW EXECUTE FUNCTION public.stamp_invitation_creator();

DROP TRIGGER IF EXISTS chk_invitation_recipient_before_write ON public.invitations;
CREATE TRIGGER chk_invitation_recipient_before_write
  BEFORE INSERT OR UPDATE ON public.invitations
  FOR EACH ROW EXECUTE FUNCTION public.chk_invitation_recipient();

DROP TRIGGER IF EXISTS chk_invitation_transition_before_update ON public.invitations;
CREATE TRIGGER chk_invitation_transition_before_update
  BEFORE UPDATE ON public.invitations
  FOR EACH ROW EXECUTE FUNCTION public.chk_invitation_transition();

DROP TRIGGER IF EXISTS touch_invitations_updated_at ON public.invitations;
CREATE TRIGGER touch_invitations_updated_at
  BEFORE UPDATE ON public.invitations
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. RLS and grants
-- ─────────────────────────────────────────────────────────────────────────────

-- Row Level Security: a member-manager sees their society's invitations, and nobody sees
-- anybody else's. There is deliberately **no policy for the invitee** — an invitee has no
-- membership to be scoped by, and reading their invitation goes through
-- `invitation_preview()` below, which returns a masked projection rather than a row.
DROP POLICY IF EXISTS invitations_select_manager ON public.invitations;
CREATE POLICY invitations_select_manager
  ON public.invitations
  FOR SELECT
  TO authenticated
  USING (public.is_society_member_manager(society_id));

DROP POLICY IF EXISTS invitations_insert_manager ON public.invitations;
CREATE POLICY invitations_insert_manager
  ON public.invitations
  FOR INSERT
  TO authenticated
  WITH CHECK (public.is_society_member_manager(society_id));

-- Revocation only, and only the status column (see the grant): the stamps are the trigger's
-- and the rest of the row is history.
DROP POLICY IF EXISTS invitations_update_manager ON public.invitations;
CREATE POLICY invitations_update_manager
  ON public.invitations
  FOR UPDATE
  TO authenticated
  USING (public.is_society_member_manager(society_id))
  WITH CHECK (public.is_society_member_manager(society_id));

-- Supabase grants `anon`/`authenticated` ALL on new tables in `public` by default —
-- this schema's `ALTER DEFAULT PRIVILEGES` does too — so these REVOKEs are not
-- ceremony: without them the table-wide SELECT would simply contain `token_hash`,
-- and the column grant below would be decoration.
REVOKE ALL ON public.invitations FROM anon;
REVOKE ALL ON public.invitations FROM authenticated;

-- Column grants, and the omissions are the design:
--
--   * `token_hash` is absent from SELECT — a hash is not a credential, but there is no
--     screen that needs one and a column nobody can read is a column nobody can leak;
--   * `invited_by`, `status`, `opened_at`, `accepted_*`, `revoked_*`, `id`, `created_at` and
--     `updated_at` are absent from INSERT — they are the triggers' and the functions';
--   * UPDATE is one column: the transition trigger decides what it may become and stamps it.
GRANT SELECT (
  id, society_id, apartment_id, invited_by, channel, phone, email, role, status,
  expires_at, opened_at, accepted_at, accepted_by, revoked_at, revoked_by, created_at, updated_at
) ON public.invitations TO authenticated;

GRANT INSERT (
  society_id, apartment_id, channel, phone, email, role, token_hash, expires_at
) ON public.invitations TO authenticated;

GRANT UPDATE (status) ON public.invitations TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Preview — public, masked, and the funnel's second step
-- ─────────────────────────────────────────────────────────────────────────────

-- Takes the **hash**, not the token: the API hashes at its edge, so the raw token exists in
-- exactly two places — the invitee's link and the response that created it. That also keeps
-- pgcrypto out of the picture: hashing is node:crypto's job at the boundary.
--
-- Returns a *projection*, never a row: the society's name, the role, the flat's number, the
-- masked recipient and the state. An unknown hash is the only error — a valid-but-dead
-- invitation is a `status` the client can explain, which is the difference between "this
-- link is wrong" and "this link expired".
CREATE OR REPLACE FUNCTION public.invitation_preview(p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  invitation public.invitations;
  society_name text;
  apartment_number text;
  invitee_hint text;
  is_expired boolean;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND'
      USING ERRCODE = 'P0001',
            HINT = 'That invitation link is not valid.';
  END IF;

  SELECT * INTO invitation
    FROM public.invitations i
   WHERE i.token_hash = p_token_hash
   LIMIT 1;

  IF invitation.id IS NULL THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND'
      USING ERRCODE = 'P0001',
            HINT = 'That invitation link is not valid.';
  END IF;

  -- The funnel's second step, and only the second step: `sent → opened` happens on the
  -- first preview, never twice, and never over a decision the recipient has already made.
  UPDATE public.invitations i
     SET status = 'opened',
         opened_at = now()
   WHERE i.id = invitation.id
     AND i.status = 'sent';

  -- Re-read, because the row this function is about to describe is the one the UPDATE
  -- above just wrote. (Returning the pre-update snapshot is how a preview reports
  -- "sent" for an invitation it has itself just opened — found by the canary.)
  SELECT * INTO invitation FROM public.invitations i WHERE i.id = invitation.id;

  SELECT s.name INTO society_name FROM public.societies s WHERE s.id = invitation.society_id;

  IF invitation.apartment_id IS NOT NULL THEN
    SELECT a.apartment_number INTO apartment_number
      FROM public.apartments a
     WHERE a.id = invitation.apartment_id;
  END IF;

  -- Masked on purpose: a preview is reachable by whoever holds the link, and it must
  -- confirm *who* the invitation is for without disclosing the address or number to
  -- somebody else. Enough to recognise, not enough to harvest.
  invitee_hint := CASE
    WHEN invitation.email IS NOT NULL THEN
      left(invitation.email::text, 2) || '***@' || split_part(invitation.email::text, '@', 2)
    WHEN invitation.phone IS NOT NULL THEN
      '••••' || right(invitation.phone, 4)
    ELSE 'Anyone with this link'
  END;

  is_expired := invitation.expires_at <= now()
    AND invitation.status IN ('sent', 'opened');

  RETURN jsonb_build_object(
    'id', invitation.id,
    'society_id', invitation.society_id,
    'society_name', society_name,
    'role', invitation.role,
    'apartment_id', invitation.apartment_id,
    'apartment_number', apartment_number,
    'channel', invitation.channel,
    'invitee_hint', invitee_hint,
    'requires_account_match', invitation.email IS NOT NULL OR invitation.phone IS NOT NULL,
    -- Expiry masks a *live* invitation and nothing else: an invitation that was
    -- revoked is revoked, even if the fourteenth day also passed.
    'status', CASE WHEN is_expired THEN 'expired' ELSE invitation.status END,
    'expired', is_expired,
    'expires_at', invitation.expires_at,
    'apartment_addressable', invitation.apartment_id IS NOT NULL
  );
END;
$$;

COMMENT ON FUNCTION public.invitation_preview(text) IS
  'Public, masked invitation preview keyed by the token hash; marks sent → opened on first open (PRD §3.3''s funnel).';

REVOKE ALL ON FUNCTION public.invitation_preview(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invitation_preview(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.invitation_preview(text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Acceptance — atomic, single-use, and it links rather than duplicates
-- ─────────────────────────────────────────────────────────────────────────────

-- One transaction, one lock, one truth:
--
--   * `SELECT … FOR UPDATE` serialises two simultaneous accepts, so the second sees
--     `accepted` and is refused — the single-use rule is a lock, not a read;
--   * the recipient check is against the *profile* (email or phone), and an unaddressed
--     `link` invitation accepts the token itself as the credential;
--   * an existing live membership is never duplicated: an active one is refused as
--     "already a member", a pending/inactive one is activated in place, and a live **shadow**
--     row matched by phone is linked (PRD §3.3's "linked when that phone signs up");
--   * the membership write goes through the table's own triggers — `chk_role_caps()` still
--     refuses a fourth admin, `uq_members_shadow_phone` still refuses a duplicate number —
--     so an invitation cannot become a way around a rule the member module enforces.
--
-- The identity is cleared before the write, and that is deliberate rather than clever: the
-- caller *is* the invitee, and `chk_member_self_change()` refuses a self-service role or
-- status change — correctly, for every other path. Here the invitation is the authority, so
-- the function finishes as "the system": it has already checked the token, the state, the
-- expiry and that the actor is the intended recipient. The GUCs are session settings, so
-- this lasts for the rest of this transaction only, and the API runs acceptance in a
-- transaction of its own.
CREATE OR REPLACE FUNCTION public.invitation_accept(p_token_hash text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  invitation public.invitations;
  profile public.profiles;
  member_id uuid;
  member_status public.member_status;
  linked_shadow boolean := false;
BEGIN
  -- The caller must be the actor. The API reads the id from the verified JWT rather
  -- than from the request body, but a definer function that trusted a parameter
  -- would let anybody holding the link accept it *on behalf of* the intended
  -- recipient — so the parameter is checked against the session's identity here,
  -- before anything is cleared or written.
  IF p_actor IS NULL OR p_actor IS DISTINCT FROM (SELECT auth.uid()) THEN
    RAISE EXCEPTION 'INVITATION_ACCEPT_DENIED'
      USING ERRCODE = 'P0001',
            HINT = 'Sign in as the invited account to accept an invitation.';
  END IF;

  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND'
      USING ERRCODE = 'P0001',
            HINT = 'That invitation link is not valid.';
  END IF;

  SELECT * INTO invitation
    FROM public.invitations i
   WHERE i.token_hash = p_token_hash
   FOR UPDATE;

  IF invitation.id IS NULL THEN
    RAISE EXCEPTION 'INVITATION_NOT_FOUND'
      USING ERRCODE = 'P0001',
            HINT = 'That invitation link is not valid.';
  END IF;

  IF invitation.status NOT IN ('sent', 'opened') THEN
    RAISE EXCEPTION 'INVITATION_NOT_ACCEPTABLE'
      USING ERRCODE = 'P0001',
            HINT = 'That invitation has already been accepted or revoked.';
  END IF;

  IF invitation.expires_at <= now() THEN
    RAISE EXCEPTION 'INVITATION_EXPIRED'
      USING ERRCODE = 'P0001',
            HINT = 'That invitation has expired. Ask an Admin for a new one.';
  END IF;

  SELECT * INTO profile FROM public.profiles p WHERE p.id = p_actor;

  -- Where the product requires a match (PRD §3.3's targeted invite), the account must be
  -- the intended one. An unaddressed link has no recipient to match, by construction.
  IF invitation.email IS NOT NULL
     AND (profile.email IS NULL OR profile.email::public.citext <> invitation.email) THEN
    RAISE EXCEPTION 'INVITATION_RECIPIENT_MISMATCH'
      USING ERRCODE = 'P0001',
            HINT = 'That invitation is for a different person. Sign in with the invited account.';
  END IF;

  IF invitation.phone IS NOT NULL AND invitation.email IS NULL
     AND (profile.phone IS NULL OR profile.phone <> invitation.phone) THEN
    RAISE EXCEPTION 'INVITATION_RECIPIENT_MISMATCH'
      USING ERRCODE = 'P0001',
            HINT = 'That invitation is for a different person. Sign in with the invited account.';
  END IF;

  SELECT m.id, m.status INTO member_id, member_status
    FROM public.members m
   WHERE m.society_id = invitation.society_id
     AND m.user_id = p_actor
   LIMIT 1;

  IF member_id IS NOT NULL AND member_status = 'active' THEN
    RAISE EXCEPTION 'INVITATION_ALREADY_MEMBER'
      USING ERRCODE = 'P0001',
            HINT = 'You are already a member of this society.';
  END IF;

  IF member_id IS NOT NULL AND member_status = 'removed' THEN
    -- The row keeps its history and its unique key, so re-joining is the join queue's or an
    -- Admin's act (T049), not an invitation's: silently resurrecting it would hide a
    -- removal from the person who performed it.
    RAISE EXCEPTION 'INVITATION_MEMBERSHIP_REMOVED'
      USING ERRCODE = 'P0001',
            HINT = 'This membership was removed. Ask an Admin to reinstate it.';
  END IF;

  -- The invitee's own row, out of the way of the self-service guards.
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '', true);

  IF member_id IS NULL THEN
    -- A shadow member matched by the invitation's number: link the row rather than record
    -- the person twice (PRD §3.3).
    SELECT m.id INTO member_id
      FROM public.members m
     WHERE m.society_id = invitation.society_id
       AND m.user_id IS NULL
       AND m.status <> 'removed'
       AND invitation.phone IS NOT NULL
       AND m.phone = invitation.phone
     LIMIT 1;

    linked_shadow := member_id IS NOT NULL;
  END IF;

  IF member_id IS NULL THEN
    INSERT INTO public.members (
      society_id, user_id, display_name, phone, email, role, status, occupancy,
      apartment_id, joined_at, approved_by
    )
    VALUES (
      invitation.society_id,
      p_actor,
      left(COALESCE(NULLIF(btrim(profile.full_name), ''), 'Member'), 120),
      COALESCE(profile.phone, invitation.phone),
      COALESCE(profile.email, invitation.email::text),
      invitation.role,
      'active',
      'owner_occupied',
      invitation.apartment_id,
      now(),
      invitation.invited_by
    )
    RETURNING id INTO member_id;
  ELSE
    UPDATE public.members m
       SET status = 'active',
           role = invitation.role,
           user_id = p_actor,
           apartment_id = COALESCE(invitation.apartment_id, m.apartment_id),
           joined_at = COALESCE(m.joined_at, now()),
           approved_by = invitation.invited_by
     WHERE m.id = member_id;
  END IF;

  UPDATE public.invitations i
     SET status = 'accepted',
         accepted_at = now(),
         accepted_by = p_actor
   WHERE i.id = invitation.id;

  RETURN jsonb_build_object(
    'society_id', invitation.society_id,
    'member_id', member_id,
    'role', invitation.role,
    'apartment_id', invitation.apartment_id,
    'linked_shadow', linked_shadow
  );
END;
$$;

COMMENT ON FUNCTION public.invitation_accept(text, uuid) IS
  'Atomic, single-use acceptance: locks the invitation, validates state/expiry/recipient, activates, links or creates exactly one membership, and marks the invitation accepted.';

REVOKE ALL ON FUNCTION public.invitation_accept(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.invitation_accept(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.invitation_accept(text, uuid) TO authenticated;
