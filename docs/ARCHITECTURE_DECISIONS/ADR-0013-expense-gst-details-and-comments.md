# ADR-0013 — GST details and the expense comment stream

**Status:** Accepted · **Date:** 2026-10-08 · **Scope:** T072, binding on T073+ (the
expense detail screen) and on any later task that touches `expense_gst_details` or
`expense_comments`

## Context

T072 must record a tax invoice's details against an expense and add the discussion
stream the PRD puts beside a bill. The Roadmap's acceptance sentence is:

> GSTIN validated by checksum in a value object · CGST+SGST and IGST mutually
> exclusive, enforced by a database constraint · Tax total mismatch warns but does
> not block (real invoices round) · Comments append-only with soft delete by author
> or admin · All members can comment

Eight product questions had no written answer, and each one changes what a member
sees, who can do it, or what a client renders. They were resolved before the
implementation (D1–D8 below) and are recorded verbatim.

Three facts from the pre-implementation audit shaped them:

1. `expense_gst_details` **already existed** (migration #19,
   `20261001120000_expense_schema.sql`) with its five `*_paise` components, its
   `gst_single_regime` CHECK, its `chk_expense_gst_details_non_negative` CHECK, a
   composite `(expense_id, society_id)` key to `expenses`, and RLS ENABLE + FORCE
   with a select/insert/update policy each. It has **no** row of its own identity:
   the expense is its key.
2. No `expense_comments` table, no comment use case and no GSTIN value object
   existed anywhere.
3. The matrix (`packages/domain/src/member/permission-evaluator.ts`) had no GST or
   comment capability, and `expense.create` is full for Admin/Treasurer and
   **scoped (draft only)** for a Committee Member.

## Decisions

### D1 — The comment stream is flat, ordered and append-only

The fast stream is a single chronological list per expense. There is **no
`parent_id` and no nested replies**: the PRD's word "threaded" describes the
discussion belonging to its expense, which is what makes a comment meaningful — the
expense is the thread. This removes the one structure that makes an append-only
stream hard (a reply's position depending on its parent's). Body, author, expense
and society are immutable after insert; a deletion is a **soft delete** and there is
**no application/API hard delete**.

Ordering is a **database-assigned, monotonic identity**
(`sequence bigint GENERATED ALWAYS AS IDENTITY`, `UNIQUE (expense_id, sequence)`) —
never an application-side `MAX(sequence)+1`, which two members commenting at once
would defeat. Concurrent inserts therefore all survive with deterministic order.

Reading that order back has one trap, found by the real-PostgreSQL suite on its
first run (2026-10-08) and pinned there from then on: `sequence` is selected as
`sequence::text as sequence`, and PostgreSQL resolves a bare `order by sequence` to
that **output** column — the opposite of what `GROUP BY` would do — so the stream was
sorted as _text_ (`1, 10, 11, 2`). The identity is table-wide, so the first expense
whose stream crosses a digit-length boundary (9, then 10) would be mis-ordered from
then on. The read therefore qualifies the sort key
(`order by public.expense_comments.sequence asc`), and the integration suite seeds the
positions 9–12 explicitly to pin it.

### D2 — Comments reuse `expense.view`; delete is author-or-Admin

**No `comment.*` permission is created.** Listing and adding use `expense.view`
(every role but Guest), so **a Guest cannot comment** and every other member can.
Soft delete is permitted when the caller is **the comment's author** or holds the
**Admin-only `expense.approve`** capability, resolved through the permission
evaluator (`can(role, "expense.approve")`) — never an inline role string and never
`expense.void`. The database's `expense_comment_soft_delete()` enforces the same two
facts. Cross-society stays **404-not-403**.

### D3 — GST reuse `expense.create`, narrowed per the existing RLS policy

**No `gst.*` permission is created.** Recording GST is part of composing a bill, so
it reuses `expense.create` and is narrowed with `canOnResource` against the stored
expense's snapshot, which is exactly the existing RLS rule: a Committee Member may
write only while the expense is a **`draft`**, Admin/Treasurer at any non-void
status. The GST route is the one new `NARROWED_ROUTES` entry.

