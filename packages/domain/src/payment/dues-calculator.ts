/**
 * `dues-calculator` — the money arithmetic behind dues and the `member_balances`
 * summary (PRD §3.5, §7.3; SAD §8.6; Roadmap T067's own row).
 *
 * ## What it computes, and why it is a pure function
 *
 * The PRD states one formula — "A member's **outstanding balance** is a derived
 * value: `outstanding = Σ(dues.amount) − Σ(payments.allocated_amount where
 * verified) − Σ(credits) + Σ(late_fees)`" — and one maintenance rule: the
 * `member_balances` summary is "refreshed transactionally on every due/payment
 * write". Those are the two operations here:
 *
 *   * {@link calculateOutstanding} — the formula, over the open due lines, with a
 *     signed result (a member in credit is negative; `docs/guides/MONEY.md` §4,
 *     "outstanding balances are negative amounts").
 *   * {@link projectDueCreation} — the balance effect of the dues a publication
 *     just created: add the delta, move `oldest_due_date` earlier only. This is
 *     the *same* arithmetic the publishing transaction expresses as
 *     `ON CONFLICT … outstanding = outstanding + EXCLUDED.…` — deliberately the
 *     same, because the integration suite asserts the committed
 *     `member_balances` row equals this function's projection for the same rows.
 *
 * Pure and framework-free, like everything in this package: no database, no
 * clock, no I/O, and every amount an exact `bigint` paise. `@ses/api` cannot be
 * imported from here and this module imports nothing at all beyond the shared
 * money primitives — the domain package has zero runtime dependencies, which is
 * why it compiles for Hermes and for Node unchanged.
 *
 * ## Counting rules, stated once
 *
 *  * **Open lines only.** A due that is `paid`, `waived` or `written_off` is not
 *    an open receivable and contributes to nothing here — no amount, no paid
 *    total, no `oldest_due_date`. `pending`, `partial` and `overdue` are the open
 *    set (the same set T060's partial index `idx_dues_outstanding` names for the
 *    hot list).
 *  * **Each line is counted once.** `dues.amount_paise` is the charge;
 *    `dues.paid_paise` is the verified allocation already applied to it (SAD §8.6
 *    invariant 3: "must equal the sum of verified allocations"), so the PRD's
 *    "Σ(dues.amount) − Σ(payments…)" is `Σ amount − Σ paid` over the same rows —
 *    not amount minus a *separate* payment total, which would double-count a
 *    partial payment. `late_fee` and `adjustment` lines are part of the same
 *    `Σ(dues)` term, which is how the formula's trailing `+ Σ(late_fees)` is
 *    satisfied without counting a late fee twice.
 *  * **Credits are a magnitude input**, subtracted once; the caller reads them
 *    from `member_balances.advance_paise` (or a credit note). A negative credit
 *    is a caller bug and is refused rather than silently added.
 *
 * ## What this module deliberately does not do
 *
 * No due-date policy (the database derives `dues.due_date` from the society's
 * settings inside the publishing transaction — one rule, one implementation), no
 * persistence, no events, and no payment allocation (T079+). Amounts must be
 * exact integers; a float here is not refused by rounding, it cannot be expressed
 * — the parameters are `Paise`, the branded `bigint`.
 */

import { paise, ZERO_PAISE, type Paise } from "../shared/money";
import { moneyError } from "../shared/money.vo";

/** The three kinds the `dues.kind` CHECK allows (PRD §7.3). */
export const DUE_KINDS = ["principal", "late_fee", "adjustment"] as const;
export type DueKind = (typeof DUE_KINDS)[number];

/**
 * The due statuses that are still an open receivable. `paid` is settled, and
 * `waived`/`written_off` are the two documented ways a charge stops being owed.
 */
export const OUTSTANDING_DUE_STATUSES = [
  "pending",
  "partial",
  "overdue",
] as const;
export type OutstandingDueStatus = (typeof OUTSTANDING_DUE_STATUSES)[number];

/** One due row, as the calculator reads it. Dates are ISO `YYYY-MM-DD` strings. */
export interface OutstandingDueLine {
  readonly kind: DueKind;
  /** The row's `status`; only {@link OUTSTANDING_DUE_STATUSES} are counted. */
  readonly status: string;
  /** The charge, in paise. Never negative. */
  readonly amountPaise: Paise;
  /** The verified allocation already applied to this row (0 when none). */
  readonly paidPaise: Paise;
  readonly dueDate: string;
}

/** The PRD §3.5 figures, all exact. `outstandingPaise` is signed. */
export interface OutstandingBalance {
  /** Open principal dues, before credits and payments. */
  readonly principalPaise: Paise;
  /** Open late-fee dues — the formula's `Σ(late_fees)` term. */
  readonly lateFeePaise: Paise;
  /** Open adjustment dues. */
  readonly adjustmentPaise: Paise;
  /** `principal + lateFee + adjustment`, the formula's `Σdues` term. */
  readonly totalDuePaise: Paise;
  /** `Σ paid` over the open lines — the formula's verified-payments term. */
  readonly paidPaise: Paise;
  /** The credits subtracted (the formula's `Σ(credits)` term). */
  readonly creditsPaise: Paise;
  /** `totalDue − paid − credits`. Negative means the member is in credit. */
  readonly outstandingPaise: Paise;
  /** The earliest due date still open, ISO, or `null` when nothing is open. */
  readonly oldestDueDate: string | null;
}

