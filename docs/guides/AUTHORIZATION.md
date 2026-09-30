# Authorization

How a request is authorised in the Resident 360 API — the application guard chain (T038),
its relationship to PostgreSQL Row Level Security, and what a new module has to
do to join it.

Read `docs/Architecture.md` §7.4, §9.3–§9.5 and `docs/PRD.md` §2 alongside this.
This guide describes the implementation; those describe the rules.

---

## 1. The request flow

```
Client
  │  Authorization: Bearer <Supabase access token>
  │  X-Society-Id: <uuid>            (only on society-scoped routes)
  ▼
ThrottleGuard      not built — rate limiting is a separate task
  ▼
AuthGuard          verifies the JWT against the project's JWKS; attaches the actor
  ▼
SocietyGuard       resolves X-Society-Id → society + the caller's membership
  ▼
PermissionGuard    can(membership.role, the action the route declared)
  ▼
Controller         input contract only
  ▼
Application        @ses/application use cases — the domain's own rules
  ▼
Repository         opens a transaction as the actor (SET LOCAL app.user_id)
  ▼
PostgreSQL         Row Level Security decides which rows exist for that identity
```

Each stage may only **narrow** access, never widen it. That is what makes the
ordering load-bearing rather than cosmetic: nothing downstream can re-grant what
an earlier stage refused.

### Why two authorization layers and not one

They answer different questions, and both answers are needed.

| Layer              | Question                                         | Enforced by                            |
| ------------------ | ------------------------------------------------ | -------------------------------------- |
| Application guards | _May this caller perform this operation at all?_ | `@RequirePermission` + the role matrix |
| Row Level Security | _Which rows may this identity touch?_            | Policies in `supabase/migrations/`     |

A guard cannot see rows, so it cannot decide "is this expense theirs". RLS cannot
see intent, so it cannot decide "may this role void an expense". Neither is a
substitute for the other, and the classic failure — treating the guard as _the_
security boundary — shows up as a query that returns another tenant's data
because someone added an endpoint and forgot the policy.

**RLS is the backstop, not the second opinion.** Every repository call reaches the
database under the caller's own identity (see §5), so a guard bug produces an
empty result rather than a leak. `scripts/db/rls-canary.sql` asserts exactly that
by bypassing the API entirely: it sets the same transaction preamble the
repositories use and confirms a stranger still reads zero rows.

---

## 2. Guard execution order, and why it is in `app.module.ts`

The three guards are registered as `APP_GUARD` providers, in order:

```
SupabaseAuthGuard → SocietyGuard → PermissionGuard
```

`APP_GUARD` providers run in registration order, so each stage can rely on the one
before it. `PermissionGuard` evaluates a membership that `SocietyGuard` resolved;
both sit behind an authenticated actor. Swapping the last two would make every
permission check fail with "no society context" on a request that had one.

They are global rather than `@UseGuards(...)` per controller for the same reason
the export interceptor is: the correct default is applied once, and a module
written later cannot apply the permission guard while forgetting the one that
resolves the membership it evaluates. `SupabaseAuthGuard` is fail-closed —
`@Public()` is the only opt-out.

**The society guards are opt-in, though, and that is deliberate.** They are inert
unless the route declares `@RequirePermission`. Every action is a _per-membership_
grant (PRD §2), so a permission cannot be evaluated without a membership, which
means a route that names a permission is by definition society-scoped. Making them
unconditional would require `X-Society-Id` on routes it has no meaning for — the
join-code lookup, the health probes, `GET /societies` for a user who belongs to
nothing yet.

---

## 3. Permission resolution

The matrix is in **one place**: `packages/domain/src/member/permission-evaluator.ts`,
transcribed from PRD §2.1. The API guard calls it, the mobile UI calls it for
affordance, and the RLS policies mirror it. A `membership.role === "admin"` written
in a controller would be a fourth copy — and the copy no conformance test
enumerates.

`packages/domain/src/member/__tests__/permission-evaluator.test.ts` walks every
`(role × action)` pair — 180 of them — against a hand-transcribed copy of the PRD
and fails the build on any divergence.

