-- 20261016120000_audit_retention_floor.sql
--
-- The seven-year retention **floor**, enforced by the database — T050 Stage E2,
-- ADR-0014 D15.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- A floor, not a purge job
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The authoritative requirement is the one PRD §11.7, SAD §13.7 and PRD §14's DPDP
-- section all state: audit history is retained **seven years**. Nothing in those
-- documents requires that a row be *deleted* on its seventh birthday, and two
-- decisions already on record argue against building that here:
--
--   * ADR-0014 D9 — "enforced operationally, not by a row-deleting job (an append-only
--     table with a pruning job is a contradiction; the retention policy governs export
--     and archival)";
--   * Roadmap T167 ("Legal, privacy and DPDP compliance") owns the retention *jobs* —
--     "visitor logs 12 months, notifications 90 days, audit 7 years" — and it is that
--     task which creates `apps/api/src/jobs/schedules/cron.definitions.ts`, the only
--     scheduling surface this project has (it does not exist yet).
--
-- What is *missing* until the job exists is not the deletion: it is the guarantee that
-- nothing can destroy history inside the window. That is what this migration adds, and it
-- is a floor by construction — it refuses, it never removes.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- What the two triggers do
-- ─────────────────────────────────────────────────────────────────────────────
--
--   1. `audit_logs_enforce_retention_floor` — a `BEFORE DELETE` row trigger that raises
--      `AUDIT_RETENTION_FLOOR` for any row whose `occurred_at` is newer than seven years.
--      It fires for **every role, including the table's owner and a superuser**: the
--      grants already mean no application role can reach the table, and this makes the
--      retention window a property of the table rather than of who is asking. A row older
--      than the window is deletable, so a future archival job (T167) is not blocked by it.
--
--      The window starts at `occurred_at` — the instant of the event itself, which the
--      writer sets from `now()` and never from a caller's value — because that is the
--      timestamp an auditor, a court or an AGM reads. `created_at` does not exist on this
--      table and a second timestamp would only invite the question of which one counts.
--
--   2. `audit_logs_block_update` — a `BEFORE UPDATE` row trigger that always raises
--      `AUDIT_APPEND_ONLY`. Stage A revoked `UPDATE` from every client role; this makes
--      the same claim true for a privileged path, so "append-only" is a property of the
--      table and not of the grant list. Nothing in this codebase, the canary or the
--      suites ever updates an audit row, and no partitioning or backfill is planned — if
--      one ever is, it must be reasoned about against this trigger rather than silently
--      inheriting the ability.
--
-- Neither trigger function is granted to anybody: a trigger function is invoked by the
-- server, not called by a client, and `ALTER DEFAULT PRIVILEGES`' `EXECUTE ... TO PUBLIC`
-- (plus its `authenticated` grant) would otherwise leave two callable no-op functions
-- whose failure mode is "raises P0001" — noise in the privilege surface for no benefit.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Deliberate deviation: the test harness has an explicit escape
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `apps/api/test/utils/integration-fixtures.ts` clears a freshly created society's
-- `society.created` entry so a suite can assert an exact action list. That fixture runs on
-- a disposable container's owner connection and now deletes through PostgreSQL's own
-- documented mechanism for a maintenance window — `SET LOCAL session_replication_role =
-- replica`, which disables row triggers for that one transaction. It is test-only, it is
-- one statement, and it is the reason this migration can refuse *every* role instead of
-- carving out an exemption for the owner. No production path sets that setting.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback
-- ─────────────────────────────────────────────────────────────────────────────
--
--   DROP TRIGGER IF EXISTS trg_audit_logs_retention_floor ON public.audit_logs;
--   DROP TRIGGER IF EXISTS trg_audit_logs_block_update    ON public.audit_logs;
--   DROP FUNCTION IF EXISTS public.audit_logs_enforce_retention_floor();
--   DROP FUNCTION IF EXISTS public.audit_logs_block_update();
--
-- Nothing else changes in either direction: no table, no column, no index, no policy, no
-- role, no grant, and no row.

CREATE OR REPLACE FUNCTION public.audit_logs_enforce_retention_floor()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.occurred_at > (now() - interval '7 years') THEN
    RAISE EXCEPTION 'AUDIT_RETENTION_FLOOR'
      USING ERRCODE = 'P0001',
            HINT = 'Audit history is retained for seven years (PRD §11.7, SAD §13.7). '
                   'A row may only be removed once its occurred_at is older than that.';
  END IF;

  RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public.audit_logs_enforce_retention_floor() IS
  'BEFORE DELETE guard on public.audit_logs: refuses any row whose occurred_at is inside the seven-year retention window, for every role (ADR-0014 D15). Rows older than the window are removable, so an archival job may be built on top of it.';

CREATE OR REPLACE FUNCTION public.audit_logs_block_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_APPEND_ONLY'
    USING ERRCODE = 'P0001',
          HINT = 'public.audit_logs is append-only: an existing audit row can never be rewritten (ADR-0014 D2/D15).';
END;
$$;

COMMENT ON FUNCTION public.audit_logs_block_update() IS
  'BEFORE UPDATE guard on public.audit_logs: refuses every update, for every role, making "append-only" a property of the table rather than of the grant list (ADR-0014 D2/D15).';

DROP TRIGGER IF EXISTS trg_audit_logs_retention_floor ON public.audit_logs;
CREATE TRIGGER trg_audit_logs_retention_floor
  BEFORE DELETE ON public.audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_logs_enforce_retention_floor();

DROP TRIGGER IF EXISTS trg_audit_logs_block_update ON public.audit_logs;
CREATE TRIGGER trg_audit_logs_block_update
  BEFORE UPDATE ON public.audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION public.audit_logs_block_update();

-- ─────────────────────────────────────────────────────────────────────────────
-- Privileges: the trigger functions are nobody's to call
-- ─────────────────────────────────────────────────────────────────────────────

-- The bootstrap's `ALTER DEFAULT PRIVILEGES` grants `EXECUTE` on every new function to
-- `authenticated` (and PostgreSQL grants it to `PUBLIC`), which would make these two
-- callable by a client. Neither does anything useful when called directly, and a
-- callable function that only raises is a privilege surface with no purpose.
REVOKE ALL ON FUNCTION public.audit_logs_enforce_retention_floor() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_logs_block_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.audit_logs_enforce_retention_floor() FROM anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.audit_logs_block_update() FROM anon, authenticated, service_role;
