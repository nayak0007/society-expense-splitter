# ADR-0014 — Append-only audit logging

**Status:** Accepted · **Date:** 2026-10-10 · **Scope:** T050 Stage A, binding on
every later module that records an audit row and on the hosted rollout of
`20261015120000_audit_logs.sql`

## Context

T050 is the Roadmap's audit row, and its acceptance sentence is:

> `@Audited('action.name')` records actor, role, action, entity, before/after JSON,
> IP, user agent and `requestId` · Writes participate in the caller's transaction ·
> `UPDATE` and `DELETE` **revoked** from the application role · Sensitive fields
> redacted before storage · Retention documented as 7 years

PRD §11.7 and SAD §13.7 add what the row is _for_: every mutation on money,
membership, roles and society structure is recorded; retention is seven years
(Indian societies retain financial records for years); Admins read the whole log,
a Treasurer reads the financial half (PRD §2.1's matrix: "View audit log —
✅ Admin, 🟡 Treasurer financial only"), and "the log itself records who viewed
it".

PRD §11.7 carries an illustrative schema (its line ~1600) which this implementation
**does not copy verbatim**. That sketch was written before the RLS model, the
capability-role split and the idempotency requirement existed, and three of its
choices conflict with decisions made since. The deviations are D2, D3 and D5 below;
every one is deliberate and named.

Three facts from the pre-implementation audit shaped the design:

1. **There was no audit code at all.** No `audit_logs` table, no interceptor, no
   migration carrying the name. The _seams_, however, were ready: every membership
   write funnels through the members/invitation repositories and the
   `SECURITY DEFINER` decision functions, all of which already receive and stamp the
   actor (`approved_by`, `rejected_by`, `accepted_by`, `revoked_by`, the role-row
   trigger stamps).
2. **The bootstrap role model is `anon` / `authenticated` / `service_role`
   (NOLOGIN, NOINHERIT) plus a LOGIN `authenticator`**
   (`supabase/migrations/20260919120000_bootstrap.sql`), and the API runs each
   business transaction as `SET LOCAL ROLE authenticated` (`UnitOfWork`).
3. **The bootstrap's `ALTER DEFAULT PRIVILEGES` is a trap.** It grants
   `authenticated` `SELECT, INSERT, UPDATE, DELETE` on _every new table_ and
   `EXECUTE` on _every new function_ the moment each is created — and PostgreSQL's
   own default still grants `EXECUTE` to `PUBLIC`. A migration that merely
   `CREATE`s an audit table therefore hands the very role it must exclude full
   write access. This ADR's privilege section is the correction.

This is **Stage A**: the infrastructure, the redaction rule, the transaction seam
and integration into **representative** mutations (the expense and membership/role
modules). The remaining modules adopt it in Stage B, and the hosted rollout has
prerequisites (D9) that are not yet satisfied.

## Decisions

### D1 — The write boundary is a `SECURITY DEFINER` function, not a table grant

`public.audit_logs` has **no** `INSERT`, `UPDATE` or `DELETE` grant to any client
role. A row is written only by calling `public.write_audit_logs(jsonb)`, which:

- is `SECURITY DEFINER`, owned by `ses_audit_owner` (NOLOGIN, NOINHERIT, owns the
  table and nothing else);
- is `EXECUTE`-granted to `ses_api` alone — a second NOLOGIN capability group whose
  only privilege in the database is this call; and
- takes a **JSON array**, so one round trip records every entry a transaction made.

The alternative — `GRANT INSERT ON audit_logs TO authenticated`, which is what the
PRD sketch's `app_role` line implies — is rejected because the row's actor would
then be **caller-controlled**. Any signed-in caller could write an audit row naming
another user, in another society, with arbitrary before/after. The definer function
takes the actor question away from the caller: the writer refuses a batch whose
`actorUserId` disagrees with the transaction's authenticated user (D5), and
`UnitOfWork` overwrites every entry's actor from the transaction identity before the
call, so the two can never disagree (see the consequence below).

**RLS is `ENABLE`, deliberately not `FORCE`.** The table owner is the writer, and an
owner must bypass its own policies to insert through the definer. `FORCE` would make
the definer unable to write. So the _write_ control is the **privilege** (the
function is unreachable without the grant), and RLS is purely the **read** control —
one `SELECT` policy, `audit_logs_select_authorized`, delegating to
`can_view_audit(society_id, category)`.

**The privilege, not a GUC, is the control.** A transaction-local `set_config` is
forgeable — any role may call `set_config` — so no GUC may be the thing that decides
whether audit writes are allowed. The role switch the flush performs
(`RESET ROLE` → `SET LOCAL ROLE ses_api`) works only because the session's login has
been granted `ses_api`, which no client role has.

### D2 — `society_id` is `NOT NULL` with `ON DELETE RESTRICT` (a deviation from PRD §11.7)

The PRD sketch writes `society_id uuid REFERENCES societies(id) ON DELETE CASCADE`,
and is **nullable**. Both are rejected:

- **`NOT NULL`** — a null society is an audit row no tenant can read: every read
  path is tenant-scoped, `can_view_audit` is keyed on the society, and the RLS policy
  would evaluate false for every caller. A row that can never be seen is not a
  record.
- **`ON DELETE RESTRICT`** — a cascade would erase exactly the history a dispute
  needs, at the moment the society most needs it. Deleting a society while it has
  audit history is refused with sqlstate `23001`
  (`audit_logs_society_id_fkey`).

`actor_user_id` keeps the PRD's shape and its intent, but sharpens the rule:
`ON DELETE SET NULL`, never `CASCADE`. Deleting a user must not delete the record
that they acted; the action, entity, before/after and timestamp survive, and only
the link to the identity is severed. `actor_role` is `public.member_role`, nullable
because a system transaction has no actor.

### D3 — Request facts live in `metadata jsonb`; the vocabulary is a TS union

The PRD sketch gives `audit_logs` dedicated `ip_address inet`, `user_agent text` and
`request_id uuid` columns. This implementation stores them in the `metadata jsonb`
object instead, assembled by `buildAuditEntry` from the server-side request context.
The acceptance sentence is satisfied either way — all three are recorded — and the
jsonb form avoids a column per future fact (Stage B adds `importBatchId` and
friends without a migration). `metadata` is CHECK-constrained to
`jsonb_typeof(...) = 'object'`, because an array or scalar there is a caller that
bypassed the builder.

A `category varchar(32) NOT NULL` column is **added** (the PRD sketch has none),
CHECK-constrained to `('financial', 'other')`. It is not a display concern: it is
what a Treasurer's `audit.view` narrows on (PRD §2.1), and it is the argument
`can_view_audit` reads. `action` is CHECK-constrained by a shape regex
(`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`, ≤64) rather than a database enum: a later
task may record a new action without a schema change, while still being unable to
write an arbitrary string. The developer-facing contract is the TypeScript union
`AUDIT_ACTIONS` in `packages/domain/src/audit/audit.ts`, so a typo is a compile error
at the call site.

`id` is `bigint GENERATED ALWAYS AS IDENTITY`, not the PRD sketch's `bigserial`.
Gaps are expected — a rolled-back transaction still consumes its sequence values — so
**nothing may infer exactly-once from `id`**. `operation_id` (D4) carries that.
`occurred_at` replaces the sketch's `created_at` merely for vocabulary consistency
with the rest of the schema.

### D4 — `operation_id` is UNIQUE; a replay fails closed (no de-duplication)

`operation_id uuid NOT NULL` with `CONSTRAINT uq_audit_logs_operation_id UNIQUE`.
There is deliberately **no `ON CONFLICT DO NOTHING`** anywhere on the write path. A
duplicate `operation_id` raises `23505`, and because the writer runs inside the
caller's transaction the whole business change rolls back with it. A replayed
operation therefore fails loudly rather than silently dropping an audit entry — an
entry discarded to make a write succeed is not an audit trail. The id is generated
by `buildAuditEntry` (one shape, one place) and may be supplied explicitly by a
caller replaying a known operation, which is what makes idempotency an explicit,
typed choice rather than a hand-built string.

### D5 — The actor comes from trusted context, and the database re-checks it

`buildAuditEntry` reads the actor, the membership role, `requestId`, IP and user
agent from the server-side request context (`RequestContext`, an
`AsyncLocalStorage` store the guard chain and the HTTP layer populated) — **never
from a request body**. A call site supplies only what it uniquely knows: which
society, which entity, what changed.

Two independent statements of the same invariant, so it cannot drift:

1. `UnitOfWork`'s `flushAudit` overwrites every entry's `actorUserId` with the
   identity the transaction runs as. A repository call outside a request (an
   integration test, a job) then records the correct actor without seeding a
   request context it does not have.
2. `write_audit_logs` compares each entry's `actorUserId` against
   `request.jwt.claim.sub` (which `applyIdentity` set for the transaction) and
   raises `AUDIT_ACTOR_MISMATCH` if any disagree.

The row's actor and the GUC the writer compares it against are therefore two
readings of one value; they cannot disagree. A system transaction (no GUC) may
record a NULL actor.

### D6 — Redaction is a rule in `@ses/domain`, re-applied at the persistence boundary

`packages/domain/src/audit/audit.ts` owns the redaction rule, with no Nest and no
Drizzle, so it is unit-testable without a database or framework — the same reason
every other domain rule lives there.

- The deny-list (`AUDIT_SENSITIVE_KEY_SEGMENTS`) is SAD §13.7's plus the auth
  vocabulary the acceptance names ("phone and token fields"), matched on **word
  segments** across camelCase/snake_case/kebab-case — so `secretaryName` is
  untouched while `secretReference` is redacted — **and** on the joined compound, so
  `apiKey`/`api_key` (whose two words say nothing apart) are caught.
- `redactAuditPayload` replaces a sensitive key's value **wholesale**, never
  descending into it: a token nested under `auth.token.value` is still a token.
  Non-JSON shapes are normalised (a `Date` → ISO string, `bigint` → string,
  `undefined`/function/symbol → `null`), and a value nested past `AUDIT_MAX_DEPTH`
  (8) is replaced with the marker, so a cyclic payload cannot be walked forever.
- `redactAuditEntry` **re-applies** redaction at the boundary, called by
  `flushAudit` before the payload is serialised. This is what makes "no secret
  reaches `audit_logs`" a property of the transaction boundary rather than a
  property of every call site's discipline. Redaction is idempotent, so running it
  twice costs a walk and changes nothing. `before`/`after`/`metadata` are typed as
  `AuditJson` — already-redacted by construction — so a call site cannot hand the
  writer an unredacted object without going through the rule first.

### D7 — The write is on `UnitOfWork`, not in the interceptor

T050's acceptance says "the audit write rolls back with a failed transaction". An
interceptor's response tap runs **after** the handler's transaction has committed, so
a write there could only ever be best-effort: the business change would survive an
audit failure — precisely the inversion the acceptance forbids. So the row is
written by the operation itself, through `UnitOfWork.transaction(actor, work,
audit?)`:

- `audit` is either a fixed array or a **function of the result**. The function is
  the common case and not a convenience: the row an operation persisted only exists
  once `work` has returned (its id is minted by the database, its version is bumped
  by a trigger), so "before/after reflect actual persisted state" cannot be satisfied
  by an array the caller assembled beforehand.
- The flush runs inside the same transaction as the business writes, after `work`,
  so a business failure leaves no audit row and an audit failure rolls the business
  write back.

`@Audited()` and `AuditInterceptor` still exist, but they **declare** and do not
write. The interceptor is registered globally (a route cannot forget it the way it
could a per-controller one) **after** `RequestContextInterceptor`, and on a route
with no decorator it is one metadata lookup and nothing else. Its `AUDIT_ACTIONS`
metadata key is exported so a test reads it with the same key the interceptor uses.
`AuditService.declare` records the declared actions on the request context, and
`isAuditedRoute()` exposes them: Stage B's enforcement — a declared action that
recorded nothing becomes a 500 — reads this. Wiring enforcement on in Stage A would
break every route not yet integrated, so it lands with the remaining coverage.

### D8 — `service_role` is revoked too (a deviation from the house pattern)

Every other table in this history leaves `service_role` with `ALL` (the bootstrap's
`ALTER DEFAULT PRIVILEGES`). `audit_logs` revokes it explicitly:

```sql
REVOKE ALL ON public.audit_logs FROM anon;
REVOKE ALL ON public.audit_logs FROM authenticated;
REVOKE ALL ON public.audit_logs FROM service_role;
REVOKE ALL ON public.audit_logs FROM ses_api;
REVOKE ALL ON FUNCTION public.write_audit_logs(jsonb)
  FROM PUBLIC, anon, authenticated, service_role, ses_api;
GRANT SELECT   ON public.audit_logs           TO authenticated;
GRANT EXECUTE  ON FUNCTION public.write_audit_logs(jsonb) TO ses_api;
```

`service_role` is revoked because an append-only evidence table is the one place the
platform's `BYPASSRLS` admin role should not be able to rewrite history by accident.
Nothing loses read access: admin reads go through the API (`GET
/societies/:id/audit-logs`, PRD §1857), which runs as `authenticated` under the one
`SELECT` policy — the table has no PostgREST client. `PUBLIC` is named in the
function `REVOKE` because PostgreSQL's own `EXECUTE … TO PUBLIC` default is the grant
that is easiest to forget and grants to everyone. The read helper
`can_view_audit(uuid, text)` is invoked from the policy (evaluated as the caller, so
the caller needs `EXECUTE`), and is revoked from `PUBLIC` and `anon` like every other
helper.

**Reader auditing (PRD §11.7's "the log itself records who viewed it") is NOT in
Stage A.** Recording a read requires the read endpoint, which T050 does not build —
there is no `GET /societies/:id/audit-logs` route yet. Noting it here so the
omission is a documented gap rather than a silent one; it belongs with the audit-log
UI (PRD Phase 3/4, "audit log UI").

### D9 — Retention is 7 years; hosted rollout has four prerequisites

Retention is **seven years** (PRD §11.7, SAD §13.7), documented on the table:
enforced operationally, not by a row-deleting job (an append-only table with a
pruning job is a contradiction; the retention policy governs export and archival).
This matches the compliance row that lists "audit 7 years" beside visitor logs and
notifications.

The migration is **forward-only and additive** (ADR-0008: applied migrations are
immutable). It creates **no LOGIN role and sets no password** — a migration must not
make the history the authority on a credential. The deployed runtime therefore
reaches the writer through a dedicated login (`ses_api_login`) created once, out of
band, and granted into `ses_api`. Hosted rollout is **NO-GO** until four approvals
exist, and none of them is performed by this migration:

1. create the runtime LOGIN role out of band and `GRANT ses_api` to it;
2. a **separate** probe/verification secret, so a rollout check does not reuse the
   runtime credential;
3. confirm the **deployed `DATABASE_URL` role** is the one that will be granted
   `ses_api` (the local/CI `DO` block grants `ses_api` to `authenticator` **only when
   not Supabase** — on hosted, `authenticator` is PostgREST's login too, and handing
   the writer capability to it would let a suitably-signed token reach
   `write_audit_logs`);
4. confirm the migrating role may execute `ALTER TABLE/FUNCTION … OWNER TO
ses_audit_owner`.

The ownership transfer in point 4 is load-bearing and was found the hard way: a
`CREATE OR REPLACE FUNCTION` makes the **migrating** role the function's owner, so a
`SECURITY DEFINER` writer created by a superuser would run the insert with superuser
privilege, bypassing RLS and making the entire privilege separation decorative.
`ALTER FUNCTION public.write_audit_logs(jsonb) OWNER TO ses_audit_owner` after the
`CREATE` is the line that holds the boundary; the real-PostgreSQL suite asserts
`pg_get_userbyid(proowner) = 'ses_audit_owner'`.

## Consequences

- **Every later module writes audits through `UnitOfWork`'s seam.** A new mutation
  passes `audit` to `transaction(actor, work, audit)` — an array or a
  `(result) => entries` function — and declares `@Audited("action.name")` on the
  route. Nothing else is needed; the actor, IP, user agent and `requestId` are
  filled from context.
- **A new audit action needs no migration.** `action` is regex-shaped, not an enum;
  adding a member to `AUDIT_ACTIONS` (and a `@Audited()` call) is the whole change.
- **Tenant isolation is a query property.** Every index is led by `society_id`, the
  one policy reads `can_view_audit`, and a stranger's read matches no row. The
  integration suite proves the read with an Admin, a Treasurer (financial half only),
  a resident, a stranger and another society's Admin.
- **Stage B owns enforcement and the read route** — a declared action that recorded
  nothing becoming a failure, `GET /societies/:id/audit-logs`, the reader-audit row
  (D8), and integration into the remaining modules. This ADR does not pre-empt them.
- **The unique `operation_id` is an operational fact, not just a constraint.** A
  client that retries an audited mutation with the same id gets a rolled-back
  transaction, not a silent second row; that is the intended failure mode (D4).
- **PRD §11.7's illustrative schema is superseded for `audit_logs`** by D2/D3/D5.
  A future reader comparing the two should read this ADR as the authority.
