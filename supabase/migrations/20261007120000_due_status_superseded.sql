-- ─────────────────────────────────────────────────────────────────────────────
-- 20261007120000_due_status_superseded.sql — T068, migration #27
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT THIS FILE DOES. Adds one value to `public.due_status`:
--
--     'pending', 'partial', 'paid', 'overdue', 'waived', 'written_off', 'superseded'
--
-- `superseded` is the historical lifecycle state ADR-0009 defines: a principal
-- due that the recalculation no longer allocates to its member. The row survives
-- with its original amount, its id and (under T069) its `paid_paise`; it is
-- excluded from current-principal conservation and from `member_balances`, and
-- it remains addressable by future `payment_allocations`. None of the existing
-- values means this: `paid` asserts a settlement, `waived` is a deliberate
-- concession with a reason, `written_off` is a bad-debt decision.
--
-- WHY IT IS ALONE IN ITS OWN FILE. A new enum value cannot be used in the
-- transaction that adds it (PostgreSQL 18, ALTER TYPE: "the new value cannot be
-- used until after the transaction has been committed"). The runner gives every
-- file its own transaction, so the value must be committed here before
-- `20261007130000_due_lifecycle_recalculation.sql` creates a CHECK constraint,
-- a partial unique index and a function body that all name it.
--
-- The value is APPENDED, never inserted before an existing one: enum order is
-- load-bearing in this schema (`ORDER BY status`, every `BETWEEN`), and
-- `superseded` sorts after every current state. `idx_dues_outstanding` is a
-- partial index on `status IN ('pending','partial','overdue')`, so it is
-- untouched. `IF NOT EXISTS` keeps the file re-appliable in the T060 Down
-- rehearsal and on a database where a hand-run already added the value.
--
-- Down (run by hand — the runner is forward-only, same convention as the other
-- twenty-six files):
--   -- Enum values cannot be removed. PostgreSQL has no `ALTER TYPE ... DROP
--   -- VALUE`; the only reverse is recreating the type and every column that
--   -- uses it, which would rewrite `dues` and re-encode every row. This file is
--   -- therefore deliberately irreversible, and the Down block documents that
--   -- instead of pretending otherwise. Re-running the forward half is a no-op
--   -- (`IF NOT EXISTS`), so the T060 rehearsal's apply → down → apply cycle
--   -- remains a cycle.

ALTER TYPE public.due_status ADD VALUE IF NOT EXISTS 'superseded';

COMMENT ON TYPE public.due_status IS
  'Dues lifecycle (PRD §3.6, ADR-0009): pending → partial → paid, plus overdue, waived and written_off as current states, and superseded as the historical state a recalculation (T068) or void (T069) moves a due to. A superseded due keeps its id, amount and paid history but is excluded from current conservation and member_balances.';