### Actions are dotted

`society.edit`, `expense.publish`, `visitor.log`. A colon-separated spelling is
rejected when the decorator is _applied_, so the mistake fails at import rather
than as a mysterious permanent 403.

### ✅ and 🟡 are both "eligible"

The PRD marks a cell ✅ full, 🟡 own/assigned records only, or ⬜ none. `can()`
answers the coarse question, so a 🟡 role is eligible and the resource question is
a second, narrower check.

**The consequence is not optional:** passing `@RequirePermission` for a scoped
action is _not_ authorisation on its own. The handler must narrow against the
record. `isScopedAction(action)` reports which actions this applies to, and
`SCOPED_ACTIONS` is exported so the requirement is machine-checkable. Today those
are the six cells a handler will have to narrow when the owning modules land:

| Action              | Conditional grants                             |
| ------------------- | ---------------------------------------------- |
| `expense.create`    | committee_member — own drafts                  |
| `expense.void`      | committee_member — own drafts                  |
| `complaint.assign`  | committee_member — to self                     |
| `complaint.resolve` | committee_member assigned, resident/tenant own |
| `report.view_all`   | resident/tenant — summary only                 |
| `audit.view`        | treasurer — financial entries only             |

---

### Role writes are their own operation (T046)

A role is not a field a member form submits: `role` is absent from every write contract
_except_ the role endpoint, and `member.invite` (Admin **and** Treasurer, the people who
keep the directory) deliberately cannot set one. Assignment lives at
`PATCH /members/:memberId/role` with a body of exactly one role (`{ role }`, strict), and
revocation at `DELETE /members/:memberId/role` — no body, because revocation _is_ the
transition to `resident` (PRD §2.3) rather than an assignment a caller spells out.

Both routes declare `member.role_change`, the one action no role below Admin holds, and
both go through `applyRoleChange` in `@ses/application`, whose checks run in this order:

```
the caller's context     404   (a non-member learns nothing, not even whether the id exists)
the capability           403   (member.role_change)
the target               404   (another society's member is indistinguishable from a missing one)
the self-change refusal  403   ("ask another Admin" — chk_member_self_change() refuses it too)
the target's status      409   (pending, rejected and removed memberships have no role)
the no-op                409   (a save that changed nothing is not reported as success)
the cap                  409   ROLE_CAP_EXCEEDED (3 admins, 2 treasurers — active holders only)
the admin presence       403   SOCIETY_ADMIN_REQUIRED (the last active Admin cannot be demoted)
```

The order is part of the contract, not polish: each refusal names the thing the user must
change, and a cap breach reported before the self-change refusal would answer "at most 3
admins" to somebody who was promoting themselves.

Every rule above is enforced again underneath, and that duplication is deliberate — the
trigger is what a guard bug or a bypassed client meets:

| Rule                                          | Enforced by                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Only an active Admin of the society may write | `members_update_self_or_admin` (RLS) + the `UPDATE (role)` column grant                          |
| Nobody changes their own role                 | `chk_member_self_change()` → `MEMBER_ROLE_CHANGE_FORBIDDEN`                                      |
| ≤ 3 active admins, ≤ 2 active treasurers      | `checkRoleLimit` **and** `chk_role_caps()` (a `BEFORE` trigger)                                  |
| A society always keeps an active Admin        | `checkAdminPresence` **and** the deferred `chk_admin_present()`                                  |
| A not-admitted membership has no role         | `checkRoleTarget` **and** `chk_role_caps()` (a write that admits it is cap-checked, not refused) |

The cap trigger is **immediate** where the presence check is deferred, and the difference
is the rule's kind: a cap is a limit on the state the row is in the moment it is written,
while a society is allowed to pass through "no second admin" inside a transaction that
corrects it before committing. `scripts/db/rls-canary.sql` asserts all of it as the identity
a client would have, including the owner path (no JWT claims) where only the deferred
constraint stands between a society and having no Admin.

