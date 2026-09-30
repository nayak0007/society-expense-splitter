-- ============================================================================
-- Fix · `chk_role_caps()` judged admission on the row's *old* state
-- ============================================================================
--
-- The regression, and where it came from:
--
--   * T049's `member_approve_join()` admits a request with **one** update that
--     sets `status = 'active'` and `role = <the role the approver chose>`
--     together — the documented "corrected role" path (Roadmap T049: "approve
--     (as-requested defaults, corrected role and flat)").
--   * T046's `chk_role_caps()` refuses any role change while `OLD.status` is
--     `pending`, `rejected` or `removed`. It was written when the only admission
--     was an INSERT (`invitation_accept()`), so its test looked at the row's
--     **pre-image**. An UPDATE that admits therefore tripped it:
--     `MEMBER_ROLE_CHANGE_FORBIDDEN` on every corrected-role approval — including
--     a correction to `admin` or `treasurer`, where the write is exactly what the
--     cap section below has to count.
--   * Nothing above the database could see it: the approval RPC *is* the write
--     path, the API's unit tests mock the repository, and the e2e queue suite runs
--     against a fake one. It took a repository integration test against real
--     PostgreSQL, with the real trigger installed, to produce the refusal.
--
-- The rule the guard states — "a role may not be handed to somebody who has not
-- been admitted" — is about the membership the write **produces**: an approval
-- admits the person in the same statement that settles their role, exactly as
-- `invitation_accept()` does with an INSERT. So the refusal also asks whether the
-- write leaves the row un-admitted (`NEW.status <> 'active'`), and the admission
-- transition falls through to the cap section, unchanged.
--
-- Why the guard and not the transition: `member_approve_join()`'s write is one
-- legal final state, not an invalid intermediate one. Splitting it into
-- "activate at the requested role, then change the role" would leave the rule
-- misstated for every future admission path and would write a state nobody asked
-- for — the member active at the role the approver had just corrected away.
--
-- What is deliberately NOT changed:
--
--   * the cap section, its count, its hints and the per-society advisory lock
--     (`lock_society_membership_writes()`) that makes two concurrent promotions
--     serialise. A corrected-role approval to `admin`/`treasurer` still takes that
--     lock and is still refused when the cap is full;
--   * the refusal itself for a role change that leaves a membership `pending`,
--     `rejected` or `removed`: `setRole` on a request row still fails, which is
--     what `checkRoleTarget` states one layer above.
--
-- ── down ────────────────────────────────────────────────────────────────────
--   Re-apply `chk_role_caps()` from
--   `20260928120000_membership_write_concurrency.sql` — which reintroduces the
--   refusal of every corrected-role approval.
-- ============================================================================

-- Body unchanged from `20260928120000_membership_write_concurrency.sql` except
-- the `NEW.status <> 'active'` clause and the comment above it. When that copy
-- changes, both must.
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
  --
  -- `NEW.status <> 'active'` is what makes the rule hold for the *resulting*
  -- membership: a write that admits the row (`member_approve_join()`, pending →
  -- active, with the approver's role in the same statement) is an approval, not a
  -- role handed to a non-member, and it is the caps below — not this clause —
  -- that govern it. A write that leaves the row pending, rejected or removed is
  -- refused exactly as before.
  IF TG_OP = 'UPDATE'
     AND NEW.role IS DISTINCT FROM OLD.role
     AND OLD.status IN ('pending', 'rejected', 'removed')
     AND NEW.status <> 'active' THEN
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
  'Refuses a write that would exceed PRD §2.2''s caps (3 active admins, 2 active treasurers), and refuses a role change that leaves a membership pending, rejected or removed. A write that admits the row in the same statement (the join approval) is cap-checked, not refused. Serialised per society, so two concurrent promotions cannot both pass.';
