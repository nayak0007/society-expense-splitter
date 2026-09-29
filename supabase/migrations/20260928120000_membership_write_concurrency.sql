-- ============================================================================
-- T051 · Concurrency: membership-population invariants and the accept collision
-- ============================================================================
--
-- The Phase 3 audit classified every check-then-write sequence in the membership
-- paths. Most were already safe, and the reason is worth stating because it is
-- what this migration does NOT change:
--
--   * two accepts of the **same** invitation serialise on that row
--     (`invitation_accept()` takes `FOR UPDATE` and re-reads the status), so the
--     second sees `accepted` and is refused — single-use is a lock, not a read;
--   * two decisions on the **same** join request serialise the same way
--     (`member_approve_join()` locks the member row and re-checks
--     `status = 'pending'`);
--   * a duplicate *membership* is refused by `members_society_user_key`, a
--     duplicate *shadow phone* by `uq_members_shadow_phone`, a duplicate flat by
--     `uq_apartments_building_number`, a duplicate building name by
--     `uq_buildings_society_name`, a duplicate live invitation by
--     `uq_invitations_live_email` / `uq_invitations_live_phone`, and a second
--     primary occupant by `uq_primary_occupant`. Those are constraints, so they
--     hold under concurrency by construction.
--
-- Three refusals did not have that property. A **cap** and a **presence
-- invariant** are counted over a population, and no single row can see a
-- population: `chk_role_caps()` and `chk_admin_present()` both ran a plain
-- `SELECT count(*)` under READ COMMITTED, so two transactions on *different*
-- rows each counted the other's pre-state and both committed. And
-- `invitation_accept()` wrote the membership without a handler, so a collision
-- that serialised execution refuses with a named error (`INVITATION_ALREADY_MEMBER`)
-- but a collision caused by a *race* raised a raw `23505` — the same situation
-- answered two different ways depending on timing.
--
-- What this migration does, and why each piece is the narrow tool:
--
--   1. `lock_society_membership_writes()` — a **transaction-scoped advisory
--      lock keyed on one society**. It is not a table lock and not a distributed
--      mutex: it serialises the writes that can break a per-society population
--      invariant, and only those writes take it. Different societies never
--      contend, and the lock is released by COMMIT/ROLLBACK like any other.
--      One key per society (rather than one per role) is deliberate: a promotion
--      and a demotion in the same society must be ordered against each other
--      too, and a single key cannot deadlock against itself. Advisory locks are
--      re-entrant within a transaction, so a transaction that writes two rows
--      takes it twice and releases it once, at the end.
--
--   2. `chk_role_caps()` — takes the lock **before** its count, and only on the
--      path that actually counts (an unrelated update of a member's name still
--      returns before any lock is taken, so the common write is untouched).
--
--   3. `chk_admin_present()` — same. It is deferred to COMMIT, and an advisory
--      lock taken there is still part of that transaction, which is exactly what
--      is needed: the two transactions that could each see the other as the
--      remaining Admin are now ordered.
--
--   4. `invitation_accept()` — keeps its row lock and its named refusals, and
--      additionally translates a `23505` on `members_society_user_key` into the
--      `INVITATION_ALREADY_MEMBER` the sequential path already raises. Anything
--      else re-raises untouched, so this stays a translation rather than a
--      blanket catch.
--
-- Deliberately NOT changed, because a different tool would be inventing a rule:
--
--   * **No new uniqueness on `(society_id, phone)` for account rows.** The
--     database deliberately enforces phone uniqueness only among *shadow*
--     members (`uq_members_shadow_phone`), and `join_request_blocking_shadow()`
--     refuses only the shadow case; two accounts may share a number. Widening
--     the index would forbid something the product allows, so the residual
--     "an account row and an import row carrying one number" case is recorded
--     rather than closed here.
--   * **No slug change here.** The slug's uniqueness is a constraint and holds
--     under concurrency; what differs is only *which* outcome a same-name race
--     produces, and that is fixed on the caller's side (a bounded retry in the
--     repository, mirroring the join-code retry that already exists) rather than
--     by weakening or widening the rule.
--
-- ACLs are unchanged: `CREATE OR REPLACE FUNCTION` preserves them, so the
-- revoke-from-PUBLIC / grant-to-authenticated surface established by the
-- original migrations still stands. The one new function is internal and is
-- revoked from every client role.
--
-- ── down ────────────────────────────────────────────────────────────────────
--   Re-apply `chk_role_caps()` from `20260925130000_member_roles.sql`,
--   `chk_admin_present()` from `20260920130000_society_core.sql` and
--   `invitation_accept(text, uuid)` from `20260926120000_invitations.sql`
--   (their bodies are unchanged apart from the additions below), then:
--   REVOKE ALL ON FUNCTION public.lock_society_membership_writes(uuid) FROM PUBLIC;
--   DROP FUNCTION IF EXISTS public.lock_society_membership_writes(uuid);
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The lock
-- ─────────────────────────────────────────────────────────────────────────────