/**
 * The maintained `member_balances` row, as data. `outstandingPaise` is signed and
 * `oldestDueDate` is `null` exactly when nothing is outstanding.
 */
export interface MemberBalanceState {
  readonly totalDuePaise: Paise;
  readonly totalPaidPaise: Paise;
  readonly advancePaise: Paise;
  readonly outstandingPaise: Paise;
  readonly oldestDueDate: string | null;
}

/** One newly created due, as a publication produces them. */
export interface CreatedDue {
  readonly amountPaise: Paise;
  readonly dueDate: string;
}

/** {@link MemberBalanceState} for a member with no rows yet. */
export const ZERO_BALANCE: MemberBalanceState = Object.freeze({
  totalDuePaise: ZERO_PAISE,
  totalPaidPaise: ZERO_PAISE,
  advancePaise: ZERO_PAISE,
  outstandingPaise: ZERO_PAISE,
  oldestDueDate: null,
});

/**
 * `outstanding = Σdues − Σverified payments − Σcredits + Σlate fees` (PRD §3.5),
 * over the open due lines, exactly.
 *
 * The result is signed: credits can exceed what is owed (an advance credit), and
 * the balance then says so rather than clamping to zero — the clamp is what makes
 * a credit disappear.
 */
export function calculateOutstanding(input: {
  readonly dues: readonly OutstandingDueLine[];
  /** Credits to subtract — `member_balances.advance_paise`. Defaults to zero. */
  readonly creditsPaise?: Paise;
}): OutstandingBalance {
  const creditsPaise = input.creditsPaise ?? ZERO_PAISE;
  assertNonNegative(creditsPaise, "creditsPaise", "validation");

  let principal: bigint = 0n;
  let lateFees: bigint = 0n;
  let adjustments: bigint = 0n;
  let paid: bigint = 0n;
  let oldest: string | null = null;

  for (const due of input.dues) {
    assertNonNegative(due.amountPaise, "amountPaise", "invariant");
    assertNonNegative(due.paidPaise, "paidPaise", "invariant");
    if (due.paidPaise > due.amountPaise) {
      throw moneyError(
        "invariant",
        `A due's paid amount cannot exceed its amount: ${due.paidPaise.toString()} of ${due.amountPaise.toString()}.`,
        { field: "paidPaise" },
      );
    }

    if (!isOutstandingDue(due.status)) continue;

    assertIsoDate(due.dueDate);
    paid += due.paidPaise;
    switch (due.kind) {
      case "principal":
        principal += due.amountPaise;
        break;
      case "late_fee":
        lateFees += due.amountPaise;
        break;
      case "adjustment":
        adjustments += due.amountPaise;
        break;
    }
    if (oldest === null || due.dueDate < oldest) {
      oldest = due.dueDate;
    }
  }

  const totalDue = principal + lateFees + adjustments;
  return {
    principalPaise: paise(principal),
    lateFeePaise: paise(lateFees),
    adjustmentPaise: paise(adjustments),
    totalDuePaise: paise(totalDue),
    paidPaise: paise(paid),
    creditsPaise,
    outstandingPaise: paise(totalDue - paid - creditsPaise),
    oldestDueDate: oldest,
  };
}

/**
 * The balance effect of creating dues — what the publishing transaction commits.
 *
 * `total_due_paise` and `outstanding_paise` grow by the sum of the new lines, and
 * `oldest_due_date` becomes the earlier of the current value and the earliest new
 * due date. Paid totals and advance credits are untouched: this operation adds
 * receivables, and a publication settles nothing.
 *
 * An empty set of new dues is the identity — a no-op over the current state, or
 * {@link ZERO_BALANCE} when there is no state yet.
 */
export function projectDueCreation(
  current: MemberBalanceState | null,
  created: readonly CreatedDue[],
): MemberBalanceState {
  const base = current ?? ZERO_BALANCE;
  let delta: bigint = 0n;
  let oldest = base.oldestDueDate;

  for (const due of created) {
    assertNonNegative(due.amountPaise, "amountPaise", "invariant");
    assertIsoDate(due.dueDate);
    delta += due.amountPaise;
    if (oldest === null || due.dueDate < oldest) {
      oldest = due.dueDate;
    }
  }

  if (created.length === 0) return base;

  return {
    totalDuePaise: paise(base.totalDuePaise + delta),
    totalPaidPaise: base.totalPaidPaise,
    advancePaise: base.advancePaise,
    outstandingPaise: paise(base.outstandingPaise + delta),
    oldestDueDate: oldest,
  };
}

/** Whether a `due_status` names an open receivable (see the module docstring). */
export function isOutstandingDue(status: string): boolean {
  return (OUTSTANDING_DUE_STATUSES as readonly string[]).includes(status);
}

/** A due amount is a magnitude; a negative one is a corrupted row, not a credit. */
function assertNonNegative(
  value: bigint,
  field: string,
  code: "validation" | "invariant",
): void {
  if (value < 0n) {
    throw moneyError(code, `A due cannot carry a negative ${field}.`, {
      field,
    });
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `due_date` is a `date` column and reaches this module as its ISO rendering; a
 * caller that passes anything else gets a typed refusal rather than a date string
 * that silently sorts wrong (the oldest-due comparison is lexicographic, which is
 * only meaningful for ISO).
 */
function assertIsoDate(value: string): void {
  if (!ISO_DATE.test(value)) {
    throw moneyError(
      "invariant",
      `A due date must be an ISO yyyy-mm-dd date, received "${value}".`,
      { field: "dueDate" },
    );
  }
}
