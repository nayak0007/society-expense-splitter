import {
  ZERO_PAISE,
  err,
  formatPaise,
  isPaise,
  ok,
  paise,
  weight,
  type Money,
  type Paise,
  type Result,
  type Weight,
} from "@ses/domain";

import { splitError, type CustomParticipant, type SplitError } from "../types";

/**
 * Custom split (PRD §3.5.5, Roadmap T057) — "treasurer types an exact amount per
 * participant. Live 'remaining: ₹X' indicator; save blocked until remaining is
 * ₹0. Supports excluding participants entirely."
 *
 * ## Exact, not proportional
 *
 * This is the one strategy where the answer is the input. The amounts are not
 * divided, not scaled and not rounded, and no residual exists: `Σ amounts` must
 * equal the expense exactly, and a participant's allocation *is* its stated
 * amount. The PRD's editor is the reason — it shows "remaining: ₹X" and keeps Save
 * disabled until that reads ₹0.00 — so the engine's job is not to be clever about
 * a remainder, it is to refuse a ledger that does not balance.
 *
 * That is also why this module returns **weights equal to the amounts**. The
 * engine routes every strategy through `Money.allocateByWeights`, and when the
 * weights sum to exactly the amount the largest-remainder rule is the identity:
 * `base_i = floor(A × a_i ÷ A) = a_i`, every remainder is zero, the residual is
 * zero, and the parts that come back are the treasurer's figures, to the paisa.
 * Reusing the one allocation path — rather than a second path that returns the
 * amounts directly — is what keeps `undistributedPaise` able to *measure* that the
 * whole result balanced, this strategy included.
 *
 * (A custom split is therefore the one place where `weight` in the result is
 * money: it is the stated amount in paise, because that is literally what produced
 * the allocation.)
 *
 * ## Excluding a participant
 *
 * A custom split excludes a flat by not listing it, and that is the mechanism the
 * PRD names: the participant list *is* the set of flats the expense is charged to,
 * resolved before the engine is called (T063). A listed participant with a ₹0
 * amount is legal and receives a ₹0 allocation — an explicit "this flat owes
 * nothing", which is a real thing a treasurer records (a caretaker's quarter, a
 * shop billed separately) and which `expense_splits.amount_paise`'s
 * `CHECK (amount_paise >= 0)` expects to see. It is also why excluding *everyone*
 * cannot be mistaken for a split: ₹0 does not equal the expense, and the shortfall
 * error says by how much.
 *
 * ## What is validated, and why each check exists
 *
 *  - a **negative** amount is refused — `expense_splits.amount_paise` is
 *    `CHECK (amount_paise >= 0)`, and a resident cannot owe less than nothing;
 *  - a sum that **does not equal the expense** is refused, naming the difference
 *    in both the message and `details.shortfallPaise` — "save blocked until
 *    remaining is ₹0", enforced on the server as well as in the form;
 *  - the amount must be a **`Money` at runtime**, not only in the type: the
 *    declared type is `Money`, so a wire payload that carried `amountPaise` as a
 *    plain number, or a cast someone added to silence the compiler, would
 *    otherwise reach `bigint` arithmetic and throw a `TypeError` out of a function
 *    that promises to return its failures.
 */
export function customWeights(
  participants: readonly CustomParticipant[],
  total: Money,
): Result<readonly Weight[], SplitError> {
  const weights: Weight[] = [];
  // Accumulated as `Paise` rather than a bare `bigint`: the sum of the parts is
  // money, and branding it here is what lets the error below format it with the
  // same formatter the result uses.
  let assigned: Paise = ZERO_PAISE;

  for (const participant of participants) {
    const amountPaise = readAmountPaise(participant.amount);

    if (amountPaise === undefined) {
      return err(
        splitError(
          "validation",
          "A custom split needs an exact amount for every participant; the wire carries `amountPaise`, so build it with `Money.fromPaise`.",
          { field: "participants.amount" },
        ),
      );
    }

    if (amountPaise < 0n) {
      return err(
        splitError(
          "validation",
          `A custom amount cannot be negative, received ${formatPaise(amountPaise)}.`,
          { field: "participants.amount" },
        ),
      );
    }

    assigned = paise(assigned + amountPaise);
    weights.push(weight(amountPaise));
  }

  if (assigned !== total.paise) {
    // Signed on purpose: positive is unassigned money, negative is over-assigned,
    // and one field carries both so a form can render either without a second
    // branch of its own.
    const shortfall = paise(total.paise - assigned);
    const detail =
      shortfall > 0n
        ? `the amounts total ${formatPaise(assigned)}, leaving ${formatPaise(shortfall)} unassigned`
        : `the amounts total ${formatPaise(assigned)}, ${formatPaise(paise(-shortfall))} more than the ${total.format()} expense`;

    return err(
      splitError(
        "validation",
        `A custom split must assign exactly ${total.format()}: ${detail}.`,
        { field: "participants.amount", shortfallPaise: shortfall.toString() },
      ),
    );
  }

  return ok(weights);
}

/**
 * The paise of a custom amount, or `undefined` if it is not one.
 *
 * Structural rather than `instanceof Money`, deliberately. `Money` is a class, but
 * what this function needs is its integer, and a monorepo can resolve two copies
 * of `@ses/domain` — a hoisted client bundle, a second major version in a
 * workspace — where `instanceof` would answer `false` for a genuine `Money`. The
 * check made instead is the primitive's own: `paise` is a `bigint` (`isPaise`).
 *
 * A non-object (a number, a string, `null`, `undefined`) fails the same way, which
 * is the point: every one of them is a caller that believed the type instead of the
 * value, and a `Result` is the right answer for that, not a `TypeError`.
 */
function readAmountPaise(amount: unknown): Paise | undefined {
  const candidate = (amount as { readonly paise?: unknown } | null | undefined)
    ?.paise;

  return isPaise(candidate) ? candidate : undefined;
}