### Introspection reads what the matrix says (T046)

- `GET /permissions` — every role with `actionsFor(role)`, in PRD §2.1's order, plus the
  caller's capabilities.
- `GET /permissions/me` — the caller's own role and action list. **No capability gate in the
  use case**, so a suspended member can see that they hold nothing rather than a refusal that
  cannot explain itself; the route's own `@RequirePermission('member.view')` is what the guard
  chain enforces.
- `GET /permissions/members/:memberId` — one member's, readable by that member **or** by an
  Admin (`canChangeRoles`). A Treasurer who may edit the directory is refused: enumerating the
  society's Admins is a different kind of information.

Three properties are worth stating because they are the ones a future module is most likely
to undo:

1. **Nothing is stored.** There is no `member_permissions` table and no per-member grant — a
   permission is a property of a role, and a table could hold a row the guard would refuse.
   Every answer is `actionsFor(role)`, the same function the guard and the RLS policies read.
2. **The status is folded in.** A non-active membership answers `permissions: []`, because
   the role's grant is not what applies to somebody who cannot act; telling a suspended
   Treasurer they may record payments would contradict the next request's `403`.
3. **There is no write here, and no `Validate Permission` endpoint.** A grant is not
   something a client can send — the only write in this area is a role, whose body has one
   field — and "may I do X" is answered by attempting X, with the guard evaluating the same
   `can()`. A `GET /permissions/validate?action=…` would be a second implementation of the
   check it reports.

### The join queue reuses `member.approve` (T049)

Approving or rejecting a join request is `member.approve` — Admin **and** Treasurer, PRD §2.1's
own row ("Approve/reject join requests") — so the queue adds **no action, no role name and no
`SCOPED_ACTIONS` cell**. The three routes (`GET /members/join-requests`,
`POST /members/join-requests/:memberId/approve`, `…/reject`) declare it, and everything else is
the same chain as any guarded route. What is specific to the queue is that a decision must also
refuse two things the guard cannot see:

- **A request that is not pending** (`join_request_not_pending` → 409) — the request was already
  decided or withdrawn, and its own state is the answer.
- **The reviewer's own request** (`self_review` → 403, matched on membership **or** account) —
  a pending member holds no `member.approve` today, so this is structural already; it is stated
  anyway because that is a property of the current schema, not of the rule.

And one thing only an Admin may do: **hand out a role**. A Treasurer holds `member.approve`
(they may say _whether_ somebody joins); anything above the default `resident`
is `member.role_change`, which only an Admin holds — `checkJoinRoleAssignment`
(`role_not_assignable` → 403), the same asymmetry the invitation path enforces. Admitting
somebody as an ordinary Resident is the default and needs no extra grant.

The refusal checks and the writes sit in different places on purpose, exactly as in a role
change: `checkJoinRequestReview`/`checkJoinRoleAssignment` are pure functions in
`@ses/domain`, and the decision itself is a `SECURITY DEFINER` function
(`member_approve_join()` / `member_reject_join()`) that locks the request row `FOR UPDATE`,
re-checks `status = 'pending'`, resolves the _caller's own_ membership and requires
`member.approve` in that society — through `is_society_join_reviewer()`, deliberately the same
predicate the invitation path uses, because a Treasurer may not write somebody else's row
(`members_update_self_or_admin`) and must still be able to decide this. It also refuses an
`actor` argument that disagrees with `auth.uid()`. A read-then-write in TypeScript could not
promise that two approvals racing produce exactly one active membership and one decision; a row
lock can, and `scripts/db/rls-canary.sql` asserts it by replaying a decision.

Two policies worth knowing, because neither is obvious from the routes:

1. **Primacy is a decision, not a request field.** The requester's own insert may not set
   `is_primary` — `members_insert_self_pending` pins `user_id = auth.uid(), status = 'pending',
role = 'resident', removed_at IS NULL, NOT is_primary`, a _narrowing_ of the T045 policy,
   because the column's INSERT grant exists so an Admin can record a flat's primary occupant.
   Without the clause, a requester could self-declare primacy for the approval to confirm.
