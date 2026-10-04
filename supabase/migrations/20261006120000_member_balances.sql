-- ─────────────────────────────────────────────────────────────────────────────
-- 20261006120000_member_balances.sql — T067 · Dues from splits + member balances
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT THIS MIGRATION IS. The publishing transaction T066 established
-- (`public.expense_publish(uuid, uuid, integer, jsonb)`) turns a draft into a
-- bill by writing `expense_splits`. A split is the *bill*; a due is the
-- *receivable* (T060's own words for `public.dues`). This migration makes the
-- receivable real, and maintains the `member_balances` summary the dashboard and
-- the outstanding report read, **inside that same transaction** — never as an
-- asynchronous projection and never as a second write path. It also enforces the
-- two money invariants T067's acceptance names, at the database rather than in
-- application code:
--
--   1. one due per published allocation — `uq_dues_split`, not an application
--      check, because a duplicate obligation is exactly the row a bug would add;
--   2. a due exists only for a published expense, and a principal due is exactly
--      its split — the deferred `trg_due_billable_write` constraint trigger, so
--      `SUM(dues) = SUM(splits) = amount` is a property of the rows, not of the
--      writer that happened to create them.
--
-- WHAT A "DUE" AND A "MEMBER BALANCE" ARE (PRD §3.5, §7.3; SAD §8.3, §14.4).
--
--   * A **due** is one member's receivable: `amount_paise` (non-negative — the
--     allocation it came from), `due_date`, `status = 'pending'`, `paid_paise =
--     0`, `kind = 'principal'`, and the `expense_id`/`split_id`/`apartment_id`
--     that name what it bills. One due per persisted split, created at
--     publication. Late fees and adjustments are the same table with a different
--     `kind` (T085/T068's paths, not this one).
--   * A **member balance** is a *materialised projection* — PRD §3.5's
--     "materialised summary refreshed transactionally on every due/payment
--     write", SAD §14.4's "a maintained summary table, not a computed
--     aggregate". The source of truth is the rows: `dues` (and later
--     `payments`/`payment_allocations`). `member_balances` is never
--     authoritative, is never writable by a client, and is never cached in Redis
--     (SAD §6.5 — "Never cache per-member balances in Redis").
--
-- THE SIGN QUESTION, SETTLED. T060 recorded that
-- `chk_dues_paid_within_amount` (`paid_paise >= 0 AND paid_paise <=
-- amount_paise`) makes a *negative* `dues.amount_paise` unsatisfiable, and that
-- the PRD's advance-credit flow wants signed balances. The two documents are not
-- in conflict once each concept is read where it belongs:
--
--   * `dues.amount_paise` is an **obligation** and stays non-negative. Nothing in
--     the product stores a credit as a negative due.
--   * `member_balances.outstanding_paise` is **signed** — a member in credit has a
--     negative outstanding balance (`docs/guides/MONEY.md` §4: "Refunds,
--     adjustments, advance credits and outstanding balances are negative
--     amounts"), and the PRD's own DDL puts no CHECK on it. A credit lives in
--     `advance_paise` / a negative `outstanding_paise`, never as a negative due.
--   * T069's void flow ("paid amounts become `advance_paise` on the member
--     balance") therefore needs **no change to any T060 constraint** — the column
--     it writes already exists and is unconstrained in sign.
--
-- So this migration weakens nothing. `chk_dues_paid_within_amount` stands as
-- shipped, and the signed-balance requirement is representable today.
--
-- WHY THE WRITE IS INSIDE `expense_publish()`, NOT A SECOND REPOSITORY CALL.
-- The acceptance is "balances updated inside the publishing transaction, never
-- asynchronously" and T066's own header records the boundary this task closes
-- ("dues are the receivable and belong to T067 (which extends the publishing
-- *transaction*, not the split set)"). Two shapes were possible: (a) the API's
-- repository writes `dues`/`member_balances` after the RPC in the same
-- `UnitOfWork` transaction, or (b) the definer function writes them. (b) is the
-- one shipped, for three reasons that are properties rather than preferences:
-- the T060 security posture (dues is SELECT-only for clients, and stays so), the
-- impossibility of a published expense without dues (even a direct RPC call
-- gets them), and the set-based upsert below — a single SQL statement whose
-- arithmetic runs under the row lock, which is what makes concurrent publishes
-- to one member correct (no `SELECT balance → JS → UPDATE`).
--
-- THE DUE DATE RULE. `dues.due_date` is NOT NULL and the documents specify a
-- rule only for cycle-generated dues (`due_date = cycle.due_day`, PRD §3.7).
-- For an episodic expense this migration uses, in order:
--   1. `expenses.due_date`, when a future cycles/recurring path has set it
--      (the column exists for exactly that; the create/update contracts
--      deliberately do not expose it, T065);
--   2. otherwise the society's **next `due_day`** on or after today, in the
--      society's own timezone (`society_settings.due_day` 1–28 default 10,
--      `society_settings.timezone` default 'Asia/Kolkata' — both PRD §3.4/§7
--      defaults). "Next" means today when today is the due day.
-- This is a documented interpretive choice, not an invented policy: it uses only
-- shipped settings, it is deterministic given the clock, and the T067 report
-- records that the PRD does not state the rule for episodic expenses. An
-- unparseable timezone falls back to the database's date rather than bricking
-- publishing.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO. No payments, no allocation, no
-- credits, no late fees, no voiding, no revisions, no notification, no audit
-- rows (T050's infrastructure still does not exist and this task does not fake
-- it), and no client write grant on either table. `paid_paise`, `status` and
-- every balance column are derived state that only the transaction owning the
-- triggering financial fact may write.
--
-- Down (run by hand — the runner is forward-only; same convention as the other
-- twenty-one files, and ADR-0008 is why there is no second, automated path):
--   DROP TRIGGER IF EXISTS trg_due_billable_write ON public.dues;
--   DROP FUNCTION IF EXISTS public.chk_due_billable();
--   DROP INDEX IF EXISTS public.uq_dues_split;
--   DROP TABLE IF EXISTS public.member_balances;
--   -- and restore the previous body of public.expense_publish(uuid, uuid,
--   -- integer, jsonb) from 20261005120000_expense_publish.sql (it is replaced,
--   -- not merely extended, below). Reverting this file removes dues generation
--   -- and balance maintenance and nothing else; `dues` rows written by it are
--   -- the financial history a rollback of the schema must decide about, not data
--   -- this block deletes.

