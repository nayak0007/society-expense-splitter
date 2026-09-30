import { err, ok, weight, type Result, type Weight } from "@ses/domain";

import {
  PERCENT_TOLERANCE_BASIS_POINTS,
  PERCENT_TOTAL_BASIS_POINTS,
  splitError,
  type PercentageParticipant,
  type SplitError,
} from "../types";

/**
 * Percentage split (PRD §3.5.2) — an explicit share of 100% per participant.
 *
 * Each participant's percentage is already an exact integer of basis points
 * ({@link BasisPoints}), so a percentage becomes a `Weight` by widening the same
 * integer. Nothing is scaled: no `percent × amount / 100`, no float in the middle,
 * and therefore no participant whose share depends on the order the arithmetic
 * happened in. `60%` and `40%` of ₹1,000 are exactly ₹600 and ₹400 because the
 * weights are `6000n` and `4000n` and the primitive divides once, in integers.
 *
 * ## The total, and why there is a tolerance at all
 *
 * Percentages must reach `100.00%` within `0.01%` — one basis point, exactly
 * ({@link PERCENT_TOLERANCE_BASIS_POINTS}). The tolerance is not slack for float
 * error, because there is no float error to absorb: it exists because a
 * three-way split of some totals cannot be expressed in two decimals at all.
 * `33.33%` three times is `99.99%`, which is a sum that must be accepted, while
 * `60% + 30%` is a mistake that must be refused. Both are exact integer
 * comparisons.
 *
 * The weights need not total `10_000n` for the arithmetic to be right — the
 * primitive divides by the weight sum it is given, so `99.99%` allocates in the
 * proportions `3333 : 3333 : 3333` and conserves exactly. Accepting the tolerance
 * is therefore a decision about what a treasurer may type, not a compromise in
 * the money.
 *
 * ## What is validated here, and why each check exists
 *
 * The brand on {@link BasisPoints} is compile-time only, so every check below is
 * the one that actually holds when a caller has cast its way past `basisPoints()`
 * — a copy-pasted `as BasisPoints`, a value off the wire, or a rounded float from
 * a form that did its own percentage maths. Each is a `validation` error naming
 * the field, so the API maps it to `422` with `field: "participants.percentage"`
 * (SAD §7) and the form can highlight the input that is wrong.
 *
 * @returns the weights in participant order, ready for {@link distribute}.
 */
export function percentageWeights(
  participants: readonly PercentageParticipant[],
): Result<readonly Weight[], SplitError> {
  let total = 0n;

  for (const participant of participants) {
    // Held as `unknown` first: the declared type is `bigint`, so a `typeof` test
    // against the typed value narrows the *check* to `never` and the failure it
    // is there to catch would read as dead code.
    const raw: unknown = participant.percentage;

    if (typeof raw !== "bigint") {
      return err(
        splitError(
          "validation",
          `A percentage must be a whole number of basis points, received ${String(raw)}; 33.33% is 3333.`,
          { field: "participants.percentage" },
        ),
      );
    }

    if (raw < 0n || raw > PERCENT_TOTAL_BASIS_POINTS) {
      return err(
        splitError(
          "validation",
          `A percentage must be between 0% and 100%, received ${percentText(raw)}.`,
          { field: "participants.percentage" },
        ),
      );
    }

    total += raw;
  }

  const deviation = total - PERCENT_TOTAL_BASIS_POINTS;
  if (
    deviation > PERCENT_TOLERANCE_BASIS_POINTS ||
    deviation < -PERCENT_TOLERANCE_BASIS_POINTS
  ) {
    return err(
      splitError(
        "validation",
        `Percentages must total 100.00% (within 0.01%); they total ${percentText(total)}.`,
        {
          field: "participants.percentage",
          totalBasisPoints: total.toString(),
        },
      ),
    );
  }

  return ok(participants.map((participant) => weight(participant.percentage)));
}

/**
 * `3333` → `"33.33%"`. Always two decimals, so `10_000` reads `"100.00%"`
 * rather than `"100%"` — the total a treasurer typed is a two-decimal number and
 * the error should echo it back in the shape they entered it.
 *
 * A pure string transform on an integer: no `toFixed`, no `Intl`, no division
 * that could be inexact. Basis points are hundredths of a percent, so the last
 * two digits of the integer *are* the decimals.
 */
function percentText(basisPointsValue: bigint): string {
  const whole = basisPointsValue / 100n;
  const hundredths = basisPointsValue % 100n;
  return `${whole.toString()}.${hundredths.toString().padStart(2, "0")}%`;
}