2. **A shadow-phone collision is refused on the join path, not merged.** If the caller's phone
   already belongs to a shadow member of that society, `join_request_blocking_shadow()` refuses
   the join (`already_member`, field `phone`); it is the **invitation** path that links that
   row. Two mechanisms that both "adopt" the same shadow row would be one too many, and the
   invitation's is the auditable one.A join request has **no deadline**: neither the PRD nor the roadmap gives one a TTL, and a silently expired request would leave the requester staring at a pending screen while the row said otherwise. Expiry is a designed part of _invitations_ (T047), where it is derived and checked at acceptance.

### The bulk import reuses `member.invite` (T048)

The CSV import (`POST /members/import/preview`, `POST /members/import`) is the directory's act at a different scale, so both routes declare `member.invite` — Admin **and** Treasurer, the people who keep the directory — and add **no action, no role name and no `SCOPED_ACTIONS` cell**: a new action would be a second spelling of one grant. Everything a newcomer to the chain could weaken is already stated by the rows it imports:

- **There is no role column.** Rows import through the direct-add path's own `MemberRepository.create`, which makes residents; an uploaded `role` header arrives as `UNKNOWN_COLUMN` before anything is resolved. Handing out a role above `resident` stays T046's guarded, audited operation, and the import cannot become the escalation surface the matrix never granted.
- **The reads run as the caller.** Flat resolution lists the society's flats under the acting admin's own RLS identity, so another society's flat number answers `APARTMENT_NOT_FOUND` — the import cannot even observe that it exists. The rest of the chain behaves as anywhere else: a pending member 403s, an outsider 404s.

---

## 4. Adding a guarded route

```ts
@Get(":expenseId")
@RequirePermission("expense.view")
@ApiSocietyContext()
view(@Ctx() ctx: RequestCtx, @Param("expenseId") expenseId: string) {
  const { society, membership } = requireSociety(ctx);
  return this.expenses.view(society.id, membership, expenseId);
}
```

That is the whole ceremony. `requireSociety` narrows `@Ctx()` to a context that
must have a resolved society, turning a mis-declared route into a clear 500 rather
than `undefined` reaching a repository.

**Never** write a role check in a handler. If the action you need is missing,
add it to the matrix in `@ses/domain` — with its PRD row cited — and let the
conformance test hold you to it.

### Refusal codes

| Situation                                | Status  | Code               |
| ---------------------------------------- | ------- | ------------------ |
| No `Authorization` header                | 401     | `UNAUTHENTICATED`  |
| `X-Society-Id` absent                    | 400     | `VALIDATION_ERROR` |
| `X-Society-Id` not a UUID                | 400     | `VALIDATION_ERROR` |
| No live membership, _or_ no such society | **404** | `NOT_FOUND`        |
| Membership exists but is not active      | 403     | `MEMBER_INACTIVE`  |
| Role lacks the action                    | 403     | `FORBIDDEN`        |

**404 rather than 403 for "not a member"** is deliberate and is the rule most
likely to be "fixed" by mistake: returning 403 would confirm that the society
exists, letting a caller enumerate ids they have no access to (SAD §7.4, PRD
T041). The two cases are indistinguishable _on purpose_, and the e2e suite asserts
they are byte-identical.

403 stays available for questions that leak nothing: a caller who knows the
society exists (because they are in it, or awaiting approval) may be told their
role is insufficient.

---

## 5. RLS interaction

Every repository method opens a transaction through `UnitOfWork` with the actor as
its identity — `SET LOCAL app.user_id` plus a switch to the `authenticated` role —
so `auth.uid()` resolves inside the policies. Two consequences worth knowing:

1. **A guard bug cannot leak data**, because the database never sees a request
   that claims to be someone else. The application layer decides _whether_ to run
   a query; the database decides _what it returns_.
2. **A repository must never take `societyId` from a request body.** It comes from
   the resolved membership (`RequestContext.societyId()`), and RLS enforces the
   same boundary again underneath.