-- ─────────────────────────────────────────────────────────────────────────────
-- member_balances — the maintained summary (PRD §7.3, verbatim columns)
-- ─────────────────────────────────────────────────────────────────────────────

-- The PRD's DDL, column for column. Two deliberate choices about its keys:
--
--   * `member_id uuid PRIMARY KEY REFERENCES members(id)` — one row per member,
--     and the row's identity *is* the membership. A member belongs to exactly one
--     society, so this is also the row a balance read locks.
--   * The foreign keys are single-column and reference the referenced tables'
--     primary keys, **not** the composite `(id, society_id)` anchors T060 used
--     for the expense tables. That is not a weakening: `member_balances` carries
--     no client write grant (only the definer publishing transaction writes it),
--     so there is no client-supplied `(member_id, society_id)` pair to get wrong —
--     and the PRD's own DDL is written exactly this way. It also keeps
--     `20261001120000_expense_schema.sql`'s documented Down rehearsal executable:
--     that block drops `uq_members_id_society`, and a composite FK here would make
--     `ALTER TABLE public.members DROP CONSTRAINT` fail with a dependent object.
CREATE TABLE IF NOT EXISTS public.member_balances (
  member_id uuid PRIMARY KEY REFERENCES public.members (id) ON DELETE CASCADE,
  society_id uuid NOT NULL REFERENCES public.societies (id) ON DELETE CASCADE,

  -- Everything billed (principal dues plus any late fees/adjustments), summed
  -- from `dues`. NOT reduced by payments — `total_paid_paise` is that half.
  total_due_paise bigint NOT NULL DEFAULT 0,
  -- Verified payments allocated to this member's dues (SAD §8.6 invariant 3:
  -- `dues.paid_paise` equals the sum of verified allocations). Payment paths
  -- arrive with T079+.
  total_paid_paise bigint NOT NULL DEFAULT 0,
  -- Credits available to apply (T069's void conversion, credit notes). A
  -- magnitude, not a sign.
  advance_paise bigint NOT NULL DEFAULT 0,
  -- PRD §3.5: `Σdues − Σverified payments − Σcredits + Σlate fees`, maintained
  -- transactionally. **Signed**: negative means the member is in credit. There is
  -- deliberately no CHECK here — the PRD's DDL has none, and a credit is a legal
  -- state (docs/guides/MONEY.md §4).
  outstanding_paise bigint NOT NULL DEFAULT 0,
  -- The oldest *unpaid* due date, for ageing buckets (T080 reads it). NULL when
  -- nothing is outstanding. Maintained as `LEAST(existing, min(new dues))`;
  -- monotone while dues can only be added, and recomputed by the payment paths
  -- that can settle the oldest rows (recorded in the T067 report).
  oldest_due_date date,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.member_balances IS
  'Materialised summary of a member''s dues/payments/credits (PRD §3.5, §7.3): a projection of `dues` and (later) verified payments, refreshed inside every transaction that writes a source row — never authoritative, never client-writable, never Redis-cached (SAD §14.4/§6.5).';

-- PRD §7.3's index, verbatim, and T067's acceptance row: the outstanding report
-- orders by amount descending within one society, so the index carries the
-- ordering. `EXPLAIN` proof is in the integration suite.
CREATE INDEX IF NOT EXISTS idx_balances_society_outstanding
  ON public.member_balances (society_id, outstanding_paise DESC);

-- The shared trigger, like every table carrying `updated_at` (SAD §8.1). The
-- table has no `version` column, and `touch_updated_at()` bumps one only when
-- the column exists — so this is a timestamp refresh and nothing else.
DROP TRIGGER IF EXISTS set_member_balances_updated_at ON public.member_balances;
CREATE TRIGGER set_member_balances_updated_at
  BEFORE UPDATE ON public.member_balances
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- RLS + privileges for member_balances
-- ─────────────────────────────────────────────────────────────────────────────

-- PRD §3.6 and the same privacy rule T060 applied to `dues`: a balance is
-- visible to its own member and to the society's Admin/Treasurer (the people who
-- chase it), and to nobody else. Residents see society *aggregates*, which is a
-- definer function's job (the reports module) — a policy cannot round.
ALTER TABLE public.member_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_balances FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS member_balances_select_own_or_manager ON public.member_balances;
CREATE POLICY member_balances_select_own_or_manager
  ON public.member_balances
  FOR SELECT
  TO authenticated
  USING (
    public.can_publish_expenses(society_id)
    OR member_id IN (
      SELECT m.id FROM public.members m WHERE m.user_id = (SELECT auth.uid())
    )
  );

