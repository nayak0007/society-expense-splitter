# ADR-0010 — Voiding an expense and converting paid amounts into advance credit

**Status:** Accepted · **Date:** 2026-10-06 · **Scope:** T069, binding on T079 / T086 / T095

## Context

T069 must reverse a **published** expense without deleting financial history.
The Roadmap's acceptance sentence is exact and was, before this ADR, ambiguous in
three places:

> Status set to `void` with `voided_at`, `voided_by` and a mandatory reason of at
> least 10 characters · Dues reversed; paid amounts become `advance_paise` on the
> member balance and auto-apply to the next due · **Hard delete is impossible** —
> `DELETE` is revoked at the grant level · Fully audited

Three questions had no written answer, and each one changes the numbers a member
sees:

1. **Do the splits survive?** T068's ADR-0009 §3 supersedes a removed due and
   lets the FK null its `split_id`; T067's `expense_publish` deletes every split
   on each publish. A void is not a recalculation and not a publish, so the
   answer was not derivable.
2. **What does `member_balances.total_paid_paise` mean after a void?** Under
   T067/T068 it is "payments applied to a member's dues". Voiding a due whose
   `paid_paise` is `P` must not silently keep `P` counted as applied to an
   obligation that no longer exists, and must not lose it either.
3. **What does "auto-apply to the next due" actually do at void time?** No
   payment-allocation subsystem exists yet (T079), so the sentence had to be
   pinned to something implementable now, without inventing a payments table.

The three decisions below are the approved product/accounting rulings. ADR-0009
remains authoritative for the due lifecycle and is **not** contradicted here: a
void supersedes dues exactly as ADR-0009 §3/§6 define, it simply does so for
every current principal due of one expense at once.

## Decisions

### Decision 1 — Splits survive void

A void is a **lifecycle transition**, not the deletion of a historical bill.

When a published expense is voided:

- the `expenses` row is preserved;
- `expenses.amount_paise` is preserved;
- **all** `expense_splits` rows are preserved;
- **all** `dues` rows are preserved;
- `dues.amount_paise`, `dues.paid_paise` and `dues.split_id` are preserved;
- `expense_revisions` rows are preserved;
- future payment-allocation history (`payment_allocations`, T079) keeps a stable
  target.

Do **not** delete `expense_splits`. Do **not** NULL `split_id` on a normal T069
void. Every **current** principal due of the expense transitions to
`status = 'superseded'`; dues already superseded by an earlier T068
recalculation are untouched. Historical financial rows remain reconstructable
from `dues` + `expense_splits` + `expense_revisions`.

Consequences: `chk_due_current_split_present` (ADR-0009 §6) stays satisfied
because the due keeps its split; `fk_dues_split`'s `ON DELETE SET NULL`
behaviour is never exercised by T069; and T095's rebuild can sum historical
amounts from `dues` without re-deriving splits.

### Decision 2 — `total_paid_paise` semantics

For `member_balances`:

> `total_paid_paise` means **"payment currently applied to current
> (non-superseded) obligations"**. It is **not** the immutable lifetime
> cash-received ledger.

Lifetime/historical payment evidence belongs to `dues.paid_paise` and (from T079)
to `payment` / `payment_allocations` rows, which persist a void.

Therefore when a current due with `amount = A` and `paid_paise = P` is voided:

```
total_due_paise  -= A
total_paid_paise -= P
advance_paise    += P
outstanding_paise -= A
```

The historical due itself **retains** `amount_paise = A`, `paid_paise = P`,
`status = 'superseded'`.

This preserves the project's established balance equation

```
outstanding_paise = total_due_paise − total_paid_paise − advance_paise
```

which T067's integration suite asserts (`member-balances.integration-spec.ts`,
the calculator-comparison test). ADR-0009 §11's delta table omitted the
`total_paid_paise` row because a recalculation can never touch a due that carries
a payment; **this ADR adds it**, and it is the only place a paid amount moves as
a result of a lifecycle transition.

Worked example (A = 100000, P = 40000):

|                     | before | after                                   |
| ------------------- | ------ | --------------------------------------- |
| historical due      | —      | amount 100000, paid 40000, `superseded` |
| `total_due_paise`   | 100000 | 0                                       |
| `total_paid_paise`  | 40000  | 0                                       |
| `advance_paise`     | 0      | 40000                                   |
| `outstanding_paise` | 60000  | −40000                                  |