`RequestContext` (AsyncLocalStorage) carries `requestId`, `userId` and — on a
guarded route — a narrowed `member` (`membershipId`, `societyId`, `role`,
`status`). It is entered by an interceptor, which runs _after_ guards, so the
guards write to the request object and the interceptor copies it in. One
verification and one membership read per request; the guards memoise on the
request, so a second application costs zero reads.### The membership cache, and its ordering

A membership is memoised on the request, so a second guard application in one
request costs zero reads. Since the T038 follow-up (2026-09-29) it is _also_ cached
across requests, in Redis,
keyed `ses:authz:ctx:{societyId}:{userId}` — two immutable UUIDs, never a slug or a
join code, because a key that can be reassigned is a key that can be made to collide.
The value is what `SocietyAuthorizationReader.load()` returned: a society and a
membership. It is **not** a decision — `can(role, action)` is still evaluated per
request and `canOnResource` still reads the record.

SAD §9.4's "cached 5 min; invalidated on any membership write" is now implemented,
and the invalidation is where the design lives. `delete`-after-commit has a window:

```
writer  ── commit ────────────────────────────────► delete        (a few ms later)
reader                    read cache → HIT the old role
```

and a reader that captured the pre-commit value can _repopulate_ the entry after
the delete. Both are closed by three mechanisms, in `common/authorization/membership-cache.ts`:

