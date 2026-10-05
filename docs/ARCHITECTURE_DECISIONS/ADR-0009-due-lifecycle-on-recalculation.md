# ADR-0009 — Financial obligation lifecycle during expense recalculation

**Status:** Accepted · **Date:** 2026-10-05 · **Scope:** T068, consumed by T069 / T086 / T095

## Context

T068 must recalculate a **published** expense when amount, split strategy or
participants change. Before this ADR the schema had no representation for "this
member was liable and is no longer, but the obligation must be preserved": the
only mechanisms available were `ON DELETE CASCADE` (physically delete the due
when its split goes), rewriting the due's amount, or deleting/recreating dues.

### Existing contradiction

1. SAD §8.4 says dues are **"Never deleted — voided instead"**, with `DELETE`
   revoked at the grant level. The shipped
   `fk_dues_split … ON DELETE CASCADE` meant deleting one split silently
   destroyed the receivable — the tier was false as a statement.
2. T067's `expense_publish` already runs `DELETE FROM expense_splits` on every
   publish. It is safe only because dues do not exist yet at publish; any recalc
   that reused that pattern would cascade dues away.
3. The PRD's `payment_allocations` sketch declares `due_id … ON DELETE CASCADE`,
   contradicting SAD §8.1's append-only tier for `payment_allocations`. No
   payments tables exist yet, so this is a requirement on T079+.
4. PRD §3.6 prose lists an `advance` due status that the §7.1 enum and T060 never
   created; T067 already settled credits on `member_balances`.
5. T069's Roadmap acceptance says "dues disappear"; under this ADR that is read
   as "disappear from current outstanding", never as a physical delete.

## Decision

### 1. Approved never-delete principle

A due that has existed as a financial obligation is **never physically deleted**
because an expense is revised, recalculated, or later voided. Financial history
is append/preserve: retained obligations keep their id and payment history;
removed obligations transition to a historical state with their original amount
intact; payment allocations must be able to reference the same due forever.

### 2. Due lifecycle states

| Status           | Meaning                                                   | Open receivable? |
| ---------------- | --------------------------------------------------------- | ---------------- |
| `pending`        | current obligation, unpaid                                | yes              |
| `partial`        | current, `0 < paid < amount`                              | yes              |
| `overdue`        | current, past due date (T078's derivation)                | yes              |
| `paid`           | current, settled by verified payments                     | no               |
| `waived`         | current, deliberately forgiven (`waived_reason`)          | no               |
| `written_off`    | current, bad debt (PRD §3.3)                              | no               |
| **`superseded`** | **historical — was a real obligation, no longer current** | **no**           |

### 3. Exact meaning of `superseded`

A principal due the recalculation no longer allocates to its member. The row
survives with its `id`, `created_at`, `member_id`, `apartment_id`, `expense_id`,
**original `amount_paise`**, and (under T069) its `paid_paise`; only `status`
changes to `superseded`, and `split_id` becomes `NULL` when its split row is
removed. It is excluded from current-principal conservation, from
`member_balances` and from the calculator's outstanding; it remains readable to
its member and managers, remains addressable by future `payment_allocations`,
and is never deleted. It must not be edited to zero, must not be "paid",
"waived" or "written off", and only the recalculation path (T068) or the void
path (T069) may set it.

### 4. New due status required

**Yes.** None of `paid`, `waived`, `written_off` has this meaning. The value is
appended to the enum:

```sql
ALTER TYPE public.due_status ADD VALUE IF NOT EXISTS 'superseded';
```

Appending (not positioning) matters because the enum's order is load-bearing
(`ORDER BY status`, `BETWEEN`), and `superseded` sorts after every current
state; the partial `idx_dues_outstanding … WHERE status IN
('pending','partial','overdue')` is unaffected. A `superseded_at` timestamp
column instead of a status was rejected: every reader would need a second
predicate, and the status vocabulary is already the readers' channel.

### 5. Split relationship

`split_id` is already nullable and `uq_dues_split` is partial on
`split_id IS NOT NULL`; no nullability change is required. The DELETE behaviour
of the composite FK changes:

```sql
-- before
CONSTRAINT fk_dues_split FOREIGN KEY (split_id, society_id)
  REFERENCES public.expense_splits (id, society_id) ON DELETE CASCADE
-- after
CONSTRAINT fk_dues_split FOREIGN KEY (split_id, society_id)
  REFERENCES public.expense_splits (id, society_id) ON DELETE SET NULL (split_id)
```

The column-specific form is mandatory: a plain `SET NULL` would try to null
`NOT NULL` `society_id`; the repository already uses this form for
`fk_dues_apartment`. The FK action fires the deferred `trg_due_billable_write`;
that is safe because the split check is null-guarded and §6 exempts superseded
rows from the published-expense check. Consequence of the new CHECK: the
recalculation must **supersede before deleting the split** — deleting the split
of a still-current due leaves it with a `NULL` split and is refused, aborting
the whole transaction. That ordering is a feature: the database refuses "remove
a split out from under a live obligation".

### 6. `chk_due_billable` change

Keep the function's hardening (SECURITY DEFINER, `SET search_path = ''`, revoked
from every client role) and the trigger's column list (`AFTER INSERT OR UPDATE
OF expense_id, split_id, amount_paise, kind`, deferred) — a status-only
supersession and a payment-path status update must not pay the trigger's cost.
Change the body: skip the published-expense requirement for historical rows
(`IF NEW.expense_id IS NOT NULL AND NEW.status <> 'superseded' THEN …`),
otherwise T069's void would be refused. Keep the per-row split equality for
principal dues with a live split. Add a row-local CHECK for the forward half of
conservation:

```sql
CONSTRAINT chk_due_current_split_present CHECK (
  NOT (expense_id IS NOT NULL AND kind = 'principal'
       AND status <> 'superseded' AND split_id IS NULL)
);
```

### 7. `uq_dues_split` unchanged; one new index

`UNIQUE (split_id) WHERE split_id IS NOT NULL` keeps exactly one due per split
while a due is current and tolerates any number of superseded `NULL`-split dues.
Add the invariant the recalculation's matching depends on — at most one current
principal due per participant per expense:

```sql
CREATE UNIQUE INDEX uq_dues_current_participant
  ON public.dues (expense_id, member_id, apartment_id) NULLS NOT DISTINCT
  WHERE kind = 'principal' AND status <> 'superseded' AND expense_id IS NOT NULL;
