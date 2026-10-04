-- 20261005120000_expense_publish.sql
--
-- `public.expense_publish(uuid, uuid, integer, jsonb)` and the durable
-- `public.idempotency_records` table — Roadmap T066, "Publish expense: the
-- transactional core".
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why the transition is a function and not an UPDATE grant
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `20261001120000_expense_schema.sql` granted `authenticated` UPDATE on
-- `expenses` for the *form* columns and deliberately withheld the lifecycle
-- stamps, with this sentence in the comment beside the grant:
--
--   "Not writable: `currency` …, `society_id`, the lifecycle stamps
--    (`approved_at`, `approved_by`, `published_at`, `voided_at`, `voided_by`) and
--    `version`. The stamps are *facts about a transition* — a client that can
--    write `published_at` can backdate a bill — and T066's publish/void path is
--    the transition that owns them (the same shape as `society_update()`, which
--    is where `societies` keeps its derived columns)."
--
-- `status` *is* granted, so an `UPDATE … SET status = 'published'` would be
-- accepted by the column grant and by the `expenses_update_author` policy for an
-- Admin or Treasurer — and would then commit with `published_at` NULL, which no
-- constraint refuses. The stamp is the thing that says *when* a bill became real,
-- and the only way to make "publishing always stamps it, atomically, from a clock
-- the caller cannot supply" true rather than promised is to put the whole write
-- behind a definer function. `expense_draft_delete()` (T065) is the same shape for
-- the same reason; this is the second of the two transition functions T060
-- announced.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- The rules, and the order they are checked in
-- ─────────────────────────────────────────────────────────────────────────────
--
--   1. `assert_society_membership` — a non-member (or a removed one) cannot tell
--      this society from a non-existent one, so 404 comes before anything else
--      (PRD T041).
--   2. `can_publish_expenses` — PRD §2.1's `expense.publish` cell: Admin or
--      Treasurer. Checked *inside* the database as well as on the route, because
--      a definer function is callable directly by any `authenticated` caller and
--      every rule a policy cannot see has to be restated here. A Committee
--      Member's draft-only cell is refused here; this is the one path that mints
--      a bill.
--   3. The row is resolved `FOR UPDATE`, scoped by `id AND society_id`: a
--      cross-society id is *absent* rather than forbidden, and the lock is held to
--      COMMIT — so a concurrent edit (T065's version-checked `UPDATE`) and a
--      concurrent publish are ordered against this transaction rather than racing
--      it. The lock is what makes "exactly one of two overlapping publishes
--      succeeds" a property of the database instead of of the API's timing.
--   4. **Status** — only `draft` and `pending_approval` may be published
--      (T061's `EXPENSE_TRANSITIONS`). A published expense cannot be published
--      again, and a void one is terminal. The refused state travels in `DETAIL`.
--   5. **Version** — `version = p_expected_version`, under the lock. A stale
--      caller is refused with the *current* version in `DETAIL` so the API can
--      render `VERSION_MISMATCH` with the SAD §7.11 shape. This is the same
--      optimistic lock T065's edit keeps, and the two cannot both win: the edit's
--      `WHERE version = … AND status IN ('draft','pending_approval')` re-evaluates
--      against the published row after this transaction commits and matches
--      nothing.
--   6. **Conservation of the payload** — the sum of the supplied allocations must
--      equal the expense's `amount_paise` *exactly*, before a single split row is
--      written. This is the same refusal the deferred `chk_split_total()` trigger
--      raises at COMMIT; it exists here as well because the trigger judges the
--      *persisted* state after the fact, while this check refuses the write at the
--      first possible moment with the row's own amount in hand. Neither replaces
--      the other: the application's `Expense.publish()` is the third layer, and
--      all three are deliberate.
--
-- What this function deliberately does **not** do: create `dues`, touch
-- `member_balances`, write `expense_revisions` or notify anybody. Splits are the
-- bill; dues are the receivable and belong to T067 (which extends the publishing
-- *transaction*, not the split set), revisions are T068's edit history, and
-- notification dispatch is post-commit by construction (T107). The T066 report
-- states each boundary.
--
-- The returned row deliberately types `split_strategy`, `apartment_basis` and
-- `status` as `text` rather than as their enum types. A `RETURNS TABLE` signature
-- is a real dependency in `pg_type`, and `20261001120000_expense_schema.sql`'s
-- documented Down block rehearses `DROP TYPE public.expense_status`; a function
-- whose signature names that enum blocks the rehearsal. The values are the same
-- labels either way — the published row is a wire shape, not a schema type.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Why the idempotency record is a table, and why the API writes it
-- ─────────────────────────────────────────────────────────────────────────────
--
-- SAD §7.7: "a Redis entry `idem:{userId}:{key}` written at request start with
-- status `in_progress`, plus a Postgres `idempotency_records` row for durability".
-- This migration creates the durable half. There is no Redis in this repository's
-- request path, and the durable row is the half correctness depends on: the key is
-- the unique pair `(user_id, idempotency_key)`, the recorded request hash is what
-- detects a *reuse* of the key for a different request, and the stored body is
-- what a replay returns **verbatim** instead of re-executing the publication.
--
-- The row is written by the API, inside the publishing transaction, rather than by
-- `expense_publish()` itself: the stored body is the response the API will serve
-- on a replay, and building it from the domain's own values keeps money an exact
-- integer across the boundary (a `jsonb` number would put a bigint through JSON's
-- number domain). Because it is written in the same transaction as the publish,
-- the two commit together or not at all — so "a replayed key returns the original
-- response" and "the original response exists only if the bill was published" are
-- one fact rather than two.
--
-- `expires_at` records PRD §2354's 24-hour storage window for the housekeeping job
-- that will reclaim rows. It is **not** a correctness rule and this API does not
-- branch on it: replaying a key whose record is older than 24 hours answers the
-- stored response rather than re-executing, because re-execution is impossible
-- anyway (the expense is published) and a stored answer is strictly more useful
-- than a refusal. The divergence is recorded in the T066 report.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback
-- ─────────────────────────────────────────────────────────────────────────────
--
--   REVOKE ALL ON FUNCTION public.expense_publish(uuid, uuid, integer, jsonb)
--     FROM PUBLIC, anon, authenticated;
--   DROP FUNCTION IF EXISTS public.expense_publish(uuid, uuid, integer, jsonb);
--   DROP TABLE IF EXISTS public.idempotency_records;
--
-- Nothing else changes in either direction: no column of `expenses`,
-- `expense_splits` or `dues` is touched, no existing function is replaced, and no
-- row is migrated. Reverting this migration removes publishing and idempotency and
-- nothing else.

-- ─────────────────────────────────────────────────────────────────────────────
-- idempotency_records — the durable half of SAD §7.7
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The caller, resolved from the verified token — the first half of the key.
  -- PRD §7.7 keys the store `idem:{userId}:{key}`, so the API's notion of
  -- "the same caller" is a user id and this column is an auth user, not a
  -- membership: a member re-invited to the same society is the same caller.
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  -- The society the mutation happened in. Not part of the key (the document's key
  -- is per user), but the tenant the response describes, so the row is auditable
  -- and scoped — and a cascade follows the society's deletion.
  society_id uuid NOT NULL REFERENCES public.societies (id) ON DELETE CASCADE,
  -- The `Idempotency-Key` header, opaque to the database: an outbox `opId`, a
  -- UUID, whatever the client uses. Bounded where it is written (the contract),
  -- not here, so a future longer scheme is a contract change rather than a
  -- migration.
  idempotency_key text NOT NULL,
  -- The request this key was used for, hashed by the API. A second request with
  -- the same key and a different hash is refused (`IDEMPOTENCY_KEY_REUSE`) rather
  -- than replayed — the SAD §7.7 rule that stops a client from aliasing two
  -- different operations onto one key.
  request_hash text NOT NULL,
  -- The response to replay, exactly as the first call produced it. `jsonb` because
  -- it is opaque: nothing queries into it, and a replay parses it through the same
  -- contract the live response goes through.
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- PRD: "Idempotency keys on all money-moving POSTs, stored 24 h with the
  -- response." Housekeeping's window; not a correctness rule (see the header).
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),

  -- The whole mechanism: one key names one operation, per caller. Two concurrent
  -- publishes with the same key therefore cannot both write a record — the second
  -- blocks until the first commits and then finds it, which is how a duplicate
  -- becomes a replay instead of a second bill.
  CONSTRAINT uq_idempotency_records_user_key UNIQUE (user_id, idempotency_key)
);

