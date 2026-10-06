import type { Clock } from "../shared/clock";
import type {
  ExpenseCategoryId,
  ExpenseId,
  MemberId,
  SocietyId,
} from "../shared/ids";
import { Money } from "../shared/money.vo";
import { err, ok } from "../shared/result";
import type { Result } from "../shared/result";
import { ExpenseSplit } from "./expense-split.vo";
import type { ExpenseSplitAllocation } from "./expense-split.vo";
import { expenseError, InvalidTransitionError } from "./errors";
import type { ExpenseError } from "./errors";
import { expensePublishedEvent, expenseVoidedEvent } from "./events";
import type { ExpenseEvent } from "./events";

/**
 * The `Expense` aggregate — Roadmap T061, PRD §3.4/§3.5, SAD §3.2.
 *
 * ## What this object owns
 *
 * Three rules and nothing else:
 *
 *  1. **The lifecycle.** `draft → pending_approval → published → void`, with the
 *     exact edges below and a typed `InvalidTransitionError` for every other move.
 *     There is no public setter for `status`: a caller can only ask the object to
 *     perform a transition.
 *  2. **The split-total invariant.** A published expense's splits must sum *exactly*
 *     to its amount — no epsilon, no tolerance. The database enforces it at COMMIT
 *     (`chk_split_total`, T060); this is the same rule in the object that owns it, so
 *     a bad publish is refused at the earliest possible moment rather than at the
 *     transaction boundary.
 *  3. **The documented field rules.** A positive amount, a title of at most 120
 *     characters (PRD §3.4), an expense date no more than 30 days in the future
 *     (PRD §3.4, SAD §3.2's sketch), and a void reason of at least 10 characters
 *     (PRD §3.5).
 *
 * ## What this object deliberately does *not* own
 *
 *  - **The split calculation.** It receives allocations and sums them; where they
 *    came from is `@ses/split-engine`'s job (T056–T058), and the participant
 *    resolution that feeds it is T063's.
 *  - **The approval threshold.** PRD §2.2 says expenses above the society's
 *    threshold *enter* `pending_approval`; deciding which ones those are requires
 *    the society's settings, so the use case that loads them (T065) calls
 *    `submitForApproval()` and this object only owns the move.
 *  - **Persistence, id minting and dispatch.** No `save()`, no repository, no bus.
 *    The id is supplied by the caller (the domain package compiles for Hermes, where
 *    there is no `crypto.randomUUID`), and the events a transition returns are
 *    collected by the use case and dispatched after commit (SAD §3.2).
 *  - **Editing.** PRD §3.5 allows a published expense to be edited through a
 *    recalculation flow with a diff preview; none of that is here. The absence of an
 *    edit method is not immutability — it is T065/T066's boundary.
 *
 * ## The lifecycle, as the documents state it
 *
 * ```text
 *   draft ──submitForApproval()──▶ pending_approval
 *     │                                  │  ▲
 *     │                   reject(reason) │  │ approve(by)   (T070, ADR-0011)
 *     │                                  ▼  │
 *     │                              pending_approval (approved)
 *     └────────── publish(allocations) ──┘
 *                        │
 *                        ▼
 *                    published ──void_(reason, by)──▶ void   (terminal)
 * ```
 *
 * - `draft → published` is legal because an expense at or below the threshold is
 *   saved straight to `published` (PRD §3.4's behaviour paragraph).
 * - `published` is reachable from either state, which is why the matrix below lists
 *   it twice — SAD §3.2's own sketch checks `draft || pending_approval`.
 * - `draft` cannot be voided: drafts are hard-deleted by their creator (PRD §3.5).
 *   `pending_approval` cannot be voided either.
 * - `pending_approval → draft` (T070): a rejected expense goes back to being a
 *   draft needing correction, and an edit that takes the amount below the current
 *   threshold returns it to a draft because no approval is required any more. It
 *   is reached **only** through `reject()` and `revertToDraft()`; there is still no
 *   public setter for `status`, and the database refuses the same flip made by a
 *   raw `UPDATE` (`guard_expense_approval_transition`, migration #31).
 * - `void` is terminal: no transition leaves it.
 */
export const EXPENSE_STATUSES = [
  "draft",
  "pending_approval",
  "published",
  "void",
] as const;

export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

/**
 * The transition matrix, explicit and exported.
 *
 * The entity's methods enforce it edge by edge; this is the same machine written
 * down once, so a screen can enable the right buttons without re-deriving the rules
 * and a test can assert the whole matrix rather than one call at a time. A state
 * whose row is empty (`void`) has no outgoing edges — terminal.
 */
export const EXPENSE_TRANSITIONS: Readonly<
  Record<ExpenseStatus, readonly ExpenseStatus[]>
> = Object.freeze({
  draft: Object.freeze(["pending_approval", "published"] as const),
  pending_approval: Object.freeze(["draft", "published"] as const),
  published: Object.freeze(["void"] as const),
  void: Object.freeze([] as const),
});