The ₹400 has changed **accounting classification** — from applied payment to
available member credit. It has not disappeared, and the balance equation still
holds.

### Decision 3 — Auto-apply advance credit (definition, not allocation)

`advance_paise` represents **available, unconsumed member-level credit**.

T069 **creates** this credit. T069 MUST NOT:

- create fake payment rows;
- create `payment_allocation` rows;
- create negative dues;
- create adjustment dues;
- mutate unrelated dues;
- implement T079;
- implement T086.

The actual consumption of advance credit happens when a later/current obligation
is created or allocated for that member:

```
creditApplied       = min(availableAdvance, newOutstandingObligation)
remainingAdvance    = availableAdvance − creditApplied
remainingOutstanding = newOutstandingObligation − creditApplied
```

This is **automatic**: the member does not choose whether to use available
credit. Until the payment-allocation subsystem exists, this is represented at the
member-balance projection level only — the credit is visible as
`advance_paise` / a negative `outstanding_paise` (permitted by
`docs/guides/MONEY.md` §4), and no allocation row is invented to represent it.

### Future due-level attribution (binding on T079, not implemented in T069)

When T079/payment allocation must attribute advance credit to individual dues,
the deterministic order is:

1. earliest `due_date`;
2. then stable due ID as the tie-breaker.

This is **not** implemented in T069. T079 must also preserve the existing lock
order **`expense → dues`** (ADR-0009 §14) and use deterministic ordering when
more than one expense is involved.

### Existing advance is additive

Void-generated credit is additive. If the member already carries
`advance_paise = X` and the void converts `P`, the result is `X + P`. No existing
credit may be lost or overwritten.

### Waived / written_off current dues fail closed

No production flow creates `waived` or `written_off` dues (the PRD enumerates the
statuses; nothing writes them yet) and their void semantics are undocumented.
T069 therefore **fails closed**: a current principal due of the expense whose
status is `waived` or `written_off` refuses the **whole** void with a stable typed
conflict, and the entire transaction rolls back. No accounting behaviour is
guessed. Already-superseded dues are **not** an error — they carry no current
delta and are ignored.

### Second void is a refusal, not a success

Void is terminal (`EXPENSE_TRANSITIONS`: `void` has no outgoing edges). A second
void answers **`409 INVALID_TRANSITION`**; it is deliberately **not** an
idempotent success, because there is no `Idempotency-Key` on this route and
answering "voided" for a request that voided nothing would be a lie.

### Revision history

T069 writes **no** `expense_revisions` row. `expense_revisions` records published
**edits/recalculations** (ADR-0009 §17); a void is not an edit of the allocation,
it is the end of the bill. Void audit evidence consists of:

- `expenses.status = 'void'`;
- `voided_at`;
- `voided_by`;
- `void_reason`;
- `version` (bumped by the shared `touch_updated_at()` trigger);
- the preserved splits, dues and `paid_paise`;
- the `expense.voided` domain event.

**Limitation, recorded honestly:** the general `audit_logs` infrastructure is
T050's and does not exist. "Fully audited" is therefore **row-level** only
(status/stamps/reason/version plus preserved history), and this ADR does not
pretend otherwise.

### Database hardening (migration #30)

Migrations #1–29 are immutable. #30 is forward-only and adds:

1. **`public.expense_void(uuid, uuid, integer, text)`** — `SECURITY DEFINER`,
   `SET search_path = ''`, fully-qualified names, following `expense_publish` /
   `expense_recalculate`. It is the **authoritative writer**.
2. **A void-completeness backstop.** The lifecycle stamps `voided_at` /
   `voided_by` are deliberately **not** in the `authenticated` `UPDATE` grant
   (T060 withheld them), while `status` and `void_reason` **are**. Without a
   backstop an authenticated direct `UPDATE expenses SET status = 'void',
void_reason = '…'` would produce a partially voided expense: status void, no
   reversal, no stamps. The added CHECK requires that a `void` expense carries
   `voided_at IS NOT NULL`, `voided_by IS NOT NULL` and a `void_reason` meeting a
   DB-safe minimum. Because the client cannot write the stamps, a direct
   client-side `status = 'void'` **cannot complete a valid void** and is refused.

