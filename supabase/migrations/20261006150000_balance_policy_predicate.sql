-- ─────────────────────────────────────────────────────────────────────────────
-- 20261006150000_balance_policy_predicate.sql — T067 follow-up
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT THIS FILE FIXES. `20261006120000_member_balances.sql` gave
-- `member_balances` the same own-row-or-manager policy T060 applied to `dues`,
-- and called `public.can_publish_expenses(society_id)` directly in it. That was
-- the correct *rule* and the wrong *dependency*: an RLS policy's expression is a
-- database object, so the call is recorded in `pg_depend` — and
-- `20261001120000_expense_schema.sql`'s documented Down block ends with
-- `DROP FUNCTION IF EXISTS public.can_publish_expenses(uuid)`, which PostgreSQL
-- then refuses ("cannot drop function … because other objects depend on it")
-- for as long as a policy on a table that block does not drop is still calling
-- it. T060's schema spec executes exactly that block, so T067 broke a T060 test
-- without touching a T060 object — a dependency defect only a real database
-- shows.
--
-- The fix keeps the rule in one place and breaks the object dependency: this
-- file adds `public.can_view_balances(uuid)` — the same `can_*` predicate
-- pattern T060 established for `can_view_expenses`/`can_draft_expenses`/
-- `can_publish_expenses` — and the policy calls that. The wrapper's body is
-- plpgsql, and a plpgsql body reference is **not** a `pg_depend` dependency, so
-- `can_publish_expenses` can be dropped and re-created by the T060 rehearsal
-- while the policy keeps asking the same question. (The manager rule is not
-- duplicated: the wrapper delegates to the T060 predicate rather than
-- re-stating the role check.)
--
-- The policy is replaced, not supplemented: `member_balances` must have exactly
-- one SELECT policy, and the previous one is dropped first so its dependency
-- disappears with it.
--
-- Down (run by hand — the runner is forward-only, same convention as the other
-- twenty-three files):
--   DROP POLICY IF EXISTS member_balances_select_own_or_manager ON public.member_balances;
--   REVOKE ALL ON FUNCTION public.can_view_balances(uuid) FROM PUBLIC, anon, authenticated;
--   DROP FUNCTION IF EXISTS public.can_view_balances(uuid);
--   -- and restore the previous policy of public.member_balances from
--   -- 20261006120000_member_balances.sql (it is replaced, not merely extended,
--   -- here).

-- ─────────────────────────────────────────────────────────────────────────────
-- can_view_balances — "may this caller read other members' balances?"
-- ─────────────────────────────────────────────────────────────────────────────

-- `plpgsql`, deliberately, not `sql`: a SQL-language body would be parsed at
-- creation and would record a dependency on `can_publish_expenses`, which is the
-- exact dependency this file removes. The body is one call, so the language
-- costs nothing.
CREATE OR REPLACE FUNCTION public.can_view_balances(p_society_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN public.can_publish_expenses(p_society_id);
END;
$$;

COMMENT ON FUNCTION public.can_view_balances(uuid) IS
  'RLS predicate for member_balances (T067): Admin/Treasurer of the society may read every balance; everyone else is limited to their own member row by the policy. Delegates to can_publish_expenses so the manager rule has one implementation, and exists as its own function so no policy object depends on a DROP in an earlier migration''s Down block.';

REVOKE ALL ON FUNCTION public.can_view_balances(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_view_balances(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.can_view_balances(uuid) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- The policy, now depending on this file's own predicate
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS member_balances_select_own_or_manager ON public.member_balances;
CREATE POLICY member_balances_select_own_or_manager
  ON public.member_balances
  FOR SELECT
  TO authenticated
  USING (
    public.can_view_balances(society_id)
    OR member_id IN (
      SELECT m.id FROM public.members m WHERE m.user_id = (SELECT auth.uid())
    )
  );