COMMENT ON TABLE public.idempotency_records IS
  'Durable idempotency records (SAD §7.7): one row per (user, Idempotency-Key), written inside the mutation''s transaction, holding the response a replay must return verbatim.';

CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires
  ON public.idempotency_records (expires_at);

-- RLS: a caller may read their own records and write their own records, and
-- nothing else. The table is not a financial table — it is a retry ledger — but it
-- is tenant-scoped and holds response bodies, so the same discipline applies.
ALTER TABLE public.idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.idempotency_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS idempotency_records_select_own ON public.idempotency_records;
CREATE POLICY idempotency_records_select_own
  ON public.idempotency_records
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS idempotency_records_insert_own ON public.idempotency_records;
CREATE POLICY idempotency_records_insert_own
  ON public.idempotency_records
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = (SELECT auth.uid()));

-- No UPDATE and no DELETE: a record is a fact about a request that happened, and
-- the only honest lifecycle is "written once, reclaimed by housekeeping". Replay
-- never rewrites one and a retry never clears one.
REVOKE ALL ON public.idempotency_records FROM anon;
REVOKE ALL ON public.idempotency_records FROM authenticated;
GRANT SELECT, INSERT ON public.idempotency_records TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- expense_publish — the one path that turns a draft into a bill
-- ─────────────────────────────────────────────────────────────────────────────

