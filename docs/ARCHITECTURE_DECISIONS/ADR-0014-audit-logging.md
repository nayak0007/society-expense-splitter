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

### D10 — Stage B: batches, declaration-level enforcement, and one mutation first found blocked

Stage B's bulk operations — T048's CSV member import and T043's generated or pasted
flat set — record **one audit row per affected entity**, which is the same shape as
their single-entity twins. There is deliberately **no synthetic batch row**.

The reasoning is the same one D4 gives for refusing `ON CONFLICT DO NOTHING`:
accountability is per entity. A summary row would name a count, an actor and a
moment, and would be the only record of _which_ memberships or flats were created —
so a disputed row would have to be reconstructed from the business tables, which are
exactly what a later edit can change. N rows carry the `entity_id` of each real
subject and its own before/after pair.

The batch is still identifiable, and the identifier is not invented: every row
generated by one HTTP request already carries that request's `requestId` in
`metadata` (D3), because the context is the one the request ran in. A CSV import
runs one transaction **per row** (partial success is T048's stated behaviour), so
per-row rows are also the only shape that stays atomic with the change it describes.
The integration suite asserts the property directly: a two-flat bulk create writes
two rows with two distinct `entity_id`s and one shared `requestId`.

**Enforcement is declaration-level, and says so.** The `@Audited()` decorator is
metadata; the row is written through `UnitOfWork`'s seam (D7). Stage B therefore adds
the check it can actually keep: the route-inventory suite fails when a write-verb
route records nothing and is not on an explicit, reasoned deferral list, when a
route's declared actions differ from the manifest's, or when a declared action is not
in the `@ses/domain` union. That catches "a mutation route shipped without audit" and
"an integration was dropped" at the shortest feedback distance available without a
database. **It does not prove a row was persisted** — that claim belongs to
`apps/api/test/integration/audit-logs.integration-spec.ts`, which asserts the
persisted rows in real SQL.

**`invitation.accepted` was first found blocked, and is closed at the seam.**
`public.invitation_accept()` deliberately clears the transaction's identity
(`set_config('request.jwt.claim.sub', '', true)`, and the same for `request.jwt.claims`)
before it writes the membership, so that the invitee's own row is "out of the way of
the self-service guards". The writer's actor check then had nothing to agree with:
the entry names the accepting user while the setting is empty, `AUDIT_ACTOR_MISMATCH`
is raised, and the whole transaction — acceptance included — rolls back. That was
found by the real PostgreSQL suite, not reasoned about.

The first reading of the fix was a **forward migration**. It is not needed. The seam
that writes the row (`UnitOfWork.transaction`, D7) re-applies `applyIdentity` — the
same three statements it ran at the start — after `work` returns and before
`flushAudit`. That does not touch the applied function (ADR-0008 keeps applied
migrations immutable) and it is not a second transaction (D1): it restores, from the
one authoritative value, the identity D5 already promises the writer will see, so
"the row's actor and the GUC are two readings of one value" holds even when a
function clears the GUC on purpose. It is idempotent, and the audited path pays three
`set_config` calls it would otherwise skip on a transaction that never cleared its
identity. The function is left exactly as it is — the clear stands where the function
put it — because the restore belongs to the seam, not to the call site; that is what
keeps the fix out of every repository's business (D7).

Two consequences of the event shape the row that is now written, and both were
already recorded while it was blocked: the invitation row itself is **unaddressable**
from the accept call site (the caller holds only the token digest, and `token_hash`
is in no SELECT grant), so the row is keyed to the **membership** the function
produced (`entity_type` `member`, `entity_id` the new `member_id`); and the accepted
invitation's own status change therefore has no `before`/`after` pair to record, so
the entry is a birth (`before: null`) whose `after` is the persisted facts the
function reported it created. The route again carries `@Audited("invitation.accepted")`
and the vocabulary entry, both of which were held back while nothing persisted.

### D11 — Stage C: the society lifecycle, and no blocker behind its RPCs

**Stage C adds the six society lifecycle mutations to the same seam, and the
investigation that preceded it found no architectural obstacle.** Creating
(`society.created`), editing (`society.updated`), rotating the join code
(`society.join_code_rotated`), joining (`society.joined`), leaving (`society.left`)
and soft-deleting (`society.deleted`) a society were the group Stage B left without
action names; the union now carries four new members (the other two were reserved in
Stage A), and every one of the six writes through `UnitOfWork`'s seam with its
`before` read _inside_ the caller's transaction — the same shape as Stage B's call
sites, no new mechanism.

**Why the write paths looked like a blocker, and are not.** `society_create(jsonb)`,
`society_update(uuid, jsonb)`, `society_rotate_join_code(uuid)` and
`society_soft_delete(uuid)` are `SECURITY DEFINER` functions, and `join`/`leave` are
direct RLS-governed DML on `public.members`. Both kinds run _inside_ the transaction
`UnitOfWork` already opened, so the flush is appended to that same transaction: the
definer call and the audit row commit together or not at all. This is worth stating
plainly because Stage B's `invitation_accept` _did_ need a seam change — the contrast
is the point. A definer function is a function call in the transaction it was handed,
not a second connection and not a commit, so nothing here needed the identity
re-application; only a function that clears the GUC on purpose (as `invitation_accept`
does) does.

**A join code is never persisted, and not by relying on redaction.** Rotating it
records that the rotation happened, with `before` and `after` snapshots built to omit
the code in both states (`societyAuditSnapshot`), rather than leaving the value in
place for the redactor to strip: key-based redaction replaces a _sensitive value_ it
is shown, so a snapshot that carries `joinCode` at all has already placed a live
credential on the path into the row. Not carrying it is the stronger guarantee, and it
is directly testable — the suite reads the row's combined `before`/`after`/`metadata`
text and asserts that neither the superseded nor the new code appears in it.

**A soft delete is recorded as one, and the retention rule is what makes that
possible.** `society.deleted` carries `after: { deletedAt: true }` against a `before`
that names the society as it stood; the row itself survives, so D2's `ON DELETE
RESTRICT` keeps refusing a _hard_ delete while history exists and the log stays
intact — a soft delete is not a purge. The deletion also has to name an entity that
still exists for its own `society_id` foreign key to resolve, which a purge would not.

**The membership transitions are keyed to the membership, and say what they are.**
`join` and `leave` mutate a `members` row, so their entries are `entity_type: "member"`
with that membership's id (and the society's, since `society_id` is `NOT NULL`
regardless), rather than a second row keyed to the society. `society.joined`'s `after`
carries `status: "pending"`: a join by code is a _request_ (T049), and approval is a
separate action (`member.join_approved`). A re-ask after a rejection records the
membership's prior state as its `before`. A refused mutation of any of the six writes
nothing — the creation included, which the suite asserts by reading both tables after a
refused `society_create`.

**Enforcement moves with the code.** The six society write routes left the
route-inventory suite's reasoned deferral list and joined `MANDATED_AUDIT`, so the same
declaration-level check that guards Stage B now fails if one of them ships without its
action. What remains outstanding is unchanged and still named: the expense
sub-resources, attachments, and the `GET /societies/:id/audit-logs` read route with its
reader-audit row (D8/PRD §11.7).

### D12 — Stage D: the expense sub-resources, and a lifecycle the database does not own alone

**Stage D covers the last nine write routes T050 named, and it found one boundary that is
not a blocker but must never be described as atomic.** Expense categories
(`expense.category_created`/`_updated`/`_deleted`), expense comments
(`expense.comment_added`/`_deleted`), GST details (`expense.gst_updated`) and the
attachment lifecycle (`attachment.created`/`_completed`/`_deleted`) now write through
`UnitOfWork`'s seam. The vocabulary already carried all nine names — reserved in Stage A,
which is why this stage adds no action and no migration — and each entry is handed to the
seam from the **adapter**, because the use cases own no transaction: the same split Stages B
and C established, for the same reason (`@ses/application` is shared with the mobile client
and cannot hold a Postgres transaction).

**Two defers are confirmed rather than assumed.** Every one of the nine paths runs inside
the transaction `UnitOfWork` already opened, so nothing needed the identity re-application
`invitation.accepted` did — and that was _checked_, not inferred: the only two definer
functions on these paths, `expense_category_soft_delete()` and
`expense_comment_soft_delete()`, neither touch `request.jwt.claim.sub`. The rule D5
recorded therefore holds exactly as stated: the restoration exists for a function that
clears the GUC on purpose, and there is still exactly one of those.

**The category is not a display concern, and it is decided here.** `financial` for
categories, GST and attachments; `other` for comments. A category's `gst_applicable`,
`is_capital` and `default_split_strategy` decide how an expense is taxed and split, so its
configuration belongs in the half a Treasurer's `audit.view` narrows to; a GST row _is_ a
tax document, and an attachment is the bill an approval rests on. A comment is discussion,
not financial state, so it stays out of that half — which is a decision about the audit
**read** boundary (PRD §2.1) and not a claim that a comment is unimportant. None of the
three is a schema change: `category` is a column value, and re-classifying an action later
is an UPDATE, not a migration.

**Entity identity names the row that changed, not the expense it hangs off.**
`expense_category` and `expense_comment` carry their own ids; `attachment` carries the
attachment's; and `expense_gst_details` carries the **expense id**, because that table's
primary key _is_ `expense_id` and there is no separate row id to name. The parent expense
travels in `metadata` for the three whose entity is not the expense, so the correlation is
explicit rather than inferred from a join the reader would have to guess.

**A comment's text is deliberately not in the log.** The entry records the author, the
stream position, the creation stamp and the body's **length**, and never the words. PRD
§3.5.3 gives a comment no retention or discoverability rule that would need its content in
the audit trail, and copying a member's words into an append-only table that no `DELETE` can
reach is a disclosure the narrowest reading does not require — the same reasoning D11 applied
to the join code, and asserted the same way: the suite reads the row's combined
`before`/`after`/`metadata` text and fails if the body appears in it. The GST snapshot is the
opposite case and takes the whole row — twelve columns, paise as the column's own digit
strings — because a tax record has no field an auditor would not ask for; the attachment
snapshot sits between the two, taking the bill's identity (name, declared type, size,
checksum, scan status, uploader, expense) and **dropping the storage key**, which is the
object's address and useful only to something already holding bucket access.

**The attachment audit records a committed database transition, and never claims more.**
The presigned PUT, the `HEAD`, the byte read and the object deletion all happen outside any
transaction; no distributed transaction is introduced to pretend otherwise. So what an
`attachment.*` entry means is exactly "this row changed state in this database", and three
consequences are decisions rather than omissions:

- **A reservation withdrawn because its URL could not be minted is audited twice, and that
  is the honest trail.** The row really did commit (ADR-0012 D2's ordering makes the
  reservation the quota's enforcement, so it cannot wait for the signature), so the
  compensating delete is a second committed transition. Suppressing its entry would leave a
  `created` with no matching `deleted` for a row that no longer exists — a log that lies
  about the present rather than one that is merely noisy about a failure.
- **A completion replay writes nothing.** `markComplete` matches on `completed_at IS NULL`,
  and the entry's `before` is reconstructed from that predicate — the predicate _is_ the
  evidence that the flag was unset and that no other column moved. A replay matches no row,
  answers the same `200` (ADR-0012), and flushes nothing. The snapshot needs no second
  statement, so no read can race the write it is describing.
- **An object orphaned by a failed deletion is not an audit row.** No database row changed
  when the object deletion failed, so there is nothing to audit; the sweep's evidence is the
  structured log line at the delete site, which carries the key and the society. Inventing
  an entry there would put a storage fact in a table whose whole meaning is database state.

**All three consequences are pinned by tests, and so are the two refusal boundaries around them.** The **quota refusal** — a society filled to its plan's storage cap — asserts the unmoved `402 PLAN_LIMIT_EXCEEDED` / `ATTACHMENT_QUOTA_EXCEEDED` contract _and_ the absence of evidence: no reservation row commits and no `attachment.created` is written. The **signing failure** asserts the compensating trail just described: both entries for the one id, with no URL, signature, credential or storage key in either, and the `503 DEPENDENCY_UNAVAILABLE` contract unmoved. Completion is asserted through a **real MinIO round trip** — a presigned `PUT`, a `HEAD`, then the use case's own existence, length, SHA-256 and magic-byte re-verification — writing exactly one `attachment.completed`, keyed to the right attachment, expense, society and actor, with a replay adding none. The one claim asserted at `HEAD` rather than by a byte comparison is the stored object's survival across that replay: the suite reads its existence (and its length before completion), not a re-download of its bytes. Nothing in the store's validation was weakened to make any of this pass.

**A draft's deletion cascades its attachment rows, and that removal is recorded only at the expense — a finding, not a settled decision.** `expense_draft_delete()` hard-deletes the draft and PostgreSQL removes the `attachments` rows that referenced it, so a cascaded attachment leaves no `attachment.deleted` entry: what the log holds is the `attachment.created` row from the reservation and one `expense.deleted` whose snapshot names the expense and **not** the attachments it took with it. The suite pins that shape (`records a draft's removal as one expense.deleted entry, not per cascaded attachment`) so it cannot change by accident. The audit history therefore does **not** identify the attachment rows the cascade removed, and the smallest safe ways to give it that accountability — recorded here for review, none of them implemented in this stage — are, smallest first:

- **Read the cascade off the existing `created` rows.** No change at all: an `attachment.created` whose `metadata.expenseId` is the deleted draft, with no `completed` and no `deleted` ever following it, is evidence the bill existed and stopped existing. What it cannot say is _when_ the row went, or by whose request, because the draft's deletion is the only entry that carries a time.
- **Name the removed attachments in the single `expense.deleted` entry's `metadata`.** One row, no fan-out, no migration — and safe only if the ids are read under the lock the definer itself takes: an `INSERT` into `attachments` takes `FOR KEY SHARE` on the parent expense row, so reading the expense `FOR UPDATE` first and its attachments second is complete, while an unlocked read can miss a reservation committing concurrently. The RPC returns `void`, so the ids come from that read or from a new migration that widens the return.
- **One `attachment.deleted` per cascaded row, from that same locked read.** The complete and noisiest form: several rows for one request, and the same locking requirement as the option above.
- **Move it into the database.** A new migration adding an `AFTER DELETE` trigger on `attachments` that writes the entry is complete by construction, and the only option here that needs a migration at all.
- **Remove the cascade instead.** Refuse the draft delete while any attachment row exists (`EXPENSE_HAS_ATTACHMENTS`, mirroring `EXPENSE_HAS_SPLITS`), so every removal is an explicit, individually audited delete. Complete and race-free, but it is a product rule rather than a log change: the user would have to remove the bill before the draft.

**An idempotent no-op is not a transition, and the tombstone test follows the same shape.**
`expense_comment_soft_delete()` returns an already-tombstoned row unchanged. The `before`
read inside the transaction carries the row's own `deleted_at`, so an already-deleted comment
flushes nothing while a first delete flushes one entry — the row's state decides, not a call
count the transaction cannot see. D4's "one transition, one record" is what this preserves:
the two conditional flushes here are the only Stage D paths where an entry is suppressed, and
both are suppressed because the database matched no row. A write that _does_ run always
records — including a save that changes nothing — because the entry describes a committed
write, and an update that wrote the same values is a fact about the request, not an absence.

**One SQL statement changed shape, and it is additive.** `AttachmentRepository.deleteById`'s
`DELETE … RETURNING id` became `RETURNING <the readable column list>`, so the `before`
snapshot comes out of the statement that removed the row and needs no second query that could
race it. Which rows are deleted and which are refused is untouched, and no grant, policy,
function or table changed: Stage D is migration-free, and the only new SQL text is that
projection.

### D13 — Stage E1: the read route, and a log that records who viewed it

**The read route ships, and it is header-scoped rather than the PRD's sketch.** PRD §1857
lists `GET /societies/:id/audit-logs`; it ships as `GET /v1/audit-logs` behind
`X-Society-Id`. The reason is the one `categories.controller.ts` records in full and it is
not stylistic: `SocietyGuard` and `PermissionGuard` are **inert unless a route declares
`@RequirePermission(…)`**, and a permission is a _per-membership_ grant — so a route that
names one is by definition society-scoped, and the header is how it says which society. A
`:societyId` path parameter carrying no declared permission would run with no membership
resolution at all, which is the failure mode the whole chain exists to prevent. The path is
a bare noun (`/audit-logs`) for the same reason `/buildings` and `/expense-categories` are:
the scope travels in the header, and the PRD's path shape is the document's sketch rather
than the shipped convention.

**The narrowing is the matrix asked per category, and it travels into the query.**
`audit.view` is Admin ✅ and Treasurer 🟡 financial-only (PRD §2.1). `auditVisibleCategories`
enumerates the two categories and asks `canOnResource` about each, so there is no
`role === "treasurer"` anywhere in this path — the rule is read from the one place the
matrix lives, exactly as `PermissionGuard` reads it — and an inactive membership is refused
by the evaluator itself, so a pending or suspended member sees nothing even though their
`role` column may still say `admin`. The answer is pushed **into** the query
(`category in (…)`), not applied after the fetch: a post-filter would return _short_ pages,
which breaks the cursor's whole contract ("a full page or the last one"), and would read
rows the caller may not see into the process. The table's `audit_logs_select_authorized`
policy narrows through `can_view_audit` the same way, so the application decides which pages
exist and RLS decides which rows do. The suite asserts the two layers **separately** — one
case goes through the use case, another asks the adapter for both halves on behalf of a
Treasurer and requires the policy to answer the financial half — because a test that only
ever exercised them together could not tell which one was doing the work.

**The read records itself, in the read's own transaction.** PRD §11.7: "the log itself
records who viewed it". The plan is a **required parameter of the port** — no overload, no
default no-op — because an optional parameter is exactly how that requirement would
silently disappear from a future call site, and the adapter runs it inside the same
`UnitOfWork.transaction` that performed the `SELECT`. So the row commits with the read or
the transaction rolls back: a read whose audit write fails is an error response, never a
page. The entry is a **descriptor handed to the transaction's seam**, not a trigger on the
table and not a `SELECT` side effect, so `write_audit_logs` inserts one row for one
descriptor and returns — recording a read cannot fire another read, and recursion is
impossible by construction rather than by policy.

**The reader-audit row is `other`, and that is a privilege decision rather than a
classification.** Access to the log is an event, not financial state, so `audit.viewed` is
`other` — which means it cannot appear in a Treasurer's narrowed view, _including their own
read_. Classifying it `financial` would hand a Treasurer the record of every Admin's read:
an escalation of what the matrix grants them, achieved inside the log itself. The row
carries `entity_type: "audit_log"` and `entity_id: null` (a read addresses a page, not a
row, so there is no single id that would be true) and `before`/`after` **null** (a read
transitions nothing; the alternative — an `after` describing the response — would copy page
content into an append-only table no `DELETE` can reach). Its `metadata` is limited to the
visibility that applied, the page size, whether a cursor was used and how many rows came
back. The **cursor's contents are deliberately absent**: it names a position, and a stored
copy would be a second, unreachable copy of a query parameter — `usedCursor` is the only
part with audit meaning. `returned: 0` is a recorded fact rather than a missing row, which
is what makes "somebody looked and found nothing" distinguishable from "somebody never
looked".

**The response is an allowlist, and the removals are the decision.** `ip_address` and
`user_agent` are dropped from `metadata` for **everybody, including an Admin**: they exist
so an investigator reading the database can answer "from where", and shipping every
society's Admin the addresses and browsers of their members would widen the disclosure
surface for no product benefit. `requestId` is **lifted** out of `metadata` into a field of
its own and removed from the object, so a client reads it in one place rather than two — it
is already public by construction, echoed on every response and in the `X-Request-Id`
header. `operationId` is never returned: it is the writer's idempotency key, explicitly
allowed to be meaningless (D4), so exposing it would invite a client to build on something
that may be a replay's artifact. **Display names are not resolved** — `actorUserId` is the
stable correlation key, and turning it into a name would join `members`/`auth.users` on
every row of every page and make this endpoint a PII surface; a client that wants a name
already has the member list. The projection is an allowlist of stored values plus those two
removals, it lives in the mapper rather than in SQL (so there is one list of internal keys,
next to the contract that documents the exclusion), and the contract's own schema validates
the result — a field the contract does not describe cannot leak by accident.

**The read's own row appears on a later request, never in the response it produced.** It is
inserted after the `SELECT` has run, which is also what keeps a page from shifting under its
own cursor: the first page's `nextCursor` points at a row that was the last of _that_ page,
and a row appended after it cannot change what the cursor means. A client's own view entry
therefore shows up on the next page, or the next visit, and the document says so.

**Ordering is total, served by the table's own index, and the cursor is the tuple.**
`order by occurred_at desc, id desc` matches `idx_audit_logs_society_occurred
(society_id, occurred_at DESC, id DESC)`, and the keyset predicate is a **row comparison** —
`(occurred_at, id) < (…, …)` — rather than two `OR`ed conditions, which is what lets the
planner use that index for the continuation as well as the first page. The tuple is not a
convenience: two audit rows can share an instant (a batch import, one request writing
several entries), and a cursor naming only the timestamp would either skip the rest of that
millisecond or repeat it. `id` travels as its **decimal string** because it is a `bigint`
identity column and a JS `number` loses precision past 2^53 — the same choice every paise
amount in this codebase makes. The adapter reads **one row more than asked for**, so
`hasMore` is answered honestly without a `COUNT(*)`; `total` is deliberately absent, because
a count over the whole log on every page is precisely the unbounded scan the cursor exists
to avoid (SAD §7.4 makes it optional for that reason). A malformed cursor is refused at the
wire edge (422 on `field: "cursor"`), before any query is built, so a client bug cannot
silently become duplicated or skipped rows on a screen — and no access is recorded for it,
because an access that did not happen must not become an audit row.

**A foreign or forged position cannot widen anything either, and that is structural.** The
tenant filter, the visibility filter and the keyset predicate are one statement, so a cursor
can only move the page _within_ what the caller may already read — it cannot name another
society, cannot add a category back and cannot invent a row. The suite asserts it rather
than leaning on the shape: another society's own position, encoded and decoded through both
halves of the production codec, gives an Admin only this society's rows and a Treasurer's
hidden half does not come back; a position forged _behind_ the whole log is an empty page
rather than an error or a second way in.

**`action` is a string on the read, and the read vocabulary stays open.** The write
vocabulary (`AuditAction`) is a closed TS union enforced at the call site by the compiler;
the column is regex-shaped rather than an enum, precisely so a later deploy can record an
action this build has never heard of. Typing the response as the union would make the
contract lie about data the server is allowed to return and would break every client on the
day a new action shipped, so `AuditLogRecord.action` is `string` and narrowing is the
consumer's (`isAuditAction`). An unknown action renders as the opaque name it carries
rather than crashing a screen, and the suite asserts exactly that.

**Enforcement needed a second manifest, and that is what the gap was made of.** The
route-inventory suite's `MANDATED_AUDIT` is keyed off `WRITE_VERBS`: it answers "which
mutation does this route record?", and a `GET` has no answer to that — which is why PRD
§11.7's sentence could sit unimplemented through four stages without a single test
objecting. Stage E1 adds `MANDATED_READ_AUDIT`, keyed by route and asserting the declared
`audit.viewed`, so an endpoint that silently stops recording still returns a `200` with the
right rows and **fails the suite anyway**. The declaration now describes a write the route
really performs (the row is flushed through the seam inside the read's transaction), which
is the condition D7 recorded for a declaration being accurate rather than aspirational.

**Stage E1 is migration-free.** The table, the writer, `can_view_audit` and the one `SELECT`
policy shipped in migration #37 exactly as Stage A wrote them; this stage adds no grant, no
policy, no function, no column and no action name (all of `audit.viewed`'s vocabulary was
reserved in Stage A). What it adds is the read port, the adapter, the use case, the contract,
the route and the reader-audit row. The RLS posture is unchanged and deliberately so:
`ENABLE` without `FORCE`, because the owner writes through the definer — the **privilege**
is the write control and the one policy is the read control.

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
- **The write surface and the read route have both landed.** Integration into the
  expense lifecycle, members, buildings/flats, all three invitation mutations (`created`,
  `revoked`, `accepted`), the six society lifecycle mutations, the expense sub-resources
  and the attachment lifecycle is complete, together with D10's declaration-level
  enforcement — which no longer defers a single write-verb route (its deferral register
  holds only the two routes that are not mutations, kept as a register so the next
  un-integrated mutation fails the suite). D13 adds the read: `GET /v1/audit-logs`, the
  reader-audit row that commits inside its transaction, and a second manifest
  (`MANDATED_READ_AUDIT`) that makes a read route which stops recording fail the suite.
  Still outstanding, and named as such in the Roadmap: refusal-class auditing (a
  403/404-class record), the retention/archival job, the audit UI (Phase 4) and the
  draft-cascade accountability D12 records as a finding.
- **A read is audited, and the audit row is outside the half it might narrow.**
  `audit.viewed` is `other`, so the Treasurer whose `audit.view` narrows the log to
  `financial` cannot read the record of who read it — including their own. Any future
  access-class action (an export, a bulk download, a support impersonation) belongs in the
  same category for the same reason, and `entity_id: null` with both snapshots `null` is
  the shape a non-transitional record takes: state that a read cannot change, recorded
  without copying page content into a table no `DELETE` can reach.
- **The unique `operation_id` is an operational fact, not just a constraint.** A
  client that retries an audited mutation with the same id gets a rolled-back
  transaction, not a silent second row; that is the intended failure mode (D4).
- **PRD §11.7's illustrative schema is superseded for `audit_logs`** by D2/D3/D5.
  A future reader comparing the two should read this ADR as the authority.
