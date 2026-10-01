-- 20261001130000_expense_category_delete.sql
--
-- `public.expense_category_soft_delete(uuid, uuid)` — the one write to
-- `expense_categories.deleted_at`, for Roadmap T062.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why this is a function and not a column grant
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `20261001120000_expense_schema.sql` deliberately withheld `deleted_at` and
-- `deleted_by` from the `authenticated` UPDATE grant and granted no DELETE at all,
-- and it said where the write would come from:
--
--   "The soft-delete path (`expense_categories.deleted_at`) is T062's, and it
--    belongs in a definer function the way `apartment_soft_delete()` does — a
--    policy cannot vary by column, so 'may edit a category's name' and 'may delete
--    it' have to be two decisions, and the second one is the one with a reference
--    check in it."
--
-- This migration is that function. The reason it cannot be an ordinary statement in
-- the API is structural rather than stylistic: every request runs inside
-- `UnitOfWork`, which does `SET LOCAL ROLE authenticated`, so the caller is bound by
-- the column grants above no matter how the repository is written. There is no
-- reachable path to a tombstone without this function, which is why T062 adds one
-- migration rather than zero.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why the reference check is here as well as in the use case
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `deleteCategory` in `@ses/application` counts the category's expenses first and
-- refuses with a typed `category_has_expenses`, because that is the answer that
-- produces the message the user reads without depending on an exception's text.
-- That check is *advisory* — between the count and the update another request can
-- publish an expense against the category — so the rule is also enforced here,
-- where no writer can skip it. This is the same division `building_soft_delete()`
-- documents for flats, and the `P0001/CATEGORY_HAS_EXPENSES` raise is the same
-- shape as its `P0001/BUILDING_HAS_APARTMENTS`.
--
-- The predicate counts **every** expense, not only live ones, and the difference
-- from `building_soft_delete` is deliberate: that function checks live flats
-- because a building whose flats were all removed is empty again, whereas
-- `expenses` has no `deleted_at` at all — SAD §8.1 puts it in the "never deleted,
-- voided instead" tier. A *voided* expense still renders its category's name in
-- every list and report, so a category any expense has ever used is not removable.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback
-- ─────────────────────────────────────────────────────────────────────────────
--
--   REVOKE ALL ON FUNCTION public.expense_category_soft_delete(uuid, uuid)
--     FROM PUBLIC, anon, authenticated;
--   DROP FUNCTION IF EXISTS public.expense_category_soft_delete(uuid, uuid);
--
-- Nothing else changes in either direction: this migration creates no table, no
-- column, no index, no policy and no row, and the nineteen seeded categories are
-- untouched. Reverting it removes the ability to delete a category and nothing
-- else — an existing tombstone stays a tombstone, because the rows it wrote are
-- ordinary `deleted_at` values that the read paths already filter.

-- ─────────────────────────────────────────────────────────────────────────────
-- The function
-- ─────────────────────────────────────────────────────────────────────────────

-- `SECURITY DEFINER` because `deleted_at` is not a grantable column — the same
-- reason `apartment_soft_delete()`, `building_soft_delete()` and
-- `society_soft_delete()` are. `SET search_path = ''` with fully qualified names
-- is what makes a definer function safe: without it a caller could resolve
-- `expenses` to a table of their own.
--
-- The authorisation half is Admin **or Treasurer**, which is not
-- `assert_society_admin`'s rule. Categories are society *vocabulary* rather than
-- structure, and `20261001120000_expense_schema.sql` already says so in the
-- comment on `can_publish_expenses`: "Active holder of expense.publish /
-- expense.void — and of category writes — in this society: Admin or Treasurer".
-- There is no `assert_society_member_manager()` helper in this schema (only
-- `is_society_member_manager`), so the two-step form is written out here rather
-- than a new global helper being introduced for one caller.
--
-- 404 before 403, and in that order: PRD T041 requires that a stranger cannot tell
-- another tenant's society from a non-existent one, so `assert_society_membership`
-- runs first and raises `P0002`, and only an actor who *is* an active member can
-- reach the `P0003` that says "your role is not enough". Reporting "forbidden"
-- first would confirm the society exists.
CREATE OR REPLACE FUNCTION public.expense_category_soft_delete(
  p_category_id uuid,
  p_society_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public.assert_society_membership(p_society_id);

  IF NOT public.is_society_member_manager(p_society_id) THEN
    RAISE EXCEPTION 'CATEGORY_FORBIDDEN'
      USING ERRCODE = 'P0003',
            HINT = 'Only a society Admin or Treasurer can change expense categories.';
  END IF;

  -- Before the tombstone, and not `deleted_at IS NULL`: see the header on why a
  -- voided expense still counts as a reference.
  IF EXISTS (
    SELECT 1
      FROM public.expenses e
     WHERE e.category_id = p_category_id
       AND e.society_id = p_society_id
  ) THEN
    RAISE EXCEPTION 'CATEGORY_HAS_EXPENSES' USING ERRCODE = 'P0001';
  END IF;

  -- `deleted_by` is deliberately not set, matching `apartment_soft_delete()` and
  -- `building_soft_delete()`: the actor here is `auth.uid()`'s *user* id, and the
  -- column references `members.id`. Resolving one to the other is a join this
  -- function does not need, and `updated_by` is withheld from the grant for the
  -- same reason. The audit trail for a delete is the audit log, not this column.
  UPDATE public.expense_categories
     SET deleted_at = now()
   WHERE id = p_category_id
     AND society_id = p_society_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    -- The caller is an active Admin or Treasurer of this society, so they know it
    -- exists; zero rows therefore means the category is not in it, was already
    -- removed, or never existed — one answer, because distinguishing them would let
    -- a manager of one society enumerate another's category ids.
    RAISE EXCEPTION 'CATEGORY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
END;
$$;

COMMENT ON FUNCTION public.expense_category_soft_delete(uuid, uuid) IS
  'Soft delete of one expense category (T062). 404 for a non-member, 403 for a member without the Admin/Treasurer role, P0001/CATEGORY_HAS_EXPENSES while any expense references it, P0002 when it is not in that society.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Privileges
-- ─────────────────────────────────────────────────────────────────────────────

-- Revoked from PUBLIC and `anon`, granted to `authenticated`, matching every other
-- RPC in this schema. Without the `anon` revoke the function would be callable by
-- a signed-out caller — harmless, because `auth.uid()` is NULL and the membership
-- assertion refuses, but "harmless because something else fails closed" is not a
-- privilege model.
REVOKE ALL ON FUNCTION public.expense_category_soft_delete(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expense_category_soft_delete(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.expense_category_soft_delete(uuid, uuid) TO authenticated;