-- SELECT, and nothing else: `outstanding_paise` is derived, and there is no
-- endpoint or repository anywhere in this task that writes a balance as a client.
-- The publishing transaction writes as the function owner. A future payment path
-- adds its own definer function, not an UPDATE grant.
REVOKE ALL ON public.member_balances FROM anon;
REVOKE ALL ON public.member_balances FROM authenticated;
GRANT SELECT ON public.member_balances TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Due identity: one principal due per split, enforced by the database
-- ─────────────────────────────────────────────────────────────────────────────

-- `split_id` is nullable by design (T085's late fees and T068's adjustments may
-- carry no split), so the uniqueness is partial. What it prevents is the exact
-- failure a retry, a double publish or a future repair script would produce: two
-- receivables for one allocation, i.e. a member billed twice for one share. It is
-- an index rather than an application check because the application is not the
-- only writer that will ever exist.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dues_split
  ON public.dues (split_id)
  WHERE split_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- The receivable invariants — a deferred constraint trigger on dues
-- ─────────────────────────────────────────────────────────────────────────────

-- SAD §8.6's spirit, applied to T067's two rules. The trigger is DEFERRABLE
-- INITIALLY DEFERRED for the same reason `chk_split_total()` is: inside
-- `expense_publish()` the dues are written *before* the expense's status flips to
-- `published`, and the invariant is about the committed state. Deferred, the
-- check runs at COMMIT and sees the whole transaction.
--
-- SECURITY DEFINER and `SET search_path = ''`, matching `assert_split_total()`:
-- the function reads `expenses` and `expense_splits`, both FORCE ROW LEVEL
-- SECURITY, and a caller whose own visibility is narrow would otherwise read
-- nothing and pass vacuously — "refused only when the caller can see the row" is
-- not an invariant. Revoked from every client role below, exactly like
-- `assert_split_total`.
--
-- Scope, deliberately narrow:
--   * `expense_id IS NOT NULL` ⇒ the expense must be `published`. A due against a
--     draft or a voided expense is the one way a receivable can exist with no
--     bill behind it.
--   * `kind = 'principal' AND split_id IS NOT NULL` ⇒ `amount_paise` equals the
--     split's amount. Together with `uq_dues_split` this makes
--     `SUM(dues) = SUM(splits) = expense.amount_paise` a theorem about the rows.
--     Non-principal kinds (late fees, adjustments) may reference an expense
--     without mirroring a split; and the trigger fires on the columns that
--     change this meaning only, so a payment path updating `paid_paise`/`status`
--     never pays this function's cost (T079+).
CREATE OR REPLACE FUNCTION public.chk_due_billable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_split_amount bigint;
BEGIN
  IF NEW.expense_id IS NOT NULL THEN
    SELECT e.status::text INTO v_status
      FROM public.expenses e
     WHERE e.id = NEW.expense_id;

    IF v_status IS DISTINCT FROM 'published' THEN
      RAISE EXCEPTION 'DUE_WITHOUT_PUBLISHED_EXPENSE: due % names expense % which is not published',
        NEW.id, NEW.expense_id
        USING ERRCODE = 'P0001',
              HINT = 'A due exists only for a published expense; publish the expense first.';
    END IF;
  END IF;

  IF NEW.split_id IS NOT NULL AND NEW.kind = 'principal' THEN
    SELECT s.amount_paise INTO v_split_amount
      FROM public.expense_splits s
     WHERE s.id = NEW.split_id;

    IF v_split_amount IS NULL OR v_split_amount <> NEW.amount_paise THEN
      RAISE EXCEPTION 'DUE_SPLIT_MISMATCH: due % carries % but split % carries %',
        NEW.id, NEW.amount_paise, NEW.split_id, v_split_amount
        USING ERRCODE = 'P0001',
              HINT = 'A principal due is exactly its split, paisa for paisa.';
    END IF;
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.chk_due_billable() IS
  'Deferred constraint trigger on `dues` (T067): a due''s expense must be published, and a principal due must equal its split. SECURITY DEFINER so a narrow caller cannot make the check vacuous; revoked from every client role.';