-- One namespace for "membership population invariants", one key per society. The
-- uuid is folded to 32 bits because the two-argument advisory form takes `int`;
-- two societies sharing a key would only serialise against each other (slower,
-- never wrong), and the mapping is deterministic so every path derives the same
-- key from the same society.
--
-- `VOLATILE` (the default) is required: a `STABLE`/`IMMUTABLE` function may be
-- folded or skipped by the planner, and a lock that the planner is allowed to
-- evaluate once is not a lock.
CREATE OR REPLACE FUNCTION public.lock_society_membership_writes(
  p_society_id uuid
)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = ''
AS $$
  SELECT pg_advisory_xact_lock(
    847212,
    ('x' || substr(replace(p_society_id::text, '-', ''), 1, 8))::bit(32)::int
  );
$$;

COMMENT ON FUNCTION public.lock_society_membership_writes(uuid) IS
  'Serialises the writes that can break a per-society membership invariant (role caps, an active Admin). Transaction-scoped; internal — revoked from every client role.';

REVOKE ALL ON FUNCTION public.lock_society_membership_writes(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_society_membership_writes(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.lock_society_membership_writes(uuid) FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The role caps, under concurrency
-- ─────────────────────────────────────────────────────────────────────────────

-- Body unchanged from `20260925130000_member_roles.sql` apart from the lock: the
-- refusal, the hint, the not-admitted rule and the "only a real change counts"
-- early returns are all as they were. The lock joins them *after* every early
-- return, so an ordinary update (a name, an occupancy, a lease date) never waits
-- on a lock it does not need.
CREATE OR REPLACE FUNCTION public.chk_role_caps()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  active_holders int;
  cap int;
BEGIN
  -- ── a role may not be handed to somebody who has not been admitted ─────────
  --
  -- `pending` and `rejected` are the two states that are *before* membership:
  -- giving one a role would grant powers to a person the society has not accepted.
  -- `removed` is after it. `inactive` is deliberately allowed — a suspended
  -- treasurer being reinstated at a lower role is an ordinary act.
  --
  -- Only a role *change* is refused; a status change on its own is the join
  -- queue's or the removal path's business, and both already refuse what they must.
  IF TG_OP = 'UPDATE'
     AND NEW.role IS DISTINCT FROM OLD.role
     AND OLD.status IN ('pending', 'rejected', 'removed') THEN
    RAISE EXCEPTION 'MEMBER_ROLE_CHANGE_FORBIDDEN'
      USING ERRCODE = 'P0001',
            HINT = 'That membership is not active, so its role cannot be changed.';
  END IF;

  -- ── the caps ───────────────────────────────────────────────────────────────
  --
  -- Nothing to check unless the row becomes (or already is) an *active* holder of
  -- a capped role AND that is what changed. The last clause matters: an unrelated
  -- update of an admin's name must not trip a cap that a pre-existing row just
  -- happens to breach, or the society could not fix anything about that member
  -- until it appointed no one — a deadlock that repairs nothing.
  IF NEW.status <> 'active' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.role = OLD.role
     AND NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.role = 'admin' THEN
    cap := 3;
  ELSIF NEW.role = 'treasurer' THEN
    cap := 2;
  ELSE
    RETURN NEW;
  END IF;

  -- THE CONCURRENCY FIX. `count(*)` is not a lock: two transactions writing two
  -- *different* members both see the pre-state and both pass. Taking the
  -- society's membership lock first makes the count and the write atomic with
  -- respect to every other write that can change the count, so the second writer
  -- counts the first one's committed row and is refused — one winner, one
  -- `SOCIETY_ROLE_CAP_EXCEEDED`, identically whether the two requests arrive
  -- together or a second apart.
  PERFORM public.lock_society_membership_writes(NEW.society_id);

  SELECT count(*) INTO active_holders
    FROM public.members m
   WHERE m.society_id = NEW.society_id
     AND m.role        = NEW.role
     AND m.status      = 'active'
     -- The row being written is excluded, so re-assigning a member the role they
     -- already hold counts once rather than twice, and an INSERT (which has no
     -- row yet) counts every existing holder.
     AND m.id         <> NEW.id;

  IF active_holders >= cap THEN
    RAISE EXCEPTION 'SOCIETY_ROLE_CAP_EXCEEDED'
      USING ERRCODE = 'P0001',
            HINT = CASE NEW.role
                     WHEN 'admin' THEN 'A society can have at most 3 admins.'
                     ELSE 'A society can have at most 2 treasurers.'
                   END;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.chk_role_caps() IS
  'Refuses a write that would exceed PRD §2.2''s caps (3 active admins, 2 active treasurers), and refuses a role change on a membership that is pending, rejected or removed. Serialised per society, so two concurrent promotions cannot both pass.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The last active Admin, under concurrency
-- ─────────────────────────────────────────────────────────────────────────────

-- Body unchanged from `20260920130000_society_core.sql` apart from the lock.
-- Deferred to COMMIT by its constraint trigger, so the lock is taken at commit
-- time — still inside the transaction that is committing, which is what orders
-- two transactions that would each have seen the other as the remaining Admin.
-- It is taken after the three early returns (a non-admin row, an update that
-- keeps the row an active admin, and a society that is itself gone or
-- soft-deleted), so nothing but a genuine removal pays for it.
CREATE OR REPLACE FUNCTION public.chk_admin_present()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  remaining int;
BEGIN
  -- Only a write that removes an *active admin* can orphan a society.
  IF OLD.role <> 'admin' OR OLD.status <> 'active' THEN
    RETURN NULL;
  END IF;

  -- The row is still an active admin (a name change, an occupancy edit): nothing
  -- was lost, so an ordinary update of an admin must not trip this.
  IF TG_OP = 'UPDATE'
     AND NEW.society_id = OLD.society_id
     AND NEW.role = 'admin'
     AND NEW.status = 'active' THEN
    RETURN NULL;
  END IF;

  -- A cascade from the society itself (hard delete) and a soft-deleted tenant are
  -- neither of them an orphaning: there is no live society left to administer.
  -- Without the deleted_at test, `society_soft_delete()` — which removes every
  -- membership — could never commit.
  IF NOT EXISTS (
    SELECT 1 FROM public.societies s
     WHERE s.id = OLD.society_id AND s.deleted_at IS NULL
  ) THEN
    RETURN NULL;
  END IF;

  -- THE CONCURRENCY FIX, for the same reason as the caps above: two Admins
  -- demoting each other concurrently each counted the other as "remaining" and
  -- both committed, leaving the society with none. Same lock, so a demotion is
  -- also ordered against a promotion in the same society.
  PERFORM public.lock_society_membership_writes(OLD.society_id);

  SELECT count(*) INTO remaining
    FROM public.members m
   WHERE m.society_id = OLD.society_id
     AND m.role = 'admin'
     AND m.status = 'active'
     AND m.id <> OLD.id;

  IF remaining = 0 THEN
    RAISE EXCEPTION 'SOCIETY_ADMIN_REQUIRED'
      USING ERRCODE = 'P0001',
            HINT = 'Promote another member to Admin before leaving or changing this role.';
  END IF;
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.chk_admin_present() IS
  'Refuses a commit that would leave a society with no active admin (Phase 3 DoD). Deferred, so promote-and-replace in one transaction is allowed; serialised per society, so two concurrent demotions cannot both pass.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Acceptance: the membership collision that a race produces
-- ─────────────────────────────────────────────────────────────────────────────

-- Body unchanged from `20260926120000_invitations.sql` apart from the exception
-- block around the membership write. Everything else — the actor check, the token
-- shape, the row lock, the state/expiry/recipient refusals, the already-member and
-- removed-membership refusals, the shadow-link, the role/status write and the
-- acceptance stamp — is reproduced verbatim so the two migrations cannot drift.
--
-- Why the handler is needed at all: the read above (`member_id` for this
-- (society, actor)) is a check, and the write below is a write. The read cannot
-- see a membership that another transaction has not committed yet, and two
-- *different* invitations to one recipient are two rows, so they do not lock each
-- other. The write is therefore the place the collision actually surfaces, as a
-- `23505` on `members_society_user_key`.
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
  violated_constraint text;
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

  BEGIN
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
  EXCEPTION
    WHEN unique_violation THEN
      -- The one collision this function can lose a race to. Two *different* invitations
      -- to one recipient (accepting either creates the membership), or the recipient's
      -- membership created behind this call by the join queue, an Admin or an import,
      -- between the read above and this write.
      --
      -- It is translated rather than surfaced, because the sequential case is refused
      -- with `INVITATION_ALREADY_MEMBER` and a caller must not get a different answer
      -- depending on whether the other request happened to land a millisecond earlier.
      -- Only that constraint is translated: anything else re-raises unchanged, so a
      -- future unique index on this table cannot be silently mislabelled here.
      GET STACKED DIAGNOSTICS violated_constraint = CONSTRAINT_NAME;
      IF violated_constraint = 'members_society_user_key' THEN
        RAISE EXCEPTION 'INVITATION_ALREADY_MEMBER'
          USING ERRCODE = 'P0001',
                HINT = 'You are already a member of this society.';
      END IF;
      RAISE;
  END;

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
  'Atomic, single-use acceptance: locks the invitation, validates state/expiry/recipient, activates, links or creates exactly one membership, and marks the invitation accepted. A membership collision lost to a concurrent flow (a different invitation, the join queue, an Admin, an import) is refused with INVITATION_ALREADY_MEMBER rather than a raw unique violation.';
