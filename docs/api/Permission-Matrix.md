# Permission Matrix (T046)

The role → action matrix as the code actually grants it, for review rather than for
runtime. **The source of truth is
`packages/domain/src/member/permission-evaluator.ts`** — this page is a rendering of it,
extracted from `MATRIX_SOURCE` at T046 (2026-09-26). If the two ever disagree, the code
wins and this page is the bug.

Read `docs/PRD.md` §2.1 (the product matrix), `docs/Architecture.md` §9.3–§9.5 and
`docs/guides/AUTHORIZATION.md` §3 alongside it.

- ✅ **full** — the role may perform the action; the guard and the RLS policies both allow it.
- 🟡 **scoped** — the role is _eligible_, and the owning use case narrows against the record
  (own draft, assigned complaint, summary only). `isScopedAction()` reports these, and
  `SCOPED_ACTIONS` lists the six of them.
- — **denied**.

| Action                | admin | treasurer | committee | resident | tenant | guest |
| --------------------- | ----- | --------- | --------- | -------- | ------ | ----- |
| `society.edit`        | ✅    | —         | —         | —        | —      | —     |
| `structure.edit`      | ✅    | —         | —         | —        | —      | —     |
| `structure.view`      | ✅    | ✅        | ✅        | ✅       | ✅     | —     |
| `society.delete`      | ✅    | —         | —         | —        | —      | —     |
| `member.view`         | ✅    | ✅        | ✅        | ✅       | ✅     | —     |
| `member.invite`       | ✅    | ✅        | —         | —        | —      | —     |
| `member.approve`      | ✅    | ✅        | —         | —        | —      | —     |
| `member.role_change`  | ✅    | —         | —         | —        | —      | —     |
| `member.remove`       | ✅    | —         | —         | —        | —      | —     |
| `expense.create`      | ✅    | ✅        | 🟡        | —        | —      | —     |
| `expense.view`        | ✅    | ✅        | ✅        | ✅       | ✅     | —     |
| `expense.publish`     | ✅    | ✅        | —         | —        | —      | —     |
| `expense.approve`     | ✅    | —         | —         | —        | —      | —     |
| `expense.void`        | ✅    | ✅        | 🟡        | —        | —      | —     |
| `payment.record`      | ✅    | ✅        | —         | —        | —      | —     |
| `payment.verify`      | ✅    | ✅        | —         | —        | —      | —     |
| `payment.refund`      | ✅    | ✅        | —         | —        | —      | —     |
| `payment.pay_own`     | ✅    | ✅        | ✅        | ✅       | ✅     | —     |
| `cycle.create`        | ✅    | ✅        | —         | —        | —      | —     |
| `cycle.publish`       | ✅    | ✅        | —         | —        | —      | —     |
| `reminder.send`       | ✅    | ✅        | —         | —        | —      | —     |
| `complaint.create`    | ✅    | ✅        | ✅        | ✅       | ✅     | —     |
| `complaint.assign`    | ✅    | —         | 🟡        | —        | —      | —     |
| `complaint.resolve`   | ✅    | —         | 🟡        | 🟡       | 🟡     | —     |
| `notice.post`         | ✅    | ✅        | ✅        | —        | —      | —     |
| `notice.emergency`    | ✅    | ✅        | ✅        | —        | —      | —     |
| `visitor.log`         | ✅    | —         | —         | —        | —      | ✅    |
| `visitor.approve`     | ✅    | ✅        | ✅        | ✅       | ✅     | —     |
| `report.view_all`     | ✅    | ✅        | ✅        | 🟡       | 🟡     | —     |
| `report.export`       | ✅    | ✅        | —         | —        | —      | —     |
| `audit.view`          | ✅    | 🟡        | —         | —        | —      | —     |
| `subscription.manage` | ✅    | —         | —         | —        | —      | —     |

Notes on the rows a reviewer usually asks about:

- **`structure.view` and `member.view` are implementation additions**, not PRD §2.1 cells:
  both are read actions the shipped routes needed before they could be guarded at all, for
  the reason SAD §9.3 records for `expense.view`/`payment.pay_own`/`complaint.create`. Guest
  is excluded from both, exactly as it is from `visitor.approve` — PRD §2.1 grants that role
  gate logging and nothing else.
- **`expense.void`'s committee cell is 🟡** because the PRD row says "own drafts" even though
  SAD §9.5's condensed table omits it; the PRD is the source and the omission would contradict
  the SAD's own `canOnResource` example.
- **The six 🟡 cells are the only conditional grants.** A route declaring one of them is _not_
  authorised by the guard alone — the use case must narrow against the record, and
  `SCOPED_ACTIONS` exists so that requirement is machine-checkable.

## The role write (T046)

Permissions are a property of a **role**, and a role is a property of a **membership**. The
only write in this area is the role itself:

| Rule                                                                                   | Where it is enforced                                                                                              |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Only `admin` holds `member.role_change`                                                | the matrix above + `@RequirePermission` + `members_update_self_or_admin` (RLS)                                    |
| Nobody changes their own role                                                          | `applyRoleChange` **and** `chk_member_self_change()` (`MEMBER_ROLE_CHANGE_FORBIDDEN`)                             |
| At most 3 active admins, 2 active treasurers                                           | `checkRoleLimit` **and** `chk_role_caps()` (a `BEFORE` trigger)                                                   |
| A society always keeps an active Admin                                                 | `checkAdminPresence` **and** the deferred `chk_admin_present()`                                                   |
| A `pending`/`rejected`/`removed` membership cannot take a role that leaves it that way | `checkRoleTarget` **and** `chk_role_caps()` (a write that admits it — the join approval — is cap-checked instead) |

No role gains a permission because somebody was appointed to it, and no member holds a
per-member grant: there is no `member_permissions` table to hold one. That is the property
that makes this page small enough to audit.

## The join queue reuses `member.approve` (T049)

Approving or rejecting a join request is the `member.approve` row above — **no new action was
added for T049**, and this table is unchanged by it. The two decisions' routes declare that one
cell, and the queue-specific refusals live beside the matrix, not in it: a request that is not
pending (`409`), the reviewer's own request (`403`) and — for a role above the default
`resident` — `member.role_change`, which only `admin` holds. That last one is the asymmetry the
invitation path also enforces: a Treasurer may say _whether_ somebody joins; only an Admin says
_what they join as_. A pending member renders as an all-dashes column in this table — the fold
of their status gives `permissions: []` — which is itself why nobody approves their own request
while the schema stays as it is.

## Reading it at runtime

`GET /v1/permissions` returns every role with its action list, computed by the same
`actionsFor(role)` this table renders — so a client never has to keep its own copy, and a
client that renders a role picker from a stale bundle cannot offer a role the deployed API
refuses. `GET /v1/permissions/me` and `GET /v1/permissions/members/:memberId` answer the
same question about one membership, with the membership's **status** folded in: a
non-active member's `permissions` is `[]`, because a role's grant is not what applies to
somebody who cannot act.