| Mechanism                                                  | Closes                                                                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate` — raised **before** the transaction, counted, TTL'd | the post-commit/pre-invalidation window: while any membership write is in flight, every read bypasses the cache                              |
| `version` — a per-society counter bumped after commit      | repopulation: a store is refused if the version moved, and an entry carries the version it was stored under, so a bump alone makes it a miss |
| `DEL` of the touched entries                               | memory, not correctness — the bump has already invalidated the whole society                                                                 |

Consequences worth internalising:

- **Correctness is the version bump, not the delete.** A failed delete cannot leave
  a revoked privilege visible; the next lookup misses on the version.
- **Every write is wrapped, never followed.** `MembershipInvalidation.around(...)`
  raises the gate, runs the transaction, invalidates on success and lowers the gate
  on failure — so a rollback bumps nothing, which a trailing `invalidate()` call
  would get wrong.
- **A failed invalidation is safe and loud.** The gate was raised before commit and
  the failed script never lowers it, so reads keep going to the database until its
  60-second TTL; the API logs a warning naming the society. A leaked gate is a cold
  cache, never a stale one.
- **The cache is optional.** `MEMBERSHIP_CACHE_STORE=off` binds nothing, and every
  consumer takes it with `@Optional()`; a Redis that is unreachable makes `lookup`
  answer `bypass` and the request is served exactly as before, one query slower.
- **In `MEMBERSHIP_CACHE_STORE=memory` the store is per process.** Correct for one
  instance (development, the probe) and _wrong_ for two: instance A's invalidation is
  invisible to B, which keeps serving the old role until its entries expire. `redis`
  is the default for that reason.

---

## 6. Resource-level authorization — `canOnResource`

`can(role, action)` answers _may this role ever perform this action?_, and that is all
a guard can answer: a guard sees a role and an action, never a row. The PRD's matrix
has three kinds of cell — ✅ full, 🟡 own/assigned records only, ⬜ none — and `can()`
deliberately collapses the first two into `true`, because encoding 🟡 as denial would
refuse things the PRD plainly grants.

`canOnResource(member, action, resource)` (`packages/domain/src/member/resource-authorization.ts`)
restores the distinction for the six 🟡 cells of PRD §2.1 and nothing else. It is a
**decision function, not a layer**: it does not replace authentication,
`SocietyGuard`, `PermissionGuard` or RLS, and each stage may still only narrow.

| 🟡 cell (PRD §2.1)                          | Fact the rule reads                                                  |
| ------------------------------------------- | -------------------------------------------------------------------- |
| Create expense — Committee                  | `expense.published` (the intended state: the row does not exist yet) |
| Edit/delete expense — Committee, own drafts | `createdBy` + `published`                                            |
| Assign complaint — Committee, to self       | `assignee`                                                           |
| Resolve complaint — assigned / own (close)  | `assignee` / `raisedBy`, per role                                    |
| View reports — Resident/Tenant, summary     | `report.scope`                                                       |
| View audit log — Treasurer, financial only  | `audit.category`                                                     |

`grantKind(role, action)` tells the three kinds of cell apart (`full` / `scoped` /
`none`), so no rule ever special-cases a role: a ✅ holder never reaches a rule. The
`ResourceSnapshot` union has one variant per resource kind, each carrying only the
facts its rule reads; the four resources that do not exist yet carry only what their
PRD cell names, and **no aggregate, table or repository is introduced for them**.

It fails closed in every direction: an inactive membership, a resource in another
society, an action outside the matrix, a snapshot kind a rule does not cover, and a
🟡 action with no rule registered all answer `false`. `false` is a decision, not a
status code — the caller maps it to the answer that leaks least, which for a row the
caller may not see is the established 404-not-403.

### Where it is enforced, and why no shipped route calls it yet

**The authoritative enforcement point is the application layer**, where the resource
is loaded: a use case resolves the resource _within_ the society the guard resolved,
and a resource id belonging to another tenant is `not_found`. That is how
`loadBuildingContext` and `loadApartmentContext` already work, and it is why no
shipped controller contains business authorization.

No shipped _route_ calls `canOnResource` today, and that is a finding rather than an
omission: all six 🟡 cells belong to modules that do not exist (expenses, complaints,
reports, audit), and every resource that does exist — society, building, apartment,
member, invitation, join request — has only the tenant question, which the SQL's
required `societyId` and RLS already answer. Two tests make the gap impossible to
ship past:

- `membership-cache-ordering`'s sibling in the domain package asserts `SCOPED_RULES`
  covers `SCOPED_ACTIONS` exactly, so a new 🟡 cell without a rule fails the build;
- `apps/api/test/route-inventory.e2e-spec.ts` walks every controller the real
  `AppModule` registered and fails on a guarded route that declares no permission, or
  on a route naming a 🟡 action that is not in its `NARROWED_ROUTES` list.

---

## 7. What is not built yet

- **Audit rows for role changes and join decisions** (T050), and **notifications** to the
  affected member and the other Admins. A role change is still reconstructible (the trigger
  stamps `updated_at` and the API logs the operation), and a join decision carries its own
  stamps — the approval writes `approved_by`/`joined_at`, a rejection
  `rejected_by`/`rejected_at`/`rejection_reason` — but no before/after row is written, and
  nothing is sent, so T046's acceptance and T049's "notifies the requester" are met only in the
  sense that the row records who decided what and when.
- **The acceptance step on an Admin handover** (PRD §2.2: "transfer requires the
  new admin to accept"). It needs a pending-transfer record to accept _against_,
  which is its own task; today an Admin promoted through the role route is
  promoted immediately, and this note exists so no society believes a consent
  step exists that does not.
- **The unverified-account eligibility rule** (PRD §3.1: an unverified account
  cannot hold Admin or Treasurer — T021). Noted in
  `docs/guides/AUTH_E2E_CHECKLIST.md` as outstanding.
- **`ThrottleGuard` and `PlanGuard`** — stages 1 and 5 of SAD §9.4. Rate limiting
  and entitlements are their own tasks; neither is a prerequisite for authorization
  correctness, which is why they are still absent.
- **A resource whose 🟡 cell is enforced end to end.** The domain half is built (see
  §6); the first expense or complaint route is what will call it, and the inventory
  test makes adding one without a narrowing site fail the build.
- **Redis-backed cache verification in CI.** No Redis server exists in the
  development environment this task ran in, so the four Lua scripts in
  `membership-cache.redis.ts` are pinned by invariant tests rather than executed;
  the in-memory adapter implements the identical protocol and _is_ executed, and the
  hosted probe measures the ordering through the real API.
