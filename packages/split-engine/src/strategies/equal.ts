import { weight, type Weight } from "@ses/domain";

import type { SplitParticipant } from "../types";

/**
 * Equal split (PRD §3.5.1) — "amount ÷ number of participants".
 *
 * ## Why this is expressed as weights and not as a division
 *
 * ₹100 across 3 flats is ₹33.333…, which has no exact paise answer. Every
 * implementation of "divide" therefore has to choose where the leftover paisa
 * goes, and the only place that choice is specified is the rounding rule
 * (PRD §3.5): the largest fractional remainders, ties by apartment number
 * ascending. So equal is not a division — it is a **distribution over equal
 * weights**, and the rule places the residual.
 *
 * That keeps one arithmetic path for all five strategies. `equal` differs from
 * `percentage` only in the weights it supplies (one each, versus basis points),
 * which is why adding the remaining strategies in T057/T058 will not touch the
 * engine, and why "equal split with equal weights produces the same allocations
 * as percentage split at an equal percentage" is a property that holds rather
 * than a coincidence — T057's `shares` strategy at one share each will land here
 * too.
 *
 * A weight of `1` for every participant, regardless of share units or area: this
 * is the strategy a society picks precisely when none of that matters. It is the
 * default for security and housekeeping, where the cost does not vary by flat.
 *
 * @param participants a non-empty list. Emptiness is the engine's check, not
 *   this one: it is the only place that knows whether a request is well-formed.
 */
export function equalWeights(
  participants: readonly SplitParticipant[],
): readonly Weight[] {
  return participants.map(() => EQUAL_SHARE);
}

/**
 * The weight of one equal share.
 *
 * Defined once rather than as `weight(1)` inline, so the map above allocates no
 * bigint per participant. `Weight` is a branded primitive and `1n` is immutable,
 * so one shared instance is safe here in a way a mutable accumulator would not be.
 */
const EQUAL_SHARE = weight(1);
