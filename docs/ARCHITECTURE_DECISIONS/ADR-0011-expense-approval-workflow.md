# ADR-0011 — The approval workflow for high-value expenses

**Status:** Accepted · **Date:** 2026-10-06 · **Scope:** T070, binding on T071+ / T077 / T107

## Context

T070 must route an expense **at or above** a society's approval threshold through
an Admin before it can be published. The Roadmap's acceptance sentence is:

> Expenses **at or above** `approval_threshold_paise` cannot be published
> directly · Admin-only approve and reject; rejection requires a reason ·
> Approval queue listed with the requester, amount and age · Creator notified on
> both outcomes · Audited

Eight product questions had no written answer and each one changes what a member
sees or what an operator can do. They were resolved before implementation (D1–D8
below) and are **recorded verbatim**; the implementation does not reinterpret
them. Three further facts from the pre-implementation audit shaped the decisions:

1. `expenses.approved_by` / `approved_at` already existed (migration #19) with a
   composite FK and **no writer**; `expense_status` already carried
   `pending_approval`; `society_settings.approval_threshold_paise` already
   existed (default ₹10,000). No rejection columns existed anywhere.
2. The old submission rule (`submitAboveThreshold`, T065) used a **strict `>`**
   comparison and required a **full** `expense.create` grant, so a Committee
   Member's above-threshold draft never entered `pending_approval` — the
   "Committee deadlock".
3. The old publication path (`expense_publish`, T066) published any
   `draft` **or** `pending_approval` row for an Admin or Treasurer, trusting
   `status` alone. A `pending_approval → draft` direct `UPDATE` was also possible
   through the column grants and the `expenses_update_author` policy — a way to
   launder an unapproved high-value expense back into a publishable draft.

## Decisions

### D1 — Rejection target is `draft`

Reject moves `pending_approval → draft`. **No `rejected` value is added to
`expense_status`.** Rejection means "the expense requires
correction/resubmission": the creator edits the draft and submits it again.

Consequences: the lifecycle gains exactly one edge (`pending_approval → draft`),
reached only through the authoritative rejection or edit-routing paths.

### D2 — Rejection metadata is persisted on `expenses`

`rejection_reason text`, `rejected_at timestamptz`, `rejected_by uuid`, with the
same composite tenancy convention as `approved_by` / `voided_by` / `created_by`
(`FOREIGN KEY (col, society_id) REFERENCES members (id, society_id)`).

The reason is **required**, **trimmed**, **≥ 10 characters** and **free of
control characters** — the same rule `createVoidReason` applies to a void reason,
reused rather than restated (`createRejectionReason`).

When a rejected draft is submitted for approval again the three rejection columns
are **cleared**; the approval RPC also clears any stale rejection metadata so an
approved row never carries a rejection stamp. The rejection operation itself never
loses the information it is recording: it is one `UPDATE` that sets the stamps and
the status together.

The resubmission is **not** an RPC — it is the ordinary edit path
(`PATCH /expenses/:id` → `Expense.submitForApproval()` → the repository `UPDATE`) —
and the rejection columns are deliberately **not** in the `authenticated` `UPDATE`
grant (a client that could write them could forge or erase an Admin's decision).
Clearing them is therefore the `BEFORE UPDATE` guard trigger's job: the one
transition that _is_ a resubmission, `draft → pending_approval`, nulls all three
(`chk_expenses_rejection_complete` is evaluated against the rewritten row, so the
clear is always complete). Widening the grant was rejected for the reason above,
and a third RPC would have been a second submission path.

General immutable `audit_logs` remain outside T070 (they are T050's).

### D3 — The threshold comparison is `amount_paise >= approval_threshold_paise`

**At or above** requires approval. The previous strict `>` was a temporary T065
reading and is superseded. The boundary is pinned by test:

| amount (paise) | threshold | approval required |
| -------------- | --------- | ----------------- |
| 999,999        | 1,000,000 | no                |
| 1,000,000      | 1,000,000 | yes               |
| 1,000,001      | 1,000,000 | yes               |

### D4 — The authoritative approval gate is the amount, not `status`

`expense.status` alone must **not** decide whether approval was required. At
publication time the database evaluates:

```text
amount_paise >= current society_settings.approval_threshold_paise
```

and, when true, requires

```text
status = 'pending_approval' AND approved_by IS NOT NULL AND approved_at IS NOT NULL
```

otherwise it raises the stable error `APPROVAL_REQUIRED` with **zero financial
writes** (no split, due, balance or idempotency row).

Consequences:

- a high-value `draft` cannot bypass approval;
- a `pending_approval → draft` flip cannot bypass approval;
- direct PostgREST status manipulation cannot bypass approval;
- the **current** society threshold is authoritative at publish time (a threshold
  change is honoured, and a stale approval of a now-below-threshold expense does
  not deadlock — it publishes normally, and a `pending_approval` row below the
  current threshold is publishable without a deadlock).

Below the current threshold, normal `draft` publication remains allowed. The
financial publication algorithm is **not duplicated**: `public.expense_publish`
is `CREATE OR REPLACE`d in a forward-only migration (`CREATE OR REPLACE`
preserves the algorithm; only the precondition is added around it, before any
financial write).

Defense in depth: even an unexpected `draft` whose amount is at or above the
threshold receives `APPROVAL_REQUIRED` — enforced both by the RPC precondition and
by a `BEFORE UPDATE` trigger on `expenses`.

### Committee submission deadlock — the fix

An otherwise-authorized expense creator who may create/edit a **draft** must be
able to route an approval-requiring expense into `pending_approval`. Entering
`pending_approval` is **not** permission to publish, and approval remains
Admin-only, so:

- the submission rule no longer depends on a **full** `expense.create` grant — it
  is decided by the threshold alone, for any member the write policies admit;
- the `expenses_insert_author` policy's Committee branch accepts
  `status IN ('draft', 'pending_approval')`, and the `expenses_update_author`
  policy's Committee branch accepts a transition **into**
  `status IN ('draft', 'pending_approval')` while the stored row is still a draft
  (its `USING` clause is unchanged), so the legitimate path works without granting
  a Committee Member any new capability — a stored `pending_approval` row remains
  outside their reach, and publication stays Admin/Treasurer + approval-gated;
- the resource decision (`snapshotOf`, `published: status !== 'draft'`) continues
  to refuse a Committee Member editing an already-submitted expense; the workflow
  is submit → (approve | reject) → edit-if-rejected → resubmit.

The full chain is proven by integration tests: Committee creates an eligible
draft → routed to `pending_approval` → Committee cannot approve → Treasurer cannot
approve → Admin approves → an authorized publisher publishes → financial writes
happen **exactly once**.

### D5 — Admin self-approval is allowed

`expense.approve` is a **full** Admin cell, and a single-Admin society must not
deadlock its own high-value expenses. No `approved_by != created_by` rule is added.

A Treasurer cannot approve anything — by **role authorization** (`expense.approve`
has no Treasurer cell), not by a self-approval rule. The Roadmap's "Treasurer
cannot approve their own expense" therefore passes for the correct reason. An
explicit test asserts that an Admin **can** approve their own pending expense.

### D6 — No new domain events, no notification infrastructure

`expense.approved`, `expense.rejected` and `expense.submitted_for_approval` are
**not** added to the closed catalogue. The existing test that deliberately rejects
`expense.approved` is neither weakened nor removed. `expense.published` continues
to be emitted **only** by the T066 publication path, after commit.

**Creator notification delivery is formally DEFERRED to Phase 6 / T107** —
notification infrastructure does not yet exist. The durable workflow state
(`approved_by` / `approved_at` / `rejected_by` / `rejected_at` /
`rejection_reason` plus `version`) is what the later notification/audit design
reads; T070 builds no transport.

### D7 — Routes: `POST /v1/expenses/:expenseId/approve` and `.../reject`

- `POST /v1/expenses/:expenseId/approve` — `{ expectedVersion }`
- `POST /v1/expenses/:expenseId/reject` — `{ expectedVersion, reason }`

Both require `@RequirePermission("expense.approve")` (full Admin cell, so **no**
`NARROWED_ROUTES` entry) and answer `200` with the authoritative expense.

**No approval-queue-specific route is authorized.** The queue reuses
`GET /v1/expenses?status=pending_approval`; the Roadmap-required
`list-approval-queue.use-case.ts` participates in that filtered listing path and
exposes the requester (`createdBy`), amount (`amountPaise`) and age (`createdAt`)
from the existing DTO. `/approval-queue` is not invented.

### D8 — Any successful edit invalidates approval

An approval applies only to the exact expense content/version that was approved.
Any successful edit of an **approved-but-unpublished** expense clears
`approved_by` / `approved_at`, and the resulting state is derived from the **new**
amount against the **current** threshold:

- new amount ≥ current threshold → `status = 'pending_approval'`, fresh approval
  required;
- new amount < current threshold → `status = 'draft'`, approval no longer required.

Previous rejection stamps are cleared when the expense is (re)submitted into
`pending_approval` — approval and rejection are mutually exclusive workflow
states. Stale approval cannot survive a change to amount, category, title,
description, vendor, expense date, due date, paid-by member, payment source,
participant selector, split strategy/config or apartment basis: the conservative
rule is that **any** successful user edit of an approved-but-unpublished expense
invalidates approval.

## Approval semantics

Approval **does not publish**. It is `pending_approval → pending_approval` and
stamps `approved_by = the current Admin member`, `approved_at = authoritative DB
time`; `version` increments. The RPC:

1. asserts society membership;
2. requires Admin / `expense.approve`;
3. `SELECT … FOR UPDATE`s the expense;
4. verifies society/resource;
5. verifies `status = 'pending_approval'`;
6. verifies `expectedVersion`;
7. verifies it is not already approved;
8. stamps `approved_by` / `approved_at`;
9. clears stale rejection metadata;
10. returns the authoritative expense;
11. commits.

No splits. No dues. No member-balance writes. No publication. No
`expense_revisions` row. No domain event.

## Rejection semantics

Rejection is `pending_approval → draft` and sets `approved_by = NULL`,
`approved_at = NULL`, `rejected_by = the current Admin member`,
`rejected_at = authoritative DB time`, `rejection_reason = the validated reason`;
`version` increments. RPC order: membership → Admin capability → `FOR UPDATE` →
status check → `expectedVersion` → validate the reason → transition/stamp →
return the authoritative row → commit. No financial rows are touched.

## The publication precondition

`public.expense_publish` is modified **only** through a new forward-only
migration; the migration that created it is not edited. After locking the expense
and **before any financial write**, the function reads the current society
threshold. When `amount_paise >= threshold` it requires
`status = 'pending_approval' AND approved_by IS NOT NULL AND approved_at IS NOT
NULL`; otherwise it raises `APPROVAL_REQUIRED` and nothing has been written.

## Direct-write hardening

A `BEFORE UPDATE` trigger on `expenses` (`trg_expenses_approval_guard`) closes the
`pending_approval → draft` laundering hole and re-asserts the publication
precondition for any writer that is not the RPC:

- `pending_approval → draft` is refused with `APPROVAL_REQUIRED` unless the same
  `UPDATE` stamps a complete rejection (the authoritative rejection RPC's shape)
  or the new amount is below the **current** threshold (D8's edit routing);
- `draft → pending_approval` (a resubmission) clears the three rejection columns,
  which the edit path cannot do for itself because they are not client-writable
  (D2);
- `draft|pending_approval → published` for an amount at or above the current
  threshold is refused with `APPROVAL_REQUIRED` unless approval stamps are present.

The guard trigger and the two decision RPCs together are migration
`20261009120000_expense_approval.sql`; the resubmission clear travels as its own
forward-only step, `20261010120000_expense_approval_resubmission.sql`, because the
checksum ledger makes an applied migration immutable — the real-PostgreSQL suite
is what found the gap.

The rejection columns are **not** in the `authenticated` `UPDATE` grant, so a
client cannot manufacture a rejection stamp to pass the trigger, and the
lifecycle stamps (`approved_by` / `approved_at` / `published_at` / `voided_at` /
`voided_by`) remain unwritable — the guard can only be satisfied by a complete,
authoritative transition.

No column grant that T065's legitimate edit path depends on is revoked.

## Consequences

- `expense_publish` remains the **one** implementation of financial publication.
  Approval/rejection RPCs touch workflow state only: no participant resolution, no
  split calculation, no split/due/balance write, no publication idempotency.
- ADR-0009 §18's "lifecycle/approval fields" list is unchanged: a published
  recalculation still never touches the approval fields.
- ADR-0010 (T069) is untouched: approval/rejection never modify dues,
  `member_balances`, `advance_paise`, `expense_splits`, superseded dues or void
  credit semantics, and integration tests assert it.
- The durable T070 evidence is **row-level**: `approved_by` / `approved_at` /
  `version` for an approval, `rejected_by` / `rejected_at` / `rejection_reason` /
  `version` for a rejection. General audit rows remain deferred to the audit
  infrastructure task (T050).
- Threshold changes in `society_settings` are another concurrency dimension.
  Publication reads the **current** threshold after locking the expense; T070 does
  **not** introduce a cross-table lock on `society_settings`, because the
  authoritative read happens after the expense lock and the financial invariant
  (a high-value unapproved expense cannot publish) holds regardless of where the
  threshold moves.

## Rejected alternatives

- **Add a `rejected` status value** — a rejected expense is a draft needing
  correction; a fifth lifecycle value would make every screen render a state the
  product does not have and would need a resubmission edge anyway (D1).
- **Enforce `approved_by != created_by`** — deadlocks a single-Admin society (D5).
- **Gate publication on `status`** — a status flip would bypass approval, which is
  exactly the audited P1 hole (D4).
- **Weaken the publish invariant for a below-threshold `pending_approval` row** —
  the row is simply publishable as-is; the invariant only requires approval when
  the amount requires it (D4).
- **A dedicated `/approval-queue` route** — not authorized; the existing filtered
  listing already carries requester, amount and age (D7).
- **Emit approval/rejection events** — the catalogue is closed and no consumer
  exists; notification is T107's (D6).
- **Let a published edit retain an approval** — an approval is bound to the
  content/version it approved; a new amount is a new decision (D8).