```

### 8. Current-principal conservation

For every published expense E:

```
E.amount_paise = SUM(E.expense_splits.amount_paise)                     -- DB-enforced
              = SUM(dues.amount_paise)                                   -- path invariant
                WHERE dues.expense_id = E.id AND dues.kind = 'principal'
                  AND dues.status <> 'superseded'
```

The first equality is `chk_split_total()`/`assert_split_total()`; the second is
maintained by the recalculation path and verified by tests and T095. The reverse
direction — every current split has exactly one current principal due — is
deliberately _not_ a new global trigger: T060's verified suite writes splits
directly on published expenses with no dues, and cycle/late-fee paths may create
principal dues without splits. It is a recalculation-path invariant, with the
per-row equality and the new CHECK as the DB backstop.

### 9. Historical-principal treatment

Superseded dues are excluded from current sums, from `member_balances` and from
the calculator's outstanding/oldest-date logic; they remain in `dues` and in
every read model that shows history. Their amount is the pre-recalculation
obligation, never zero. They are never mutated by recalculation again; the only
future writers are T069's credit conversion and T086's allocation reversals.

### 10. Calculator / status treatment

No logic change in `dues-calculator.ts`: `OUTSTANDING_DUE_STATUSES` stays
`pending | partial | overdue`, so a superseded due is not counted. Export the
vocabulary explicitly (a `SUPERSEDED_DUE_STATUS` constant and the full
seven-value status list) and mirror it in
`packages/db-schema/src/postgres/dues.ts`.

### 11. Member-balance treatment

`member_balances` stays the transactional materialized projection of **current**
obligations; no row is ever deleted to reconcile. The recalculation writes exact
deltas with the same single-statement upsert shape T067 uses (arithmetic in SQL
under the row lock, never read-modify-write in TypeScript):

| Case                        | `total_due_paise` | `outstanding_paise` | `total_paid_paise` | `advance_paise` |
| --------------------------- | ----------------- | ------------------- | ------------------ | --------------- |
| retained, amount A→A′       | `+ (A′−A)`        | `+ (A′−A)`          | unchanged          | unchanged       |
| superseded (unpaid, paid=0) | `− A`             | `− A`               | unchanged          | unchanged       |
| added                       | `+ A`             | `+ A`               | unchanged          | unchanged       |

### 12. `oldest_due_date`

After the writes, recompute for every affected member: `MIN(due_date)` over that
member's dues with status in `pending | partial | overdue`, or `NULL` when none.
The publish-time `LEAST(existing, incoming)` is a creation-only rule and must
not be reused here.

### 13. Behaviour by case

- **Retained** (same `(member_id, apartment_id)`): preserve the due's `id`,
  `created_at`, `paid_paise` and status; update the split row in place and the
  due's `amount_paise` to the new split amount; keep the `split_id` link.
- **Removed, unpaid**: delete the split, set the due to `superseded` **before**
  the delete, preserve the amount, let the FK null `split_id`, apply the balance
  deltas.
- **Removed, partially or fully paid**: **BLOCKED**. New obligation
  `0 < paid_paise`; the whole revision is rejected atomically with
  `DUE_PAID_EXCEEDS_NEW_AMOUNT` (`P0001`) and the instruction "Issue a credit
  adjustment instead." `chk_dues_paid_within_amount` is the DB backstop. T068
  does not create the credit.
- **Amount increase**: amounts and balances rise by exact deltas; status and
  paid history unchanged.
- **Amount decrease**: allowed iff `new amount ≥ paid_paise` for every retained
  due; otherwise the whole revision is rejected as above.
- **Participant addition**: insert split (with snapshot) and a new principal due
  (`pending`, `paid_paise=0`, `due_date` by the publish rule) and add the
  balance deltas. A re-added participant gets a **new due**; the prior one stays
  superseded history — superseded rows are never revived.
- **Split-strategy change**: a whole-set recompute, not a separate code path:
  classify every planned allocation against current principal dues by
  `(member_id, apartment_id)`.
- **Owner-routing change**: the `(member, apartment)` identity changes; the old
  split is deleted and its due superseded (or blocked if paid > 0), a new split
  and due are created for the new member, and both balances move by their exact
  deltas. The recalculation must never mutate a split's `member_id` in place. A
  billable flat with nobody to charge is refused, as at publish.

### 14. Payment-allocation compatibility

Due ids are stable forever under §13, so `payment_allocations.due_id` can
reference a superseded due without orphaning. On T079+: the FK to `dues` must be
`NO ACTION`/`RESTRICT`, **not** the PRD sketch's `ON DELETE CASCADE`; no
recalculation may delete or re-create a due; `paid_paise = SUM(verified
allocations)` survives because superseded dues keep `paid_paise`. Under T068 a
due can only be superseded when `paid_paise = 0`. Future payment code must take
locks in the order **expense → dues** so revision-vs-payment cannot miss a
verified allocation.

### 15. T069 / T086 / T095 compatibility

- **T069**: voids a whole published expense without deleting rows; every due
  transitions to `superseded`, with the paid-to-advance-credit conversion owned
  by T069. The §6 exemption is what makes the void path legal; T069 must not
  physically delete dues, and "dues disappear" is read as "leave outstanding".
- **T086**: credits live on the balance side; T086 must not resurrect, zero or
  delete a superseded due to issue a credit. `kind='adjustment'` dues are new
  positive correction lines.
- **T095**: rebuild contract = §8 + §11 + §12; superseded dues are excluded from
  `total_due_paise`, `outstanding_paise` and `oldest_due_date`, and drift left by
  any future recalculation bug is exactly what the nightly job detects.

### 16. RLS and SECURITY DEFINER

No policy or grant changes. `dues_select_own_or_manager` already lets the owning
member and Admin/Treasurer read superseded rows; the recalculation's writes
happen inside the definer function. Recorded exposure, unchanged from T065: the
`expenses`/`expense_splits` policies and column grants let an Admin/Treasurer
update a published expense and its splits directly, bypassing the RPC; the API
is the enforcement point and T068 must route every published edit through the
RPC and prove it.

`public.expense_recalculate(uuid, uuid, integer, jsonb, jsonb, text)` mirrors
`expense_publish`: `SECURITY DEFINER`, `SET search_path = ''`, fully-qualified
names, `assert_society_membership` + `can_publish_expenses` before any read,
`SELECT … FOR UPDATE` on the expense row before the checks, `expectedVersion`,
refusal when the expense is not `published`, then one transaction: revision
(BEFORE) → splits → dues → `member_balances` deltas → `oldest_due_date` →
expense fields → summary read-back from committed rows. Revoked from
PUBLIC/anon; granted to authenticated.

### 17. Revision semantics (approved product decisions)

`expense_revisions.snapshot` stores the **BEFORE** state — the authoritative
published state being replaced, including its allocation-driving configuration
and authoritative splits. `expense_revisions.version` stores the **PRE-EDIT**
version (`expectedVersion`), so revision version V describes the state that
existed as expense version V before the successful revision. Exactly one
revision row per successful recalculation; append-only.

### 18. Published editable fields (approved product decisions)

Allowed on a published edit: `title`, `description`, `vendorName`,
`amountPaise`, `splitStrategy`, `apartmentBasis`, `splitConfig`,
`participantSelector`, `changeNote`. Forbidden: `expenseDate`, `dueDate`,
`categoryId`, `paidByMemberId`, `paymentSource`, `societyId`, `createdBy`,
`currency`, lifecycle/approval fields. Forbidden fields are **rejected** through
the existing validation/error conventions, never silently ignored. `categoryId`
is immutable after publication in T068; no category-driven rerouting is
implemented through a category edit. Owner-only routing still applies when a
recalculation runs because participants/split configuration changed.

### 19. Diff transport (approved product decision)

No dry-run endpoint and no `dryRun` flag in T068. `PATCH /v1/expenses/:expenseId`
performs the atomic revision and returns the resulting recalculation
summary/diff after successful commit. A dedicated pre-commit preview can be
designed later if product UX requires it.

### 20. Migration plan

Because a new enum value cannot be used in the transaction that adds it, the
change is **two ordered files**:

- **#27 `20261007120000_due_status_superseded.sql`** — only
  `ALTER TYPE … ADD VALUE IF NOT EXISTS 'superseded'` plus the type comment.
- **#28 `20261007130000_due_lifecycle_recalculation.sql`** — FK swap,
  `chk_due_billable` replacement, `chk_due_current_split_present`,
  `uq_dues_current_participant`, `expense_recalculate`.

Migrations #1–26 are immutable. The T060 Down rehearsal replays both in one
transaction, which is safe because that transaction re-creates `due_status`
itself.

### 21. Rollback

The runner is forward-only; each file carries a hand-written `Down` block
executed by the rehearsal. #27's Down is irreversible — enum values cannot be
removed — so it documents that and relies on `IF NOT EXISTS` for re-apply.
#28's Down restores the CASCADE FK and the previous `chk_due_billable`, drops
the new index/CHECK/function; it is valid only when no superseded or
`NULL`-split dues exist, which the block must state. No data rollback is needed:
no superseded or `NULL`-split dues exist before this change.

### 22. Rejected alternatives

- **`ON DELETE CASCADE`** — deletes financial history and would cascade into
  payment allocations.
- **`ON DELETE SET NULL` in the plain form** — would try to null `society_id`;
  accepted only in the column-specific form.
- **Never delete `expense_splits`** — splits are the current bill, not the
  receivable; dead rows complicate uniqueness, conservation and the writer.
- **Zeroing superseded dues** — destroys the historical amount and lies about
  the obligation; status removes it from current sums, not amount.
- **Adjustment dues for recalculation** — a new positive correction line cannot
  cancel a non-negative due without zeroing it; the credit side belongs on the
  balance (T086).
- **Delete/recreate dues** — breaks due identity and payment history.
- **Reviving a superseded due when a participant returns** — a new due is
  created instead, keeping "removed" and "re-added" distinct in history.
- **`superseded_at` timestamp instead of a status**, **reusing
  `written_off`/`waived`**, **negative dues** — rejected for the reasons above.

## Consequences

- The due is the receivable and survives recalculation; the split is the current
  bill and may be removed. History lives in `dues` plus `expense_revisions`.
- Every published edit is one definer transaction that proves current-principal
  conservation; the paid-obligation block is a documented refusal with the
  credit-adjustment instruction.
- T069 can void without deleting history; T086 gets the balance-side credit
  mechanism; T095's rebuild has an exact contract to reconcile.