No existing grant is weakened, and no migration #1–29 is modified. The remaining
**owner/repair-script hazard** — `fk_dues_expense ... ON DELETE CASCADE` still
lets the table owner (or a repair script running as owner) cascade dues away with
`expenses` — is recorded here and is not fixable inside T069's scope; the API
never issues such a delete.

### Authoritative void transaction

One PostgreSQL transaction through the definer RPC, in this order:

1. assert society membership (`public.assert_society_membership`, `P0002`);
2. verify `expense.void` capability (`can_publish_expenses`, `42501`);
3. `SELECT` the expense `FOR UPDATE`;
4. verify `status = 'published'`;
5. verify `expectedVersion`;
6. validate the trimmed reason (`>= 10` chars);
7. lock/read the current principal dues;
8. reject `waived` / `written_off` current dues;
9. capture per-member `(A, P)`;
10. compute the exact signed balance deltas **before** any write;
11. transition current principal dues → `superseded`;
12. preserve due id, `amount_paise`, `paid_paise`, `split_id`;
13. set-based `member_balances` update (`total_due -= A`, `total_paid -= P`,
    `advance += P`, `outstanding -= A`);
14. recompute `oldest_due_date` from the authoritative current open dues;
15. update the expense (`status = 'void'`, `voided_at`, `voided_by`,
    `void_reason`; `version` bumped by the trigger);
16. return the authoritative voided expense + summary;
17. commit.

`expense_splits` is **not** modified. Already-superseded dues are **not**
modified.

### Concurrency

Lock order **`expense → current dues → member_balances`**. Void and
recalculation both lock the expense row first, so they serialise: exactly one
valid lifecycle operation wins and the loser sees the winner's committed state
(`EXPENSE_NOT_VOIDABLE` / `EXPENSE_NOT_RECALCULABLE`). Two concurrent voids leave
exactly one winner.

**Recorded for T079:** a future payment path must lock/re-read the expense before
mutating a due. If the payment commits before the void obtains its lock, the
void converts the resulting `paid_paise` into advance credit. If the void owns
the lock first, the payment path must later observe the void/superseded state and
refuse or skip. Payment allocation is not implemented here.

## Consequences

- A void is reversible only by history, never by deletion: every financial row
  survives, and the current projection moves by exact, testable deltas.
- `member_balances.total_paid_paise` is a **current** figure; lifetime cash lives
  in `dues.paid_paise` and (T079+) payment rows. Readers that need "cash ever
  received" must not read `total_paid_paise`.
- T086 owns general credit adjustments and must not resurrect, zero or delete a
  superseded due. T095's rebuild excludes superseded dues from `total_due`,
  `outstanding` and `oldest_due_date`, and now also excludes them from
  `total_paid` (the new row in the delta table is the contract).
- T079 inherits a written, deterministic attribution order and the lock order.
- The `audit_logs` gap remains T050's; T069's evidence is row-level.

## Rejected alternatives

- **Delete the expense's splits on void** — destroys the bill a resident was
  charged against and breaks ADR-0009 §3's reconstructability.
- **NULL `split_id` on every voided due** — pretends the void is the ADR-0009 §3
  "removed participant" case, when the split is still there and still the
  historical bill.
- **Leave `total_paid_paise` untouched** — breaks
  `outstanding = total_due − total_paid − advance` the moment a paid due is
  voided (the equation T067 asserts).
- **Create a payment-allocation or credit-note row to represent the advance** —
  invents T079/T086's schema inside T069 and reports a payment that did not
  happen.
- **Create a negative or adjustment due** — ADR-0009 §22 already rejected it;
  `chk_dues_paid_within_amount` and the non-negative amount rules stand.
- **Make a second void idempotent** — no idempotency key exists on the route, so
  "success" would misreport, and the lifecycle marks `void` terminal.
- **Guess waived/written_off semantics** — undocumented and unwritten; failing
  closed is the only honest option.
- **Rely on a client-side `UPDATE` plus the RPC** — the reversal and the
  transition must be one transaction; the stamps are unreachable from a client
  precisely so they cannot be split.