-- The returned row is the *same shape* T065's reads return, column for column and
-- cast for cast (`expense.repository.ts`'s `EXPENSE_COLUMNS`): `amount_paise::text`
-- keeps money out of the driver's numeric handling and `expense_date::text` keeps a
-- `date` a date. `split_summary` is the aggregate over the rows this call wrote,
-- read back from the table rather than computed from the payload — so the response
-- describes what landed, not what was sent.
--
-- The `RETURNS TABLE` parameter names shadow the tables' columns inside the body,
-- so **every** column reference below is table-qualified (`e.`, `s.`). That is the
-- ambiguity class `20260926140000_fix_join_options_ambiguity.sql` exists to
-- remember.
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

  SELECT e.status::text, e.version, e.amount_paise
    INTO v_status, v_version, v_amount
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
  'Publishes one draft or pending_approval expense and writes its splits, atomically (T066). Locks the expense row, enforces expense.publish, the lifecycle, the caller''s version and exact conservation of the supplied allocations, then stamps status/published_at. Returns the published row plus the persisted split summary.';

-- Revoked from PUBLIC and `anon`, granted to `authenticated`, matching every other
-- RPC in this schema. The `anon` revoke is not ceremony: `assert_society_membership`
-- fails closed for a caller with no identity, but "harmless because something else
-- refuses" is not a privilege model — a signed-out caller has no path to mint a bill.
REVOKE ALL ON FUNCTION public.expense_publish(uuid, uuid, integer, jsonb)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expense_publish(uuid, uuid, integer, jsonb)
  FROM anon;
GRANT EXECUTE ON FUNCTION public.expense_publish(uuid, uuid, integer, jsonb)
  TO authenticated;
