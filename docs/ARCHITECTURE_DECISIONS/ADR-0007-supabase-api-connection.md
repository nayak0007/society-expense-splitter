# ADR-0007 · The API connects to Postgres as `authenticator` and switches role per transaction

**Status:** Accepted — **the mechanism is designed and implemented; it has not yet
been observed against the deployed Supabase project** (see _Verification_, below)
**Date:** 2026-09-20
**Task:** T006–T008 (foundation), consumed by T016/T018/T019
**Supersedes:** nothing; extends ADR-0006 (row tenancy) to the self-hosted API path

## Context

Row level security is the product's second line of defence for tenancy: even if a
handler forgets to scope a query, the database refuses to return another society's
rows. `packages/api/supabase/migrations/2026092013*_society_rls.sql` implements
that, and its shape decides how a non-Supabase client can use it.

The committed policies are written the way Supabase's own tooling writes them:

```sql
CREATE POLICY societies_select_member ON societies
  FOR SELECT TO authenticated
  USING (is_society_member(id) AND deleted_at IS NULL);
```

Two things follow from that line, and both are easy to miss:

1. **`TO authenticated` is a role**, not a label. Grants and policies name it
   explicitly, so a connection using any other role matches no policy and reads
   nothing.
2. **`auth.uid()` reads a GUC, not a session variable the driver sets for you.**
   PostgREST populates `request.jwt.claims` per request. A plain `postgres-js`
   connection never does, so `auth.uid()` is `NULL`, every policy evaluates false,
   and the API is locked out of its own tables — with no error, just empty result
   sets. This is the failure mode that a "we are using RLS" assumption hides.

Meanwhile SAD §8.7 specifies a different mechanism (`SET LOCAL app.user_id`), and
the migration file's own comment calls that variant "the self-hosted API path
(T038)". So the repository currently contains two identity mechanisms, one
implemented and one specified, and the API is the component that has to satisfy
both.

## Decision

**Every transaction that acts on behalf of a member opens with a two-line identity
preamble: log in as `authenticator`, then `SET LOCAL ROLE authenticated` and set
the GUCs that both identity mechanisms read.**

Implemented in `apps/api/src/infrastructure/database/unit-of-work.ts`. The runtime
connection (`DATABASE_URL`) uses the `authenticator` login role; DDL runs on a
separate owner connection (`MIGRATION_DATABASE_URL`). The preamble is:

```sql
SET LOCAL ROLE authenticated;
SELECT set_config('app.user_id',           $1, true);  -- SAD §8.7
SELECT set_config('request.jwt.claims',    $2, true);  -- what auth.uid() reads
SELECT set_config('request.jwt.claim.sub', $1, true);  -- older Supabase read path
```

Four details are load-bearing:

| Detail                                          | Why                                                                                                                                                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SET LOCAL`, never `SET`                        | Under a transaction-mode pooler a session-level setting leaks to whichever request next borrows that backend. For a tenancy setting that means serving one society's rows to another.                                |
| `set_config(..., true)`, not interpolated `SET` | The third argument makes the setting transaction-local, and binding the value removes the injection surface that a string-built `SET` has.                                                                           |
| `SET LOCAL ROLE authenticated`                  | Every grant and policy names `authenticated`. On Supabase it is `NOLOGIN`, so the connection logs in as `authenticator` and switches per transaction — exactly PostgREST's own model.                                |
| Both GUC families set                           | Satisfies the deployed policies (`request.jwt.claims`) _and_ SAD §8.7 (`app.user_id`) without rewriting either. Two mechanisms with one source of truth is a deliberate, temporary compatibility shim, not a design. |

**System transactions pass `actor: null`.** Migrations, scheduled jobs and
reconciliation have no member behind them, so they skip the preamble and run as the
connection's own role — which cannot read tenant tables, because no policy grants
it anything. That is the intended outcome: a background job that needs tenant data
must say _whose_ data it is reading.

## Consequences

**What this buys:**

- The committed policies work unchanged against the API. No policy rewrite, no
  second set of policies for the API path.
- Defence in depth is real rather than aspirational: a use case that forgets a
  `societyId` filter returns nothing instead of everything.
- The runtime connection holds no owner privileges, so a SQL injection inside a
  handler is bounded by the policies it runs under — which is the property that
  makes RLS worth having alongside application-level checks.

**What it costs, and what to watch:**

- **Every request pays a round-trip for the preamble.** It is inside the
  transaction, so it is one extra statement per transaction, not per query. If it
  ever shows up in latency it must be optimised by batching the `set_config`
  calls, never by hoisting them out of the transaction (see the pooling note).
- **A pooler in transaction mode is required for correctness, not just
  performance.** In session mode the connection cannot change role safely, because
  the session outlives the transaction. The self-hosted deployment must therefore
  use PgBouncer/`pgbouncer`-style transaction pooling, or connect directly.
- **`DATABASE_URL` and `MIGRATION_DATABASE_URL` must not share a role.** The
  environment schema asserts this in production and staging, because an API
  holding owner credentials silently disables every policy and nothing else would
  notice.
- **The bridge is currently unobserved.** Nothing in the repository exercises a
  real `auth.uid()` under these GUCs, so a wrong GUC name or a policy that reads a
  different claim would fail to a _silently empty_ result rather than an error.
  That is the single most important thing to confirm before any tenant query ships.

## Verification

`SET LOCAL ROLE` and the GUC names are Postgres semantics and are not in doubt. What
is unverified is the **deployed** side: whether Supabase's `auth.uid()` reads
`request.jwt.claims` in the form written here. It cannot be checked from a machine
without access to the project, so it is recorded as an explicit open item rather
than assumed:

```sql
-- Run once against the real project, as a member of a society with >1 member.
BEGIN;
  SET LOCAL ROLE authenticated;
  SELECT set_config('app.user_id',           '<member-uuid>', true);
  SELECT set_config('request.jwt.claims',    '{"sub":"<member-uuid>","role":"authenticated"}', true);
  SELECT auth.uid();                       -- must return <member-uuid>, not NULL
  SELECT count(*) FROM societies;          -- must be > 0 for that member, and 0 for a stranger
ROLLBACK;
```

If `auth.uid()` comes back `NULL`, the fix is a change to the GUC names in
`applyIdentity` only — the policies and the SAD's `app.user_id` path are unaffected.

## Alternatives considered

**Give the API its own set of policies keyed on `app.user_id` and drop
`TO authenticated`.** Rejected: it duplicates the tenancy predicate across two
identity systems, and the two copies drift. The predicate is the security-critical
part; there must be one of it.

**Connect as the table owner and scope every query in application code.** Rejected
outright. It removes the second line of defence, and a single missed `WHERE` on a
financial table becomes a cross-tenant data leak. This is what RLS exists to
prevent — ADR-0006.

**Use Supabase's PostgREST for all data access and keep the API thin.** Rejected
for the financial core: cycle publication must be one transaction across expenses,
splits, dues and balances (ADR-0001), and money arithmetic cannot live in the
client. The API is the transactional boundary; the mobile app is not.

**Set the GUCs at the connection level with `SET`.** Rejected: with a pooler, that
is a cross-tenant leak waiting for a busy moment — the exact bug that is hardest to
reproduce and worst to explain.
