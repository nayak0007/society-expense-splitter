import type { ApartmentId, MemberId } from "../shared/ids";
import type { Money, Weight } from "../shared/money.vo";
import { err, ok } from "../shared/result";
import type { Result } from "../shared/result";
import { expenseError } from "./errors";
import type { ExpenseError } from "./errors";

/**
 * `ExpenseSplit` — what one participant owes for one expense (PRD §3.5, T061).
 *
 * ## What it is, and what it deliberately is not
 *
 * A frozen value object built from a split engine **allocation**, holding exactly the
 * five facts the bill needs: who (`memberId`), which flat (`apartmentId`), the flat's
 * label **as it was when the expense was published** (`apartmentNumber`), how much
 * (`amount`) and the engine's weight for the basis that produced it (`weight`).
 * The label is the snapshot PRD §3.5 requires — "the resolved list is snapshotted
 * into `expense_splits` at publish so later membership changes never silently rewrite
 * history" — which is why it is copied here rather than resolved from a flat later.
 *
 * ## Why the input is a structural interface
 *
 * `@ses/split-engine`'s `SplitAllocation` is exactly this shape, but this package is
 * the *innermost* one and the engine depends on it, so importing the engine's type
 * here would invert the dependency (SAD §3.1) and fail `lint:arch`. The interface
 * below is structural, so the engine's allocation is assignable to it **without any
 * mapping layer and without a type assertion** — if the engine's shape changes, this
 * stops compiling rather than silently dropping a field.
 *
 * ## What the database adds underneath
 *
 * `expense_splits.amount_paise >= 0` (an exemption is a real, deliberate ₹0
 * allocation — SPLIT_ENGINE.md §5), the participant check (a member or a flat;
 * both nullable there because a due may attach to a flat with no owner membership),
 * and `uq_expense_splits_participant`. This object mirrors the non-negativity rule
 * and refuses a blank label; the tenancy and uniqueness rules are the table's, for
 * the same reason the migration records — a constraint the writer cannot bypass
 * belongs in the database.
 *
 * Later phases resolve participants into this shape (T063) and snapshot the member's
 * name into `snapshot` (T066); neither belongs to the value object, which is a pure
 * function of the allocation it is handed.
 */

/**
 * The engine's allocation, structurally.
 *
 * Field names match `SplitAllocation` on purpose (memberId, apartmentId,
 * apartmentNumber, amount, weight) so the engine's result is accepted directly.
 */
export interface ExpenseSplitAllocation {
  readonly memberId: MemberId;
  readonly apartmentId: ApartmentId;
  readonly apartmentNumber: string;
  readonly amount: Money;
  readonly weight: Weight;
}

export class ExpenseSplit {
  readonly memberId: MemberId;
  readonly apartmentId: ApartmentId;
  readonly apartmentNumber: string;
  readonly amount: Money;
  readonly weight: Weight;

  private constructor(allocation: ExpenseSplitAllocation) {
    this.memberId = allocation.memberId;
    this.apartmentId = allocation.apartmentId;
    this.apartmentNumber = allocation.apartmentNumber;
    this.amount = allocation.amount;
    this.weight = allocation.weight;
    Object.freeze(this);
  }

  /**
   * The one construction path: validates the two rules this object owns, then freezes.
   *
   * Returns a `Result` rather than throwing because a negative allocation is an
   * expected failure of a *computed* split — an adapter bug or a corrupted preview —
   * that the publish path must report as a field error, not crash on. `Money`
   * already guarantees the currency (INR) and exactness.
   */
  static fromAllocation(
    allocation: ExpenseSplitAllocation,
  ): Result<ExpenseSplit, ExpenseError> {
    if (allocation.amount.isNegative()) {
      return err(
        expenseError(
          "validation",
          "A split amount cannot be negative; use a zero allocation for an exemption.",
          {
            field: "splits",
            apartmentId: allocation.apartmentId,
            amountPaise: allocation.amount.paise.toString(),
          },
        ),
      );
    }

    const apartmentNumber = allocation.apartmentNumber.trim();
    if (apartmentNumber.length === 0) {
      return err(
        expenseError(
          "validation",
          "A split must carry the flat's number as it was when the expense was published.",
          { field: "splits", apartmentId: allocation.apartmentId },
        ),
      );
    }

    // The `Weight` brand is compile-time only; this is the runtime check that holds
    // if a caller has cast past `weight()` — the same belt-and-braces
    // `Money.allocateByWeights` applies to the weights it is handed.
    if (typeof allocation.weight !== "bigint" || allocation.weight < 0n) {
      return err(
        expenseError(
          "validation",
          "A split weight must be a whole, non-negative number.",
          {
            field: "splits",
            apartmentId: allocation.apartmentId,
          },
        ),
      );
    }

    return ok(
      new ExpenseSplit({
        memberId: allocation.memberId,
        apartmentId: allocation.apartmentId,
        apartmentNumber,
        amount: allocation.amount,
        weight: allocation.weight,
      }),
    );
  }

  /** Value equality — two splits of the same expense are equal when all five facts are. */
  equals(other: ExpenseSplit): boolean {
    return (
      this.memberId === other.memberId &&
      this.apartmentId === other.apartmentId &&
      this.apartmentNumber === other.apartmentNumber &&
      this.amount.equals(other.amount) &&
      this.weight === other.weight
    );
  }
}
