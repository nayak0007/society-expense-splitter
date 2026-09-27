-- ============================================================================
-- T046 · Role management — the write path, the caps and the admin-presence lock
-- ============================================================================
--
-- What this migration, together with the rules already in place, guarantees:
--
--   1. A role can be written at all — `role` was deliberately absent from every
--      GRANT until now, so no client could set one. It joins the UPDATE list on
--      exactly one column.
--   2. Only an active Admin of the society may write it (the existing
--      `members_update_self_or_admin` policy, unchanged).
--   3. Nobody may change their OWN role (`chk_member_self_change()`, unchanged —
--      the escalation PRD §13 names).
--   4. A society always keeps an active Admin (`chk_admin_present()`, unchanged,
--      deferred).
--   5. PRD §2.2's caps hold as counts: at most 3 active admins, 2 active
--      treasurers. Enforced here because no single row can see a population, and
--      re-checked by a BEFORE trigger on every write rather than only in the API.
--   6. A membership that has not been admitted (pending / rejected → later
--      suspended? no: only the not-admitted states) cannot be given a role.
--
-- What this migration deliberately does NOT do, because it belongs to a task that
-- is not this one:
--
--   * **No audit table** (T050) and no before/after row. Roadmap T046's acceptance
--     asks for one; the API records the change in its logs and the trigger stamps
--     `updated_at`, and the structured audit entry is still outstanding.
--   * **No notification** to the affected member or to other admins.
--   * **No acceptance step for an admin transfer** (PRD §2.2: "transfer requires
--     the new admin to accept"). Acceptance needs a pending-transfer record to
--     accept against; promoting somebody here promotes them immediately. Stated
--     here rather than assumed, because a society that believes a consent step
--     exists when it does not is the failure mode that matters.
--   * **No `roles` / `role_permissions` tables.** Grants are a fixed role→action
--     matrix in `@ses/domain` (SAD §9.3: "This function is the single source of
--     truth"), mirrored by the policies. A table could hold a row the matrix does
--     not imply, and the guard — not the table — is what would win.
--
-- ── down ────────────────────────────────────────────────────────────────────
--   REVOKE UPDATE (role) ON public.members FROM authenticated;
--   DROP TRIGGER IF EXISTS chk_role_caps_before_write ON public.members;
--   DROP FUNCTION IF EXISTS public.chk_role_caps();
--   DROP INDEX IF EXISTS public.idx_members_society_role_active;
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The write
-- ─────────────────────────────────────────────────────────────────────────────

-- One column, and it is the whole feature: before this line a role could only be
-- set by a migration or the service role.
--
-- Three existing mechanisms make the grant safe rather than merely convenient:
--
--   * `members_update_self_or_admin` (RLS) decides WHOSE row may be written — the
--     caller's own, or any row of a society they actively administer;
--   * `chk_member_self_change()` decides whether a *self* write may touch the
--     column at all, and raises `MEMBER_ROLE_CHANGE_FORBIDDEN` when it may not;
--   * the trigger below decides whether the new value is allowed to exist.
--
-- Roles are stored through `members.role`, never through a join table, because
-- PRD §2 scopes a role to a membership and the row already *is* that membership.
GRANT UPDATE (role) ON public.members TO authenticated;

COMMENT ON COLUMN public.members.role IS
  'The membership''s role (PRD §7.1). Writable since T046, by an active Admin of the same society and never on their own row; PRD §2.2''s caps (3 admins, 2 treasurers) are enforced by chk_role_caps().';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The caps
-- ─────────────────────────────────────────────────────────────────────────────

-- The count behind PRD §2.2 ("up to 3 admins allowed", treasurer "maximum 2"),
-- made cheap and exact: `active` only, and only the two capped roles — a partial
-- index a few dozen rows wide in a society of any size.
--
-- Partial on purpose, twice over: a suspended treasurer does not occupy a slot
-- (they cannot act, and counting them would leave a society unable to appoint a
-- replacement), and `removed` members are history rather than population.
CREATE INDEX IF NOT EXISTS idx_members_society_role_active
  ON public.members (society_id, role)
  WHERE status = 'active';

-- The caps, at the database level, for the same reason `chk_admin_present()` is
-- there: the use case counts and then writes, and two admins promoting at the same
-- moment would each pass their own read. An immediate BEFORE trigger rather than
-- the deferred constraint the presence check uses — a *cap* is a limit on the
-- state the row is in the moment it is written, and there is no legitimate
-- transaction that passes through "three treasurers" on its way to two.
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
  'Refuses a write that would exceed PRD §2.2''s caps (3 active admins, 2 active treasurers), and refuses a role change on a membership that is pending, rejected or removed.';

DROP TRIGGER IF EXISTS chk_role_caps_before_write ON public.members;
CREATE TRIGGER chk_role_caps_before_write
  BEFORE INSERT OR UPDATE ON public.members
  FOR EACH ROW EXECUTE FUNCTION public.chk_role_caps();