/** PRD §3.4: `title | string(120)`, and the column is `varchar(120)`. */
export const EXPENSE_TITLE_MAX_LENGTH = 120;

/** The free-text description column (`text`); PRD §3.4's notes field, 2,000 chars. */
export const EXPENSE_DESCRIPTION_MAX_LENGTH = 2000;

/** `expenses.vendor_name varchar(120)` — the column's width, so the wire cannot exceed it. */
export const EXPENSE_VENDOR_NAME_MAX_LENGTH = 120;

/** PRD §3.4: "cannot be > 30 days in the future". */
export const EXPENSE_MAX_FUTURE_DAYS = 30;

/** PRD §3.5: a void reason is "required, min 10 chars". */
export const VOID_REASON_MIN_LENGTH = 10;

/**
 * The minimum rejection reason — the void reason's own rule, reused (ADR-0011
 * D2), because a rejection and a void are the same kind of operator prose: a
 * sentence a member must be able to read and act on.
 *
 * Prefixed `EXPENSE_` because the member module already has a
 * `REJECTION_REASON_MIN_LENGTH` for a join-request rejection (four characters), and
 * the package barrel re-exports both modules: an unprefixed name here would be an
 * ambiguous export, which `pnpm typecheck` refuses outright.
 */
export const EXPENSE_REJECTION_REASON_MIN_LENGTH = VOID_REASON_MIN_LENGTH;

