-- ─────────────────────────────────────────────────────────────────────────────
-- 20261015120000_audit_logs.sql — T050 Stage A, migration #37
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT THIS FILE DOES (ADR-0014, Stage A — implemented and verified locally).
--
--   1. **Two capability roles.** `ses_audit_owner` owns the audit table and the
--      writer function; `ses_api` is the NOLOGIN capability a runtime login is
--      granted so it may call the writer. Neither is a LOGIN role and this file
--      sets no password (a persistent login is created out of band, once, as a
--      hosted rollout prerequisite — ADR-0014).
--   2. **`public.audit_logs`** — the append-only record: who did what, to which
--      entity, with the row before and after, in a tenant-scoped stream.
--   3. **`public.write_audit_logs(jsonb)`** — the only way a row is ever written.
--      `SECURITY DEFINER`, owned by `ses_audit_owner`, revoked from every client
--      role and granted to `ses_api` alone.
--   4. **Least privilege.** The bootstrap's `ALTER DEFAULT PRIVILEGES` hands
--      `authenticated` `SELECT, INSERT, UPDATE, DELETE` on a new table and
--      `EXECUTE` on a new function the moment each is created; this file revokes
--      all of it (including the `PUBLIC` default on functions) and grants back
--      exactly one read privilege and one call privilege.
--   5. **RLS** — `ENABLE`, deliberately **not** `FORCE`: the table owner
--      (`ses_audit_owner`) is the writer and must bypass its own policies, while
--      every client read goes through the one `SELECT` policy. The *write* control
--      is the function privilege, not a policy; RLS is the read control.
--
-- WHY THIS SHAPE. PRD §11.7 asks for an append-only audit trail "used by every
-- subsequent module" and SAD §13.7 adds a 7-year retention requirement and a
-- tenant-scoped read. The architecture review for T050 (recorded in ADR-0014)
-- settled four points this file embodies:
--
--   * the *writer* is a `SECURITY DEFINER` function rather than a table grant,
--     because `authenticated` holding `INSERT` on `audit_logs` is a grant no
--     client should ever have — the row's actor would then be caller-controlled;
--   * `society_id` is `NOT NULL` with `ON DELETE RESTRICT`, not PRD §11.7's
--     nullable `ON DELETE CASCADE`: a cascade would erase exactly the history a
--     dispute needs, and a null society is an audit row no tenant can read;
--   * `operation_id` is `UNIQUE`, so a replay **fails closed** (`23505` rolls the
--     transaction back) instead of being silently de-duplicated;
--   * an audit row is written *inside the caller's transaction* (the API's
--     `UnitOfWork`), so a failed business write leaves no audit row and a failed
--     audit write rolls the business change back.
--
-- NOT changed, deliberately: no existing table, function, policy, grant or row is
-- touched, and migrations #1–36 are immutable and untouched. This file is
-- additive.
--
-- Down (run by hand — the runner is forward-only, same convention as the other
-- thirty-six files):
--   DROP POLICY IF EXISTS audit_logs_select_authorized ON public.audit_logs;
--   DROP FUNCTION IF EXISTS public.write_audit_logs(jsonb);
--   DROP FUNCTION IF EXISTS public.can_view_audit(uuid, text);
--   DROP TABLE IF EXISTS public.audit_logs;
--   -- The two capability roles are intentionally left: dropping them is
--   -- destructive if anything has been granted into them, and harmless in a
--   -- disposable container.
-- Lossless: this migration writes no row and reads none.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1 · The capability roles
-- ─────────────────────────────────────────────────────────────────────────────
--
-- NOLOGIN on purpose, both of them. A migration that minted a LOGIN role (or set
-- a password) would be committing a credential into version control and would
-- make the migration history the authority on a secret — see ADR-0008 and
-- ADR-0014. The deployed runtime's own login (`ses_api_login`) is created once,
-- by an operator, and only ever GRANTed into `ses_api`; that the grant exists is
-- asserted by `write_audit_logs` being unreachable from any other role.
--
-- `ses_api` is a *capability group*, not the API's identity: it can do nothing
-- except call the writer. It owns nothing, reads nothing, and is not a member of
-- `authenticated`, so it can never see a business row.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ses_audit_owner') THEN
    CREATE ROLE ses_audit_owner NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ses_api') THEN
    CREATE ROLE ses_api NOLOGIN NOINHERIT;
  END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2 · The table
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.audit_logs (
  -- A position in a stream, not an identity a client ever addresses. Gaps are
  -- expected (a rolled-back transaction consumes its sequence values), so nothing
  -- may infer "exactly once" from this column — `operation_id` carries that.
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- NOT NULL (SAD §13.7) and RESTRICT (ADR-0014 D2). A society cannot be deleted
  -- while it has audit history: the history is evidence, not a dependent row.
  society_id uuid NOT NULL REFERENCES public.societies (id) ON DELETE RESTRICT,

  -- SET NULL, not CASCADE: deleting a user must not delete the record that they
  -- acted; the action, the entity and the timestamp survive and only the link to
  -- the identity is severed.
  actor_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,

  -- The caller's role **at the time of the action**, read from the membership the
  -- guard already resolved. Nullable because a system transaction has no actor.
  actor_role public.member_role,

  -- The split a Treasurer's `audit.view` narrows to: `financial` is the half of
  -- the log PRD §2.1 lets a Treasurer read.
  category varchar(32) NOT NULL,

  -- A dotted action name (`expense.created`). The regex is the database's half of
  -- the TS union in `packages/domain/src/audit/audit.ts`: a later task may record a
  -- new action without a migration, but can never write an arbitrary string.
  action varchar(64) NOT NULL,

  entity_type varchar(32) NOT NULL,
  entity_id uuid,

  -- The row before and after, and trusted request facts. All three are persisted
  -- **already redacted** (`redactAuditPayload`): the column cannot enforce that, so
  -- the type at the call site does (ADR-0014 D3).
  "before" jsonb,
  "after" jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- The idempotency key. UNIQUE, and the writer does NOT "ON CONFLICT DO NOTHING"
  -- — a duplicate is a bug or a replay, and both should fail the transaction
  -- loudly rather than drop an audit entry on the floor (ADR-0014 D4).
  operation_id uuid NOT NULL,

  occurred_at timestamptz NOT NULL DEFAULT now(),

  -- ── the rules ──────────────────────────────────────────────────────────────
  CONSTRAINT uq_audit_logs_operation_id UNIQUE (operation_id),

  CONSTRAINT chk_audit_logs_category CHECK (category IN ('financial', 'other')),

  CONSTRAINT chk_audit_logs_action_shape
    CHECK (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),

  CONSTRAINT chk_audit_logs_entity_type_shape
    CHECK (entity_type ~ '^[a-z][a-z0-9_]*$'),

  -- Metadata is assembled by the API from a fixed shape; an array or scalar here
  -- would be a caller that bypassed the builder.
  CONSTRAINT chk_audit_logs_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

COMMENT ON TABLE public.audit_logs IS
  'Append-only mutation audit trail (T050, ADR-0014). Rows are written only by public.write_audit_logs(jsonb), which is EXECUTE-granted to the ses_api capability alone; no client role holds INSERT, UPDATE or DELETE. Retention is seven years (SAD §13.7, ADR-0014 D6).';
COMMENT ON COLUMN public.audit_logs.id IS
  'Position in the log. Identity with gaps: never infer exactly-once from it — operation_id is the idempotency key.';
COMMENT ON COLUMN public.audit_logs.society_id IS
  'Tenant scope. NOT NULL and ON DELETE RESTRICT: a society with audit history cannot be deleted (ADR-0014 D2).';
COMMENT ON COLUMN public.audit_logs.actor_user_id IS
  'The authenticated actor, from the server-side request context — never from a request body. ON DELETE SET NULL keeps the record after the user is gone.';
COMMENT ON COLUMN public.audit_logs.actor_role IS
  'The actor''s role at the time of the action, captured from the resolved membership.';
COMMENT ON COLUMN public.audit_logs.operation_id IS
  'Idempotency key. UNIQUE, so a replay fails the transaction closed rather than silently de-duplicating.';
COMMENT ON COLUMN public.audit_logs."before" IS
  'The persisted row before the change, redacted (packages/domain/src/audit/audit.ts). NULL means the entity did not exist.';
COMMENT ON COLUMN public.audit_logs."after" IS
  'The persisted row after the change, redacted. NULL means the entity was removed.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3 · Indexes — only reads that exist, every one led by `society_id`
-- ─────────────────────────────────────────────────────────────────────────────

-- The tenant-scoped stream, newest first (PRD §1857's `GET /societies/:id/audit-logs`).
CREATE INDEX IF NOT EXISTS idx_audit_logs_society_occurred
  ON public.audit_logs (society_id, occurred_at DESC, id DESC);

-- The Treasurer's narrowed read: their own category, newest first.
CREATE INDEX IF NOT EXISTS idx_audit_logs_society_category
  ON public.audit_logs (society_id, category, occurred_at DESC);

-- "What happened to this entity?" — the drill-down a detail screen uses.
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity
  ON public.audit_logs (society_id, entity_type, entity_id);

-- "What did this user do?" — the actor-integrity read.
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor
  ON public.audit_logs (society_id, actor_user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4 · Ownership — the write boundary
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The table and the writer both belong to `ses_audit_owner`. That is what makes
-- the `SECURITY DEFINER` writer able to insert with **no** grant to any client
-- role, and it is why RLS is ENABLE and not FORCE: the owner bypasses its own
-- policies, which is the *point* here (the writer is trusted to write; the
-- privilege to call it is what is restricted).
--
-- Requires the migrating role to be able to hand ownership to `ses_audit_owner`:
-- a superuser locally and in CI (the container's `postgres`), and — as a hosted
-- rollout prerequisite recorded in ADR-0014 — the project owner role, which
-- created the role and is therefore able to administer it.
ALTER TABLE public.audit_logs OWNER TO ses_audit_owner;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5 · The writer
-- ─────────────────────────────────────────────────────────────────────────────
--
-- One call per transaction, one row per element of the array: the API's
-- `UnitOfWork` flushes every operation the transaction recorded in a single
-- round trip, inside the same transaction as the business writes.
--
-- ## Actor integrity is enforced here, not merely recorded
--
-- `applyIdentity` sets `request.jwt.claim.sub` for the duration of the
-- transaction. The writer refuses a batch whose `actorUserId` disagrees with that
-- GUC, so an entry cannot name an actor the transaction is not actually running
-- as — the check is what makes "the actor came from trusted request context" a
-- fact rather than a convention. A system transaction (no GUC) may write rows with
-- a NULL actor.
--
-- ## The batch fails as a whole
--
-- A malformed batch (not an array), a bad enum label, a bad uuid, a duplicate
-- `operation_id` or an actor mismatch raises, and because the writer runs inside
-- the caller's transaction the business change rolls back with it. There is no
-- partial-audit outcome.
CREATE OR REPLACE FUNCTION public.write_audit_logs(p_entries jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid;
  v_count integer;
BEGIN
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION 'AUDIT_INVALID_BATCH'
      USING ERRCODE = 'P0001',
            HINT = 'write_audit_logs expects a JSON array of audit entries.';
  END IF;

  -- The transaction's authenticated actor, as `applyIdentity` set it. NULL in a
  -- system transaction (a job, a migration) — those may record a NULL actor.
  v_actor := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_entries) AS e
     WHERE nullif(e ->> 'actorUserId', '')::uuid IS DISTINCT FROM v_actor
  ) THEN
    RAISE EXCEPTION 'AUDIT_ACTOR_MISMATCH'
      USING ERRCODE = 'P0001',
            HINT = 'An audit entry names an actor other than the transaction''s authenticated user.';
  END IF;

  INSERT INTO public.audit_logs (
    society_id,
    actor_user_id,
    actor_role,
    category,
    action,
    entity_type,
    entity_id,
    "before",
    "after",
    metadata,
    operation_id
  )
  SELECT
    (e ->> 'societyId')::uuid,
    nullif(e ->> 'actorUserId', '')::uuid,
    nullif(e ->> 'actorRole', '')::public.member_role,
    e ->> 'category',
    e ->> 'action',
    e ->> 'entityType',
    nullif(e ->> 'entityId', '')::uuid,
    e -> 'before',
    e -> 'after',
    coalesce(e -> 'metadata', '{}'::jsonb),
    (e ->> 'operationId')::uuid
  FROM jsonb_array_elements(p_entries) AS e;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.write_audit_logs(jsonb) IS
  'The only writer of public.audit_logs (T050, ADR-0014). SECURITY DEFINER, owned by ses_audit_owner, EXECUTE-granted to ses_api alone. Refuses an actor that disagrees with the transaction''s authenticated user and fails the whole batch on any violation. Returns the number of rows written.';

-- The function must belong to the same role that owns the table, and this line is
-- the whole reason the write boundary holds. `CREATE OR REPLACE FUNCTION` makes
-- the *migrating* role the owner — a superuser locally, the project owner on
-- hosted — and a `SECURITY DEFINER` function owned by superuser would run the
-- insert with superuser privilege: it would bypass RLS, and the entire
-- privilege separation in this file would be decoration. Ownership by
-- `ses_audit_owner` (NOLOGIN, owns the table, granted nothing else) means the
-- definer runs with exactly the rights the writer needs and no more.
ALTER FUNCTION public.write_audit_logs(jsonb) OWNER TO ses_audit_owner;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6 · The read helper
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The RLS copy of the `audit.view` matrix cell: an active Admin reads the whole
-- log, an active Treasurer reads the `financial` half, and nobody else reads any
-- of it (PRD §2.1's "View audit log — Admin ✅, Treasurer 🟡 financial only" —
-- `packages/domain/src/member/permission-evaluator.ts`).
CREATE OR REPLACE FUNCTION public.can_view_audit(
  p_society_id uuid,
  p_category text
)
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
       AND (
         m.role = 'admin'
         OR (m.role = 'treasurer' AND p_category = 'financial')
       )
  );
$$;

COMMENT ON FUNCTION public.can_view_audit(uuid, text) IS
  'Active Admin over the whole log, active Treasurer over the financial half only (PRD §2.1). The RLS copy of the audit.view matrix cell.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 7 · RLS — the read control
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ENABLE, not FORCE: the owner (`ses_audit_owner`) writes through the definer
-- function and must bypass these policies. RLS here decides *who may read*, and
-- there is exactly one policy for the one read that exists.
--
-- There is deliberately **no** INSERT, UPDATE or DELETE policy. Even if a grant
-- leaked, a non-owner client would still be denied by the absence of a policy —
-- and the grants below mean no such grant exists in the first place.
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_logs_select_authorized ON public.audit_logs;
CREATE POLICY audit_logs_select_authorized
  ON public.audit_logs
  FOR SELECT
  TO authenticated
  USING (public.can_view_audit(society_id, category));

-- ─────────────────────────────────────────────────────────────────────────────
-- 8 · Privileges — the other half of every policy above
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The bootstrap's `ALTER DEFAULT PRIVILEGES` granted `SELECT, INSERT, UPDATE,
-- DELETE` to `authenticated` (and `ALL` to `service_role`) the moment the table
-- was created, and `EXECUTE` on the function to `authenticated` — plus
-- PostgreSQL's own `EXECUTE ... TO PUBLIC` default on every new function. These
-- REVOKEs are what turn the grants below into the *only* path, and `PUBLIC` is
-- named because it is the one that is easy to forget and grants to everyone.
--
-- `service_role` is revoked too, and that is a deliberate departure from the
-- house pattern: an append-only evidence table is the one place where the
-- platform's BYPASSRLS admin role should not be able to rewrite history by
-- accident. Admin reads go through the API (this table has no PostgREST client),
-- so nothing loses access (ADR-0014, residual risks).
REVOKE ALL ON public.audit_logs FROM anon;
REVOKE ALL ON public.audit_logs FROM authenticated;
REVOKE ALL ON public.audit_logs FROM service_role;
REVOKE ALL ON public.audit_logs FROM ses_api;

-- The whole table, column-wise unrestricted: the row filter is the policy's job.
GRANT SELECT ON public.audit_logs TO authenticated;

-- The writer: revoked from every role that could name it, granted to the one
-- capability a runtime login is given. `authenticated` must NOT be able to call
-- this — it is the difference between "the API recorded an audit row" and "any
-- signed-in caller can write any audit row they like".
REVOKE ALL ON FUNCTION public.write_audit_logs(jsonb)
  FROM PUBLIC, anon, authenticated, service_role, ses_api;
GRANT EXECUTE ON FUNCTION public.write_audit_logs(jsonb) TO ses_api;

-- The read helper is called from the policy, which is evaluated as the caller, so
-- the caller needs EXECUTE. PUBLIC is revoked like every other helper here.
REVOKE ALL ON FUNCTION public.can_view_audit(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_view_audit(uuid, text) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9 · The runtime capability grant — local GRANT, hosted REVOKE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The capability `ses_api` exists in every environment; who *holds* it does not.
-- This block decides that by **role topology** alone — never a hostname, an
-- environment variable or a connection string. The discriminator is the same one
-- `20260919120000_bootstrap.sql` uses: `supabase_auth_admin` exists only on a
-- hosted project, where the platform owns the auth schema. Two end states, each
-- stated explicitly and each **enforced** rather than assumed:
--
--   * stock Postgres / CI (no `supabase_auth_admin`) — the API logs in as
--     `authenticator` (the role `bootstrap` creates; see `containers.ts` and
--     `docs/guides/LOCAL_SETUP.md`), so `ses_api` is GRANTed to it. That is the
--     local equivalent of a hosted operator granting it to a dedicated login.
--   * hosted Supabase (`supabase_auth_admin` present) — `authenticator` is
--     PostgREST's login as well as the API's, and a held capability would let a
--     suitably-signed token reach `write_audit_logs`. The safe state is therefore
--     **REVOKEd**, not merely skipped: revoking means the invariant holds even if a
--     previous run, or a mistaken manual `GRANT`, left the capability attached.
--     The deployed runtime gets it through a dedicated login instead — a hosted
--     rollout prerequisite in ADR-0014, since a migration must not mint a LOGIN
--     role or a password.
--
-- Idempotent and self-healing: re-running it converges to the correct end state.
-- The `>>>`/`<<<` markers let the integration suite replay *this exact block*
-- under a simulated hosted topology (`audit-logs.integration-spec.ts`) rather
-- than restating it — a second copy would be free to drift from what ships.
-- >>> audit-writer-membership-guard
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    EXECUTE 'REVOKE ses_api FROM authenticator';
  ELSE
    EXECUTE 'GRANT ses_api TO authenticator';
  END IF;
END
$$;
-- <<< audit-writer-membership-guard
