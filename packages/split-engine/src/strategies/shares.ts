import { err, ok, weight, type Result, type Weight } from "@ses/domain";

import {
  MAX_SHARE_UNITS,
  ONE_SHARE,
  splitError,
  type ShareParticipant,
  type SplitError,
} from "../types";

/**
 * Weighted shares (PRD §3.5.3, Roadmap T057) — "integer or decimal share units per
 * participant; each pays `amount × share ÷ totalShares`".
 *
 * ## The division is described here and performed elsewhere
 *
 * `amount × share ÷ totalShares` has no exact paise answer in general — the PRD's
 * own example, ₹60,000 over 90 shares, is ₹666.66… a share — so this strategy does
 * not perform it. It hands the share counts to `Money.allocateByWeights` as
 * weights and lets the rounding rule divide once, in integers, and place the
 * leftover paise by largest fractional remainder, ties by apartment number
 * ascending (the engine has already sorted the participants into that order).
 *
 * That is what the roadmap's "exact residual handling" means concretely: the
 * residual is not handled *here* at all. It is handled by the same rule every
 * other strategy uses, so a shares preview and a shares bill cannot disagree by a
 * paisa — there is no second implementation for them to disagree in.
 *
 * ## Scale cannot move money
 *
 * A share arrives as {@link ShareUnits} — thousandths of a share, the
 * `apartments.share_units numeric(8, 3)` scale — and is widened to a `Weight`
 * unchanged. Scaling every weight by one factor leaves every proportion untouched,
 * so `3 : 2 : 1` and `3000 : 2000 : 1000` allocate byte-identically; the
 * remainders the primitive ranks are scaled by that same factor, so even *which*
 * participant carries the residual paisa is unchanged. Nothing depends on the
 * scale, which is what makes it safe to have one.
 *
 * ## What is validated, and why each check exists
 *
 *  - **A share must be greater than zero** (Roadmap T057). A zero share would be
 *    a ₹0 row in a published split for a flat nobody meant to charge, so it is
 *    refused; a flat the society means to exempt is excluded by participant
 *    resolution instead (T063), exactly as it is when it falls outside the
 *    selector.
 *  - **The ceiling is the database's.** `chk_apartments_share_units` refuses a
 *    stored `share_units` above `10000`, so a split using one could never be
 *    written; refusing it here keeps the failure a field error.
 *  - **The brand is compile-time only**, so each check below is the one that
 *    actually holds when a caller has cast past `shareUnits()` — a value off the
 *    wire, or a share some form multiplied by 1000 with a float in the middle.
 *
 * `totalShares` itself needs no check: every share is positive and the engine has
 * already refused an empty participant list, so the sum is positive by
 * construction.
 *
 * @returns the weights in participant order, ready for `distribute`.
 */
export function shareWeights(
  participants: readonly ShareParticipant[],
): Result<readonly Weight[], SplitError> {
  const weights: Weight[] = [];

  for (const participant of participants) {
    // Held as `unknown` first, like the percentage strategy's check and for the
    // same reason: against the declared `bigint` a `typeof` test narrows to
    // `never`, and the failure this branch exists to catch would read as dead
    // code to anyone reading it later.
    const raw: unknown = participant.share;

    if (typeof raw !== "bigint") {
      return err(
        splitError(
          "validation",
          `A share must be a whole number of thousandths, received ${String(raw)}; 1.5 shares is 1500.`,
          { field: "participants.share" },
        ),
      );
    }

    if (raw <= 0n) {
      return err(
        splitError(
          "validation",
          `A share must be greater than zero, received ${raw.toString()} thousandths.`,
          { field: "participants.share" },
        ),
      );
    }

    if (raw > MAX_SHARE_UNITS) {
      return err(
        splitError(
          "validation",
          `A share cannot exceed ${(MAX_SHARE_UNITS / ONE_SHARE).toString()} shares, received ${raw.toString()} thousandths.`,
          { field: "participants.share" },
        ),
      );
    }

    weights.push(weight(raw));
  }

  return ok(weights);
}