### D4 — GST is refused on a `void` expense

A `void` expense is final, so a GST edit would attach tax detail to a document that
no longer exists. The **API refuses `void` for everyone before any write** (a
narrowing stricter than the RLS policy, which has no status check on its
Admin/Treasurer branch) with the established `409 INVALID_TRANSITION`.

Comments are separate discussion records and are **not** disabled on a `void`
expense: the authoritative docs do not require it, and a void is precisely the kind
of event a society discusses.

### D5 — GST details and comments do not invalidate an approval

**This clarifies ADR-0011 D8.** ADR-0011 D8 says "any successful edit of an
approved-but-unpublished expense clears `approved_by`/`approved_at`". A **GST detail
is not an edit of the bill's content**: the upsert names only
`expense_gst_details`, so the approval stamps on `expenses` survive untouched, and
recording a tax invoice must not silently send an approved expense back for a fresh
decision. Comments likewise never invalidate an approval — they are separate
records and touch no column of `expenses`.

The clarification is narrow: a change to the expense's own content (title, amount,
date, category, split configuration or participant set) still clears the approval
per ADR-0011 D8. Only the two T072 records are exempt.

### D6 — Exactly three routes; create-expense is not extended

- `PUT /v1/expenses/:expenseId/gst` — the whole record (a PUT, so it is idempotent
  and an omitted optional field clears rather than leaves). **Do not** extend
  create-expense to accept GST.
- `GET|POST /v1/expenses/:expenseId/comments`
- `DELETE /v1/expenses/:expenseId/comments/:commentId` — **soft**; the module's
  existing delete-route convention is a **`204`** with no body.

### D7 — A tax-total mismatch is a non-blocking warning

PRD §3.5.3: `taxable_value + taxes` must equal `amount` — **warn, don't block**,
because real invoices carry rounding. The relationship, derived from the PRD and the
existing schema, is exactly:

```
taxable_value_paise + cgst_paise + sgst_paise + igst_paise + cess_paise == amount_paise
```

The stable, machine-readable code is **`TAX_TOTAL_MISMATCH`**, returned in a
`warnings` array that is **structurally separate from an error envelope** — a warning
means the write succeeded. Every figure is **bigint paise**, with no float anywhere
on the path. A record with **no** tax information at all (zero taxable value _and_
zero taxes — the table's own defaults) emits no warning, so a GSTIN on file with
nothing filled in is not noisy.

### D8 — Soft delete only; the writable surface is minimised

There is no SQL `DELETE` anywhere on the comment path (`DELETE` is not granted). The
only mutation is `expense_comment_soft_delete()`, `SECURITY DEFINER` for the one
reason `expense_draft_delete()` is: it must force `deleted_by` to the caller's own
membership, which a column-scoped `UPDATE` grant cannot express. It is idempotent —
a second delete returns the already-tombstoned row unchanged rather than moving the
timestamp or forging metadata.

The insert grant is exactly `(society_id, expense_id, author_id, body)`; `sequence`,
`id`, the timestamps and the tombstone columns are uninsertable and unwritable by any
client role. No `UPDATE` grant and no `DELETE` grant exist at all.

## Consequences

- The expense detail screen (T073) renders a flat list in `sequence` order, hides a
  deleted comment's body and may show who deleted it.
- A future task adding nested replies owns a migration that adds `parent_id` and must
  decide how a child orders relative to its parent — this ADR does not pre-empt it.
- A future task adding comment pagination owns a cursor; the current read returns the
  whole stream, because a stream on one bill is bounded by the conversation.
- The `PRD`'s illustrative GSTIN `27AABCK1234M1Z5` is **not** checksum-valid; the
  product's own validator rejects it, and the test suite pins that rejection rather
  than treating the document's example as a fixture.