/** Runtime narrowing for a stored status (a row read, a request field). */
export function isExpenseStatus(value: unknown): value is ExpenseStatus {
  return (
    typeof value === "string" &&
    (EXPENSE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Whether an expense in this state may be edited as a draft — PRD §3.5's "Freely
 * editable while `draft` or `pending_approval`".
 *
 * Exported because two layers ask the question and must not answer it differently:
 * `Expense.edit()` refuses the move, and T065's update use case checks it *before*
 * rebuilding an entity (a published row's split set belongs to T068's recalculation
 * flow, not to this door). One predicate, so the two cannot drift.
 *
 * A published expense is **not** in this set: editing it is the recalculation with a
 * diff preview (T068). A void one is terminal (T061's matrix).
 */
export function isExpenseEditableStatus(status: ExpenseStatus): boolean {
  return status === "draft" || status === "pending_approval";
}

// ─────────────────────────────────────────────────────────────────────────────
// Field rules (PRD §3.4/§3.5) — total functions returning `Result`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalises and validates a title — PRD §3.4's `string(120)`, required.
 *
 * Trims and preserves internal spacing (a title is typed prose, and "Lift AMC —
 * Q3" is not improved by collapsing anything); rejects an empty result, a value
 * over the column's width, and control characters. The length is checked *after*
 * trimming so trailing spaces cannot turn a 120-character title into 122.
 */
export function createExpenseTitle(raw: string): Result<string, ExpenseError> {
  const value = raw.trim();

  if (value.length === 0) {
    return err(
      expenseError("validation", "Enter a title.", { field: "title" }),
    );
  }
  if (value.length > EXPENSE_TITLE_MAX_LENGTH) {
    return err(
      expenseError(
        "validation",
        `Title must be at most ${EXPENSE_TITLE_MAX_LENGTH} characters.`,
        { field: "title" },
      ),
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return err(
      expenseError(
        "validation",
        "Title contains characters that are not allowed.",
        {
          field: "title",
        },
      ),
    );
  }

  return ok(value);
}

/** `YYYY-MM-DD`, the shape a Postgres `date` column round-trips as. */
const EXPENSE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates an expense date against the injected clock — PRD §3.4.
 *
 * Two rules, both from the PRD's row: the value must be a real calendar date (the
 * round-trip check rejects `2026-02-30`, which `Date` would otherwise roll forward
 * into March), and it must not be more than 30 days after `now`'s UTC day. `now` is
 * a parameter rather than `Date.now()` for the reason `Clock` exists: a rule about
 * "today" is untestable if it reads the wall clock.
 *
 * The future bound is calendar days, not 720 hours: a bill dated on the 31st is
 * "one month ahead" to a person, and the comparison is on the `YYYY-MM-DD` strings
 * so a leap day or a month boundary cannot shift it by a fraction of a day.
 */
export function createExpenseDate(
  raw: string,
  now: Date,
): Result<string, ExpenseError> {
  const value = raw.trim();

  if (!EXPENSE_DATE_PATTERN.test(value)) {
    return err(
      expenseError("validation", "Enter the expense date as a date.", {
        field: "expenseDate",
      }),
    );
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    return err(
      expenseError("validation", `"${value}" is not a real date.`, {
        field: "expenseDate",
      }),
    );
  }

  const limit = new Date(now.getTime());
  limit.setUTCDate(limit.getUTCDate() + EXPENSE_MAX_FUTURE_DAYS);
  if (value > limit.toISOString().slice(0, 10)) {
    return err(
      expenseError(
        "validation",
        `An expense cannot be dated more than ${EXPENSE_MAX_FUTURE_DAYS} days in the future.`,
        { field: "expenseDate" },
      ),
    );
  }

  return ok(value);
}

/**
 * Normalises and validates a void reason — PRD §3.5's "required, min 10 chars".
 *
 * Its own error code rather than a generic `validation` because this is the one
 * field on the void screen and the client owes the user a specific sentence. The
 * minimum is enforced on the *trimmed* value: ten spaces is not a reason.
 */
export function createVoidReason(raw: string): Result<string, ExpenseError> {
  const value = raw.trim();

  if (value.length < VOID_REASON_MIN_LENGTH) {
    return err(
      expenseError(
        "void_reason_too_short",
        `Give a reason of at least ${VOID_REASON_MIN_LENGTH} characters — residents see it.`,
        { field: "voidReason" },
      ),
    );
  }

  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return err(
      expenseError(
        "validation",
        "The void reason contains characters that are not allowed.",
        { field: "voidReason" },
      ),
    );
  }

  return ok(value);
}

/**
 * Normalises and validates a rejection reason — ADR-0011 D2.
 *
 * The *same* rule as `createVoidReason` — required, trimmed, at least ten
 * characters, no control characters — deliberately reused rather than restated, so
 * the two pieces of operator prose cannot drift apart. `field: "reason"` is the
 * wire name the reject request uses (`rejectExpenseSchema`), which is what lets a
 * form highlight the box the Admin typed in.
 */
export function createExpenseRejectionReason(
  raw: string,
): Result<string, ExpenseError> {
  const trimmed = raw.trim();

  if (trimmed.length < EXPENSE_REJECTION_REASON_MIN_LENGTH) {
    return err(
      expenseError(
        "void_reason_too_short",
        `Give a reason of at least ${EXPENSE_REJECTION_REASON_MIN_LENGTH} characters — the creator sees it.`,
        { field: "reason" },
      ),
    );
  }

  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return err(
      expenseError(
        "validation",
        "The rejection reason contains characters that are not allowed.",
        { field: "reason" },
      ),
    );
  }

  return ok(trimmed);
}

// ─────────────────────────────────────────────────────────────────────────────
// Creation and reconstitution inputs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything `Expense.create()` needs — the PRD §3.4 mandatory fields this object
 * models, plus the two facts it cannot infer.
 *
 * `id` is supplied by the caller because minting a UUID is not available to a
 * package that must compile for Hermes; the API's use case mints it at the boundary
 * and passes the same value to the entity and the INSERT.
 *
 * `createdBy` is the **member** (T060's `created_by` references `members`), which is
 * also what PRD §3.5's "drafts can be hard-deleted by their creator" needs later.
 *
 * Deliberately absent, with their owners: the split strategy/basis/config and the
 * participant selector (their canonical vocabulary lives in `@ses/split-engine`,
 * which *depends on this package* — importing it here would invert the dependency;
 * T065/T066 connect the form to the engine), `vendorName`/`description`/
 * `paymentSource`/`paidByMemberId` (T065's create/update use cases own the form
 * domain), and GST/revisions (T066+).
 */
export interface CreateExpenseProps {
  readonly id: ExpenseId;
  readonly societyId: SocietyId;
  readonly categoryId: ExpenseCategoryId;
  readonly title: string;
  readonly amount: Money;
  readonly expenseDate: string;
  readonly createdBy: MemberId;
  readonly clock: Clock;
}

/**
 * Everything `Expense.reconstitute()` needs — a persisted row, in the entity's own
 * vocabulary (no database column names).
 *
 * Separate from `CreateExpenseProps` because the two doors validate different
 * things: creation applies the PRD's *input* rules (title, future date), while
 * reconstitution applies the *state* rules (a published row has a `publishedAt` and
 * balanced splits; a void row has its reason) and must not re-run a rule about
 * "today" that judged the expense on the day it was written.
 */
/**
 * Everything `Expense.edit()` may change — PRD §3.5's "Freely editable while `draft`
 * or `pending_approval`".
 *
 * **Only the four fields the aggregate itself owns.** `undefined` means "leave
 * unchanged" (the repository convention T062's `UpdateExpenseCategoryInput` records),
 * and there is no `null` spelling because none of the four is nullable.
 *
 * The rest of the expense form — `description`, `vendorName`, `paymentSource`,
 * `paidByMemberId`, the split strategy/basis/config and the participant selector — is
 * deliberately absent: T061 assigned those to T065's *use cases*, and the aggregate
 * cannot own the split vocabulary without inverting the `@ses/split-engine →
 * @ses/domain` dependency. The use case merges them and the repository writes them,
 * inside the same version-checked statement that writes these four.
 */
export interface EditExpenseProps {
  readonly title?: string | undefined;
  readonly amount?: Money | undefined;
  readonly expenseDate?: string | undefined;
  readonly categoryId?: ExpenseCategoryId | undefined;
}

export interface ReconstituteExpenseProps {
  readonly id: ExpenseId;
  readonly societyId: SocietyId;
  readonly categoryId: ExpenseCategoryId;
  readonly title: string;
  readonly amount: Money;
  readonly expenseDate: string;
  readonly createdBy: MemberId;
  readonly status: ExpenseStatus;
  readonly splits: readonly ExpenseSplitAllocation[];
  readonly publishedAt: string | null;
  readonly voidedAt: string | null;
  readonly voidedBy: MemberId | null;
  readonly voidReason: string | null;
  /**
   * The approval stamps (T070, ADR-0011): the Admin membership and instant an
   * approval was recorded, or `null`. They are set only by `approve()`, cleared by
   * `edit()` and `reject()`, and never written by `publish()`.
   */
  readonly approvedBy: MemberId | null;
  readonly approvedAt: string | null;
  /** The rejection stamps, or `null`; cleared by `approve()` and `submitForApproval()`. */
  readonly rejectedBy: MemberId | null;
  readonly rejectedAt: string | null;
  readonly rejectionReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// The entity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The entity's own state, after every rule has already run.
 *
 * Private to the module and deliberately *not* `ReconstituteExpenseProps`: the two
 * public doors take allocations and hand the constructor validated `ExpenseSplit`
 * instances, so there is no path into the class that skips a rule. It is the one
 * shape both `create` and `reconstitute` end at.
 */
interface ExpenseState {
  readonly id: ExpenseId;
  readonly societyId: SocietyId;
  readonly categoryId: ExpenseCategoryId;
  readonly title: string;
  readonly amount: Money;
  readonly expenseDate: string;
  readonly createdBy: MemberId;
  readonly status: ExpenseStatus;
  readonly splits: readonly ExpenseSplit[];
  readonly publishedAt: string | null;
  readonly voidedAt: string | null;
  readonly voidedBy: MemberId | null;
  readonly voidReason: string | null;
  readonly approvedBy: MemberId | null;
  readonly approvedAt: string | null;
  readonly rejectedBy: MemberId | null;
  readonly rejectedAt: string | null;
  readonly rejectionReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export class Expense {
  readonly id: ExpenseId;
  readonly societyId: SocietyId;
  readonly createdBy: MemberId;
  readonly createdAt: string;

  // The four fields `edit()` may change. Private with getters rather than `readonly`
  // public fields so that the *only* way they move is `edit()` — the same shape the
  // status keeps, and the reason a caller cannot assign "what a published expense
  // should have cost" from outside a rule.
  private _categoryId: ExpenseCategoryId;
  private _title: string;
  private _amount: Money;
  private _expenseDate: string;

  private _status: ExpenseStatus;
  private _splits: readonly ExpenseSplit[];
  private _publishedAt: string | null;
  private _voidedAt: string | null;
  private _voidedBy: MemberId | null;
  private _voidReason: string | null;
  // The workflow stamps move only through `approve()`, `reject()`, `edit()` and
  // `submitForApproval()` — the same reason `status` is private with a getter: a
  // caller cannot assign "approved" from outside a rule.
  private _approvedBy: MemberId | null;
  private _approvedAt: string | null;
  private _rejectedBy: MemberId | null;
  private _rejectedAt: string | null;
  private _rejectionReason: string | null;
  private _updatedAt: string;
  private _version: number;

  /** The constructor is private: every instance comes through `create`/`reconstitute`. */
  private constructor(props: ExpenseState) {
    this.id = props.id;
    this.societyId = props.societyId;
    this._categoryId = props.categoryId;
    this._title = props.title;
    this._amount = props.amount;
    this._expenseDate = props.expenseDate;
    this.createdBy = props.createdBy;
    this.createdAt = props.createdAt;
    this._status = props.status;
    this._splits = props.splits;
    this._publishedAt = props.publishedAt;
    this._voidedAt = props.voidedAt;
    this._voidedBy = props.voidedBy;
    this._voidReason = props.voidReason;
    this._approvedBy = props.approvedBy;
    this._approvedAt = props.approvedAt;
    this._rejectedBy = props.rejectedBy;
    this._rejectedAt = props.rejectedAt;
    this._rejectionReason = props.rejectionReason;
    this._updatedAt = props.updatedAt;
    this._version = props.version;
  }

  // ── Construction ───────────────────────────────────────────────────────────

  /**
   * A new expense, in `draft` — PRD §3.4's initial state.
   *
   * Returns a `Result` rather than throwing because every refusal here is user
   * input (an amount, a title, a date) the form must render, not a programmer bug.
   * The order of the checks is deliberate — the amount first (it is the field the
   * whole object is about), then the title, then the date — and the first failure
   * is returned, which is the same "one field at a time" contract the value objects
   * in `member-value-objects.ts` keep.
   */
  static create(props: CreateExpenseProps): Result<Expense, ExpenseError> {
    if (!props.amount.isPositive()) {
      return err(
        expenseError("validation", "An expense must be greater than ₹0.00.", {
          field: "amount",
        }),
      );
    }

    const title = createExpenseTitle(props.title);
    if (!title.ok) return title;

    const expenseDate = createExpenseDate(props.expenseDate, props.clock.now());
    if (!expenseDate.ok) return expenseDate;

    const now = props.clock.nowIso();
    return ok(
      new Expense({
        id: props.id,
        societyId: props.societyId,
        categoryId: props.categoryId,
        title: title.value,
        amount: props.amount,
        expenseDate: expenseDate.value,
        createdBy: props.createdBy,
        status: "draft",
        splits: [],
        publishedAt: null,
        voidedAt: null,
        voidedBy: null,
        voidReason: null,
        approvedBy: null,
        approvedAt: null,
        rejectedBy: null,
        rejectedAt: null,
        rejectionReason: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      }),
    );
  }

  /**
   * A persisted expense, rebuilt without re-running creation's input rules.
   *
   * The state rules *are* re-asserted, because they are the object's own
   * invariants and a read that violates one is a corrupt row, not a form mistake:
   * a published expense must carry `publishedAt` and splits that sum exactly to the
   * amount (the same two rules the T060 migration enforces with a column check and
   * the deferred `chk_split_total` trigger), and a void expense must carry its
   * reason, time and author. An unknown status or a version below 1 is refused with
   * `invariant`, because no writer the product has can produce one.
   *
   * Deliberately **not** checked: the title bounds and the 30-day future date.
   * Those judged the expense when it was written; re-judging them today would make
   * a stored row unreadable the moment the clock moved past its own validity — the
   * failure mode `InvitationStatusAt` avoids by deriving expiry instead of storing
   * it.
   */
  static reconstitute(
    props: ReconstituteExpenseProps,
  ): Result<Expense, ExpenseError> {
    if (!isExpenseStatus(props.status)) {
      return err(
        expenseError("invariant", `Unknown expense status "${props.status}".`, {
          field: "status",
        }),
      );
    }

    if (!Number.isInteger(props.version) || props.version < 1) {
      return err(
        expenseError(
          "invariant",
          `An expense version must be a whole number of at least 1, received ${props.version}.`,
          { field: "version" },
        ),
      );
    }

    const splits: ExpenseSplit[] = [];
    for (const allocation of props.splits) {
      const built = ExpenseSplit.fromAllocation(allocation);
      if (!built.ok) return built;
      splits.push(built.value);
    }

    if (props.status === "published") {
      if (props.publishedAt === null) {
        return err(
          expenseError(
            "invariant",
            "A published expense must carry the instant it was published.",
            { field: "publishedAt" },
          ),
        );
      }
      const total = totalsOf(splits);
      if (!total.equals(props.amount)) {
        return err(splitMismatch(total, props.amount));
      }
    }

    if (props.status === "void") {
      if (
        props.voidReason === null ||
        props.voidedAt === null ||
        props.voidedBy === null
      ) {
        return err(
          expenseError(
            "invariant",
            "A voided expense must carry its reason, instant and author.",
            { field: "voidReason" },
          ),
        );
      }
    } else if (
      props.voidedAt !== null ||
      props.voidedBy !== null ||
      props.voidReason !== null
    ) {
      return err(
        expenseError(
          "invariant",
          "Only a voided expense can carry void fields.",
          { field: "status" },
        ),
      );
    }

    // The workflow stamps are pairs, and the two decisions are mutually exclusive
    // (ADR-0011). A row that carries half an approval, half a rejection, or both
    // decisions at once is corrupt — no writer this module has can produce one, and
    // the entity refuses to rebuild it rather than hand a caller a state the rest
    // of the system cannot act on.
    if ((props.approvedBy === null) !== (props.approvedAt === null)) {
      return err(
        expenseError(
          "invariant",
          "An approval must carry its author and its instant together.",
          { field: "approvedBy" },
        ),
      );
    }

    const rejectionComplete =
      (props.rejectedBy === null) === (props.rejectedAt === null) &&
      (props.rejectedAt === null) === (props.rejectionReason === null);
    if (!rejectionComplete) {
      return err(
        expenseError(
          "invariant",
          "A rejection must carry its reason, its instant and its author together.",
          { field: "rejectionReason" },
        ),
      );
    }

    if (props.approvedAt !== null && props.rejectedAt !== null) {
      return err(
        expenseError(
          "invariant",
          "An expense cannot be approved and rejected at the same time.",
          { field: "status" },
        ),
      );
    }

    return ok(
      new Expense({
        id: props.id,
        societyId: props.societyId,
        categoryId: props.categoryId,
        title: props.title,
        amount: props.amount,
        expenseDate: props.expenseDate,
        createdBy: props.createdBy,
        status: props.status,
        splits: Object.freeze(splits),
        publishedAt: props.publishedAt,
        voidedAt: props.voidedAt,
        voidedBy: props.voidedBy,
        voidReason: props.voidReason,
        approvedBy: props.approvedBy,
        approvedAt: props.approvedAt,
        rejectedBy: props.rejectedBy,
        rejectedAt: props.rejectedAt,
        rejectionReason: props.rejectionReason,
        createdAt: props.createdAt,
        updatedAt: props.updatedAt,
        version: props.version,
      }),
    );
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  get categoryId(): ExpenseCategoryId {
    return this._categoryId;
  }

  get title(): string {
    return this._title;
  }

  get amount(): Money {
    return this._amount;
  }

  /** `YYYY-MM-DD`. A date, not an instant — the PRD's column is `date`. */
  get expenseDate(): string {
    return this._expenseDate;
  }

  get status(): ExpenseStatus {
    return this._status;
  }

  /**
   * The splits of a published expense, frozen.
   *
   * Drafts and pending expenses carry an empty array; a caller that wants "what
   * would be charged" asks the split engine (T064's preview), not this object.
   */
  get splits(): readonly ExpenseSplit[] {
    return this._splits;
  }

  get publishedAt(): string | null {
    return this._publishedAt;
  }

  get voidedAt(): string | null {
    return this._voidedAt;
  }

  get voidedBy(): MemberId | null {
    return this._voidedBy;
  }

  get voidReason(): string | null {
    return this._voidReason;
  }

  /** The Admin membership that approved this version, or `null` (T070). */
  get approvedBy(): MemberId | null {
    return this._approvedBy;
  }

  /** The instant the approval was recorded, or `null`. */
  get approvedAt(): string | null {
    return this._approvedAt;
  }

  /** The Admin membership that rejected this version, or `null`. */
  get rejectedBy(): MemberId | null {
    return this._rejectedBy;
  }

  get rejectedAt(): string | null {
    return this._rejectedAt;
  }

  /** The reason the Admin gave, or `null`; required alongside the other two stamps. */
  get rejectionReason(): string | null {
    return this._rejectionReason;
  }

  /**
   * Whether an Admin has approved the *current* content of this expense.
   *
   * The publication gate asks this — but the authoritative answer is the
   * database's, evaluated against the **current** society threshold at publish
   * time (ADR-0011 D4): this getter describes the row, it does not decide.
   */
  get isApproved(): boolean {
    return this._approvedBy !== null && this._approvedAt !== null;
  }

  get updatedAt(): string {
    return this._updatedAt;
  }

  /**
   * Bumped by every successful transition and by `edit()`; optimistic locking is T065's
   * use case, which states the expected version to the repository's atomic `UPDATE`.
   */
  get version(): number {
    return this._version;
  }

  /** Whether the explicit matrix allows this move from the current state. */
  canTransitionTo(next: ExpenseStatus): boolean {
    return EXPENSE_TRANSITIONS[this._status].includes(next);
  }

  // ── Transitions ────────────────────────────────────────────────────────────

  /**
   * `draft | pending_approval` fields → the same state, one version later — PRD §3.5's
   * "Freely editable while `draft` or `pending_approval`" — Roadmap T065.
   *
   * ## What it owns, and what it refuses
   *
   * Only the four fields the aggregate holds (title, amount, date, category). Every
   * supplied field re-runs the *input* rule the create door runs — a positive amount,
   * the title bounds, a real date no more than 30 days ahead — in the same order, and
   * **nothing changes unless every supplied field passes**: the locals are assigned
   * only after the last check, so a failed edit leaves the expense exactly as it was.
   * An absent field is untouched, which is what lets a PATCH carry one key.
   *
   * A published or void expense is refused with `invalid_transition` before any field
   * is read: editing a published expense is T068's recalculation with a diff preview,
   * not this door, and a field error about a bill the caller cannot edit here would be
   * advice they cannot act on.
   *
   * ## Version, events, persistence
   *
   * Success bumps the version from the injected clock — the write the repository then
   * performs is optimistic-locked on the version the caller stated (T065's use case),
   * so the object's semantics and the row's cannot disagree. Raises **no event**: the
   * catalogue has `expense.published` and `expense.voided` and nothing for an edit,
   * and the PRD's "every edit creates a revision" is a persistence fact T068 owns.
   */
  edit(changes: EditExpenseProps, clock: Clock): Result<void, ExpenseError> {
    if (!isExpenseEditableStatus(this._status)) {
      return err(
        expenseError(
          "invalid_transition",
          `A ${this._status} expense cannot be edited as a draft. Only drafts and expenses awaiting approval can be edited.`,
          { from: this._status },
        ),
      );
    }

    if (changes.amount !== undefined && !changes.amount.isPositive()) {
      return err(
        expenseError("validation", "An expense must be greater than ₹0.00.", {
          field: "amount",
        }),
      );
    }

    let title = this._title;
    if (changes.title !== undefined) {
      const next = createExpenseTitle(changes.title);
      if (!next.ok) return next;
      title = next.value;
    }

    let expenseDate = this._expenseDate;
    if (changes.expenseDate !== undefined) {
      const next = createExpenseDate(changes.expenseDate, clock.now());
      if (!next.ok) return next;
      expenseDate = next.value;
    }

    this._amount = changes.amount ?? this._amount;
    this._title = title;
    this._expenseDate = expenseDate;
    if (changes.categoryId !== undefined) {
      this._categoryId = changes.categoryId;
    }

    // An approval is bound to the exact content/version that was approved, so a
    // successful edit invalidates it — conservatively, for *any* change, not only
    // a money change (ADR-0011 D8). The call site then re-routes the expense from
    // the new amount against the current threshold: back to `pending_approval`
    // when approval is still required, or to `draft` when it is not.
    //
    // The database does this too, in `guard_expense_approval_transition()`
    // (migration #31), because the lifecycle stamps are not client-writable and a
    // raw edit must not be able to keep an approval it no longer deserves.
    this._approvedBy = null;
    this._approvedAt = null;

    this.touch(clock.nowIso());
    return ok(undefined);
  }

  /**
   * `draft → pending_approval` — the expense needs an Admin's approval before it can
   * be billed (PRD §2.2's threshold, decided by the caller).
   *
   * Raises no event: the domain-events catalogue (SAD §3.2) has `ExpensePublished`
   * and `ExpenseVoided` and no "submitted", and inventing one here would put a
   * consumer-facing name on the wire before anything consumes it.
   */
  submitForApproval(clock: Clock): Result<void, ExpenseError> {
    const refused = this.refuseTransition("pending_approval");
    if (refused !== null) return err(refused);

    this._status = "pending_approval";

    // Re-submitting a rejected draft clears the rejection it answers, and a fresh
    // submission carries no approval — approval and rejection are mutually
    // exclusive workflow states (ADR-0011 D8).
    this._rejectedBy = null;
    this._rejectedAt = null;
    this._rejectionReason = null;
    this._approvedBy = null;
    this._approvedAt = null;

    this.touch(clock.nowIso());
    return ok(undefined);
  }

  /**
   * `pending_approval → pending_approval`, one version later, with the approval
   * stamped — T070 (ADR-0011).
   *
   * ## Approval is not publication
   *
   * This method deliberately does **not** call `publish()`: approving is the
   * Admin's decision, publishing is T066's financial transaction (splits, dues,
   * balances, stamps), and the two are separate facts. An approved expense stays
   * `pending_approval` until an authorized publisher publishes it, which is what
   * makes "publish refused for lack of approval" and "publish succeeds after
   * approval" two different tests rather than one.
   *
   * ## What it owns
   *
   * The state check (`pending_approval` only — the matrix has no other source), the
   * stamping of `approvedBy`/`approvedAt` from the caller's membership and the
   * injected clock, and the clearing of any rejection metadata so the two decisions
   * can never coexist on one row. Raises **no event**: the catalogue is closed
   * (SAD §3.2, ADR-0011 D6) and notification is T107's.
   */
  approve(by: MemberId, clock: Clock): Result<void, ExpenseError> {
    // Approval is `pending_approval → pending_approval`: the status does not
    // change, so there is no matrix edge to consult — only the source state to
    // check. (`EXPENSE_TRANSITIONS` describes *moves*, and a self-loop is not a
    // move; listing it there would let `submitForApproval()` re-approve a row.)
    if (this._status !== "pending_approval") {
      return err(new InvalidTransitionError(this._status, "approved"));
    }

    const at = clock.nowIso();
    this._approvedBy = by;
    this._approvedAt = at;
    this._rejectedBy = null;
    this._rejectedAt = null;
    this._rejectionReason = null;
    this.touch(at);
    return ok(undefined);
  }

  /**
   * `pending_approval → draft` — T070's rejection (ADR-0011 D1/D2).
   *
   * A rejection is *not* a terminal state and there is no `rejected` status: the
   * expense goes back to being a draft its creator may correct and submit again.
   * The Admin's decision is recorded in the three stamps, and the approval (if one
   * somehow existed on the same version) is cleared — the two decisions are
   * opposites about the same version and must not coexist.
   *
   * The reason is validated **before** the state check, matching `void_()`'s order:
   * the field error answers "what should I type", which is true regardless of the
   * state, and it travels in `field: "reason"` — the wire name the reject request
   * uses. Raises **no event** (ADR-0011 D6).
   */
  reject(
    reason: string,
    by: MemberId,
    clock: Clock,
  ): Result<void, ExpenseError> {
    const rejectionReason = createExpenseRejectionReason(reason);
    if (!rejectionReason.ok) return rejectionReason;

    if (this._status !== "pending_approval") {
      return err(new InvalidTransitionError(this._status, "draft"));
    }

    const at = clock.nowIso();
    this._status = "draft";
    this._approvedBy = null;
    this._approvedAt = null;
    this._rejectedBy = by;
    this._rejectedAt = at;
    this._rejectionReason = rejectionReason.value;
    this.touch(at);
    return ok(undefined);
  }

  /**
   * `pending_approval → draft` for the *edit* path — T070 (ADR-0011 D8).
   *
   * Distinct from `reject()` because the two are different facts with different
   * stamps: a rejection records an Admin's decision and its reason, while this is
   * the *creator's* edit taking the amount below the current threshold — approval is
   * no longer required, so the expense is simply a draft again. It clears any
   * approval (an edit invalidates one) and records no rejection, because nobody
   * rejected anything.
   *
   * Reached only from the submission routing in `submitAboveThreshold`, which is
   * the one place that knows the current society threshold. The name is explicit on
   * purpose: `status` still has no public setter, and the database refuses the same
   * flip made by a raw `UPDATE` (migration #31's guard).
   */
  revertToDraft(clock: Clock): Result<void, ExpenseError> {
    if (this._status !== "pending_approval") {
      return err(new InvalidTransitionError(this._status, "draft"));
    }

    this._status = "draft";
    this._approvedBy = null;
    this._approvedAt = null;
    this.touch(clock.nowIso());
    return ok(undefined);
  }

  /**
   * `draft | pending_approval → published` — the bill becomes real.
   *
   * Takes the engine's allocations (T056–T058) and enforces the invariant:
   *
   * ```text
   *   Σ allocations.amount === expense.amount        (exact paise, no epsilon)
   * ```
   *
   * Each allocation is validated into an `ExpenseSplit` first (a negative amount or
   * a blank flat label is a field error), then the sum is compared with `Money`'s
   * exact arithmetic. A mismatch — including *no allocations at all* — is refused
   * with `split_mismatch` and **nothing about the expense changes**: the state,
   * splits, timestamps and version are only written once the whole invariant holds.
   *
   * On success the splits are frozen into the object, `publishedAt` is stamped from
   * the injected clock, the version is bumped, and the raised event is returned.
   */
  publish(
    allocations: readonly ExpenseSplitAllocation[],
    clock: Clock,
  ): Result<readonly ExpenseEvent[], ExpenseError> {
    const refused = this.refuseTransition("published");
    if (refused !== null) return err(refused);

    const splits: ExpenseSplit[] = [];
    for (const allocation of allocations) {
      const built = ExpenseSplit.fromAllocation(allocation);
      if (!built.ok) return built;
      splits.push(built.value);
    }

    const total = totalsOf(splits);
    if (!total.equals(this.amount)) {
      return err(splitMismatch(total, this.amount));
    }

    const at = clock.nowIso();
    this._splits = Object.freeze(splits);
    this._status = "published";
    this._publishedAt = at;
    this.touch(at);
    return ok([
      expensePublishedEvent(this.id, this.societyId, this.amount, at),
    ]);
  }

  /**
   * `published → void` — PRD §3.5: published expenses are never hard-deleted, they
   * are voided, and the reason is required and at least 10 characters.
   *
   * The reason is validated **before** the state check, matching SAD §3.2's sketch:
   * the field error answers "what should I type", which is true regardless of the
   * state, and a published expense with a short reason gets the actionable message
   * rather than "this expense is a draft".
   *
   * Raises `expense.voided`. Reversing the dues and turning verified payments into
   * advance credit is T066/T067's transaction, not the entity's.
   */
  void_(
    reason: string,
    by: MemberId,
    clock: Clock,
  ): Result<readonly ExpenseEvent[], ExpenseError> {
    const voidReason = createVoidReason(reason);
    if (!voidReason.ok) return voidReason;

    const refused = this.refuseTransition("void");
    if (refused !== null) return err(refused);

    const at = clock.nowIso();
    this._status = "void";
    this._voidReason = voidReason.value;
    this._voidedBy = by;
    this._voidedAt = at;
    this.touch(at);
    return ok([
      expenseVoidedEvent(this.id, this.societyId, by, voidReason.value, at),
    ]);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /**
   * The typed refusal for a move the matrix does not have, or `null` when it does.
   *
   * One implementation for all three transitions, reading `EXPENSE_TRANSITIONS`
   * rather than each method restating its allowed source states — the matrix is the
   * machine, and a method that disagreed with it would be a second machine.
   */
  private refuseTransition(next: ExpenseStatus): InvalidTransitionError | null {
    if (this.canTransitionTo(next)) return null;
    return new InvalidTransitionError(this._status, next);
  }

  /**
   * Every successful transition writes `updated_at` and bumps the row's version,
   * from the instant the transition already read — one transition, one timestamp,
   * so `publishedAt` and `updatedAt` agree even under a stepping clock.
   */
  private touch(at: string): void {
    this._updatedAt = at;
    this._version += 1;
  }
}

/** The exact sum of a split set, in `Money`'s arithmetic. */
function totalsOf(splits: readonly ExpenseSplit[]): Money {
  return splits.reduce((sum, split) => sum.add(split.amount), Money.zero());
}

/** The one construction of the conservation refusal, shared by both doors. */
function splitMismatch(total: Money, amount: Money): ExpenseError {
  return expenseError(
    "split_mismatch",
    `The splits total ${total.format()} but the expense is ${amount.format()}.`,
    {
      totalPaise: total.paise.toString(),
      amountPaise: amount.paise.toString(),
    },
  );
}