DROP TRIGGER IF EXISTS trg_due_billable_write ON public.dues;
CREATE CONSTRAINT TRIGGER trg_due_billable_write
  AFTER INSERT OR UPDATE OF expense_id, split_id, amount_paise, kind ON public.dues
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.chk_due_billable();

REVOKE ALL ON FUNCTION public.chk_due_billable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.chk_due_billable() FROM anon;
REVOKE ALL ON FUNCTION public.chk_due_billable() FROM authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- expense_publish, v2 — the same transaction, now with the receivable in it
-- ─────────────────────────────────────────────────────────────────────────────

-- Replaced, not re-created: the signature and the returned shape are identical
-- (`uuid, uuid, integer, jsonb` → the expense's columns plus `split_summary`),
-- so every T066 caller, grant and test keeps working, and the migration is
-- `CREATE OR REPLACE` rather than a DROP that would momentarily remove the only
-- publish path. The T066 order of refusals is preserved exactly — membership,
-- `expense.publish`, the row lock, the lifecycle, `expectedVersion`, the payload
-- shape, conservation — because those refusals are T066's verified contract, and
-- T067 only *adds* writes after the split set is written:
--
--     splits  →  dues (one per split)  →  member_balances (set-based upsert)
--             →  status/published_at  →  summary read back  →  return
--
-- All of it is one transaction; the deferred `chk_split_total()` and
-- `trg_due_billable_write` triggers judge the final state at COMMIT, so a
-- published expense with missing dues, a due without a published expense, and a
-- balance updated without its due are all impossible rather than unlikely.
--
-- The balance upsert is **one statement**, and its arithmetic happens in SQL
-- under the conflicting row's lock:
--
--     INSERT INTO member_balances … SELECT … FROM created
--     ON CONFLICT (member_id) DO UPDATE
--       SET total_due_paise = member_balances.total_due_paise + EXCLUDED.…,
--           outstanding_paise = member_balances.outstanding_paise + EXCLUDED.…,
--           oldest_due_date = LEAST(member_balances.oldest_due_date, EXCLUDED.…)
--
-- so two concurrent publications that both touch one member serialise on the
-- balance row and each adds its own delta. Nothing is read into the application
-- and written back; `SELECT balance → calculate in TypeScript → UPDATE` is the
-- lost-update shape this deliberately does not have.
--
-- The due date rule is documented in this file's header. `expenses.due_date` wins
-- when a cycles/recurring path has set it; otherwise it is the society's next
-- `due_day` in the society's own timezone. A malformed timezone falls back to the
-- database's date so a settings typo cannot brick publishing.
--
-- The `RETURNS TABLE` parameter names shadow the tables' columns inside the body,
-- so **every** column reference below is table-qualified (`e.`, `s.`) or an
-- alias-qualified CTE reference (`created`, `mb`) — the ambiguity class
-- `20260926140000_fix_join_options_ambiguity.sql` exists to remember.
CREATE OR REPLACE FUNCTION public.expense_publish(
  p_expense_id uuid,
  p_society_id uuid,
  p_expected_version integer,
  p_splits jsonb
)
RETURNS TABLE (
  id uuid,
  society_id uuid,
  category_id uuid,
  title varchar(120),
  description text,
  amount_paise text,
  expense_date text,
  vendor_name varchar(120),
  payment_source varchar(24),
  paid_by_member_id uuid,
  split_strategy text,
  apartment_basis text,
  split_config jsonb,
  participant_selector jsonb,
  status text,
  created_by uuid,
  published_at timestamptz,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  version integer,
  created_at timestamptz,
  updated_at timestamptz,
  split_summary jsonb
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status text;
  v_version integer;
  v_amount bigint;
  v_expense_due_date date;
  v_due_day smallint;
  v_timezone text;
  v_today date;
  v_due_date date;
  v_split_total bigint;
  v_summary jsonb;
BEGIN
  PERFORM public.assert_society_membership(p_society_id);

  -- 403 before 404, and "may you" before "does it exist": the caller's standing is
  -- decided before the record's, matching the API's guard chain and the reason
  -- `expense_draft_delete()` orders its checks the same way.
  IF NOT public.can_publish_expenses(p_society_id) THEN
    RAISE EXCEPTION 'EXPENSE_PUBLISH_FORBIDDEN'
      USING ERRCODE = '42501',
            HINT = 'Only a society Admin or Treasurer can publish an expense.';
  END IF;

  SELECT e.status::text, e.version, e.amount_paise, e.due_date
    INTO v_status, v_version, v_amount, v_expense_due_date
    FROM public.expenses e
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF v_status NOT IN ('draft', 'pending_approval') THEN
    RAISE EXCEPTION 'EXPENSE_NOT_PUBLISHABLE'
      USING ERRCODE = 'P0001',
            DETAIL = v_status,
            HINT = 'Only a draft or an expense awaiting approval can be published.';
  END IF;

  IF v_version <> p_expected_version THEN
    RAISE EXCEPTION 'EXPENSE_VERSION_MISMATCH'
      USING ERRCODE = 'P0001',
            DETAIL = v_version::text,
            HINT = 'This expense was changed by someone else. Reload it and try again.';
  END IF;

  -- The dues' due date, decided once for the whole set (see the header). The
  -- expense's own `due_date` is the cycles/recurring module's channel; until it
  -- exists, the society's financial defaults are the rule.
  IF v_expense_due_date IS NOT NULL THEN
    v_due_date := v_expense_due_date;
  ELSE
    SELECT ss.due_day, ss.timezone
      INTO v_due_day, v_timezone
      FROM public.society_settings ss
     WHERE ss.society_id = p_society_id;

    v_due_day := COALESCE(v_due_day, 10);

    BEGIN
      v_today := (now() AT TIME ZONE COALESCE(v_timezone, 'Asia/Kolkata'))::date;
    EXCEPTION WHEN invalid_parameter_value THEN
      v_today := now()::date;
    END;

    v_due_date := CASE
      WHEN EXTRACT(DAY FROM v_today)::int <= v_due_day
        THEN (date_trunc('month', v_today)::date + (v_due_day - 1))
      ELSE ((date_trunc('month', v_today) + interval '1 month')::date + (v_due_day - 1))
    END;
  END IF;

  IF jsonb_typeof(p_splits) <> 'array' THEN
    RAISE EXCEPTION 'SPLIT_MISMATCH: the allocations are not a list'
      USING ERRCODE = 'P0001',
            HINT = 'A publish must carry the allocation list the split engine produced.';
  END IF;

  IF jsonb_array_length(p_splits) = 0 THEN
    RAISE EXCEPTION 'SPLIT_MISMATCH: expense % has no allocations', p_expense_id
      USING ERRCODE = 'P0001',
            HINT = 'A published expense must have splits summing exactly to its amount.';
  END IF;

  SELECT COALESCE(sum((entry ->> 'amount_paise')::bigint), 0)
    INTO v_split_total
    FROM jsonb_array_elements(p_splits) AS entry;

  IF v_split_total <> v_amount THEN
    RAISE EXCEPTION 'SPLIT_MISMATCH: expense % splits total % expected %',
      p_expense_id, v_split_total, v_amount
      USING ERRCODE = 'P0001',
            HINT = 'A published expense must have splits summing exactly to its amount.';
  END IF;

  -- Replace rather than assume none exist. A draft cannot normally have splits
  -- (T065's delete refuses one that does, and nothing in the product writes them
  -- before publication), but "publishing is the split set's writer" is only true
  -- if it is total: a stale row left by an earlier attempt would otherwise be
  -- summed by `chk_split_total()` alongside the new ones.
  DELETE FROM public.expense_splits s
   WHERE s.expense_id = p_expense_id
     AND s.society_id = p_society_id;

  INSERT INTO public.expense_splits (
    society_id,
    expense_id,
    member_id,
    apartment_id,
    amount_paise,
    weight,
    percent,
    assigned_reason,
    snapshot
  )
  SELECT
    p_society_id,
    p_expense_id,
    (entry ->> 'member_id')::uuid,
    (entry ->> 'apartment_id')::uuid,
    (entry ->> 'amount_paise')::bigint,
    CASE
      WHEN entry ->> 'weight' IS NULL THEN NULL
      ELSE (entry ->> 'weight')::numeric(12, 4)
    END,
    CASE
      WHEN entry ->> 'percent' IS NULL THEN NULL
      ELSE (entry ->> 'percent')::numeric(7, 4)
    END,
    NULLIF(entry ->> 'assigned_reason', ''),
    COALESCE(entry -> 'snapshot', '{}'::jsonb)
  FROM jsonb_array_elements(p_splits) AS entry;

  -- The receivable, from the splits this call just wrote — one principal due per
  -- split, paisa for paisa, at the due date decided above — and the balance delta,
  -- aggregated per member and applied in the same statement. The data-modifying
  -- CTE's `RETURNING` set is the dues **this call** created, not a re-read, so a
  -- concurrent transaction's rows cannot leak into this delta. `ON CONFLICT DO
  -- UPDATE` runs its arithmetic on the locked row — `mb.total_due_paise +
  -- EXCLUDED.total_due_paise` — which is precisely "no lost update": two
  -- concurrent publications to one member add twice, whatever their interleaving.
  -- Nothing is read into the application and written back; `SELECT balance →
  -- calculate in TypeScript → UPDATE` is the lost-update shape this deliberately
  -- does not have.
  --
  -- `member_id` is NOT NULL by schema and the split column is nullable; a split
  -- with no member therefore raises 23502 here and takes the whole publication with
  -- it, which is the database's own fail-closed answer to "a due cannot address
  -- nobody" (the API refuses earlier with `unassigned_participants`).
  --
  -- `LEAST` ignores the NULL side, so `oldest_due_date` fills from the first dues
  -- and only ever moves earlier while dues can only be added.
  WITH created AS (
    INSERT INTO public.dues (
      society_id,
      member_id,
      apartment_id,
      expense_id,
      split_id,
      kind,
      amount_paise,
      paid_paise,
      status,
      due_date
    )
    SELECT
      p_society_id,
      s.member_id,
      s.apartment_id,
      p_expense_id,
      s.id,
      'principal',
      s.amount_paise,
      0,
      'pending',
      v_due_date
    FROM public.expense_splits s
    WHERE s.expense_id = p_expense_id
      AND s.society_id = p_society_id
    RETURNING member_id, society_id, amount_paise, due_date
  ),
  per_member AS (
    SELECT
      created.member_id,
      created.society_id,
      sum(created.amount_paise)::bigint AS due_delta,
      min(created.due_date) AS oldest_due
    FROM created
    GROUP BY created.member_id, created.society_id
  )
  INSERT INTO public.member_balances AS mb (
    member_id,
    society_id,
    total_due_paise,
    total_paid_paise,
    advance_paise,
    outstanding_paise,
    oldest_due_date,
    updated_at
  )
  SELECT
    per_member.member_id,
    per_member.society_id,
    per_member.due_delta,
    0,
    0,
    per_member.due_delta,
    per_member.oldest_due,
    now()
  FROM per_member
  ON CONFLICT (member_id) DO UPDATE
     SET total_due_paise = mb.total_due_paise + EXCLUDED.total_due_paise,
         outstanding_paise = mb.outstanding_paise + EXCLUDED.outstanding_paise,
         oldest_due_date = LEAST(mb.oldest_due_date, EXCLUDED.oldest_due_date),
         updated_at = now();

  -- The transition, and the only place `published_at` is written. `version` is not
  -- set here: the shared `touch_updated_at()` trigger bumps it (and stamps
  -- `updated_at`) on every update of a table that has one, so the optimistic lock
  -- this function just checked cannot be skipped by a second writer path.
  UPDATE public.expenses e
     SET status = 'published',
         published_at = now()
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id;

  -- The summary is read back from `expense_splits`, so a response can only ever
  -- describe rows that committed. `min`/`max`/`sum` are the PRD §8.3 example's
  -- `splitSummary` (plus `totalPaise`, the conservation fact), and the amounts
  -- travel as text so no JSON number stands between a bigint and the API.
  SELECT jsonb_build_object(
           'participantCount', count(*),
           'totalPaise', COALESCE(sum(s.amount_paise), 0)::text,
           'minPaise', COALESCE(min(s.amount_paise), 0)::text,
           'maxPaise', COALESCE(max(s.amount_paise), 0)::text
         )
    INTO v_summary
    FROM public.expense_splits s
   WHERE s.expense_id = p_expense_id
     AND s.society_id = p_society_id;

  RETURN QUERY
    SELECT
      e.id,
      e.society_id,
      e.category_id,
      e.title,
      e.description,
      e.amount_paise::text AS amount_paise,
      e.expense_date::text AS expense_date,
      e.vendor_name,
      e.payment_source,
      e.paid_by_member_id,
      e.split_strategy::text,
      e.apartment_basis::text,
      e.split_config,
      e.participant_selector,
      e.status::text,
      e.created_by,
      e.published_at,
      e.voided_at,
      e.voided_by,
      e.void_reason,
      e.version,
      e.created_at,
      e.updated_at,
      v_summary AS split_summary
    FROM public.expenses e
   WHERE e.id = p_expense_id
     AND e.society_id = p_society_id;
END;
$$;

COMMENT ON FUNCTION public.expense_publish(uuid, uuid, integer, jsonb) IS
  'Publishes one draft or pending_approval expense, writing its splits, its per-split principal dues and the member_balances summary, atomically (T066/T067). Locks the expense row, enforces expense.publish, the lifecycle, the caller''s version and exact conservation of the supplied allocations, stamps status/published_at, and applies the balance delta with one set-based upsert. Returns the published row plus the persisted split summary.';

-- Grants restated rather than assumed: `CREATE OR REPLACE` preserves the ACL, and
-- the REVOKEs are what keep the executable surface of this function exactly the
-- roles T066 granted. `anon` is refused explicitly for the same reason T066 refused
-- it — a signed-out caller has no path to mint a bill.
REVOKE ALL ON FUNCTION public.expense_publish(uuid, uuid, integer, jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expense_publish(uuid, uuid, integer, jsonb)
  FROM anon;
GRANT EXECUTE ON FUNCTION public.expense_publish(uuid, uuid, integer, jsonb)
  TO authenticated;
