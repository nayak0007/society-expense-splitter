import { paise, type Money, type Paise, type Weight } from "@ses/domain";

/**
 * The rounding rule (Roadmap T056, PRD §3.5).
 *
 * > Divide in paise, floor each allocation, then distribute the residual paise one
 * > paise at a time to allocations in descending order of fractional remainder,
 * > tie-broken by apartment number ascending.
 *
 * That rule already exists, once, in
 * [`Money.allocateByWeights`](../../domain/src/shared/money.vo.ts) — the same
 * largest-remainder implementation the domain's own tests pin at 100% coverage.
 * So this module **implements nothing arithmetic**. It is the seam that gives the
 * rule a name inside the engine, keeps the strategy modules from reaching into
 * `Money` themselves, and states the two facts the engine relies on:
 *
 *  1. {@link distribute} hands the amount and the weights to the primitive, which
 *     is why there is no second residual algorithm to drift out of step with the
 *     preview the treasurer saw; and
 *  2. {@link undistributedPaise} *measures* what was left over instead of
 *     assuming it is nothing.
 *
 * A second implementation is the specific failure this package is structured to
 * prevent. The client previews a split locally and the server computes the bill
 * (SAD §1.1); if the two rules differed by one paisa on one input, the resident
 * sees a number the treasurer was never shown. Sharing `Money` makes that
 * impossible rather than tested-for.
 *
 * ## What the tie-break means here
 *
 * The primitive breaks ties by **index ascending**. The rule above breaks them by
 * **apartment number ascending**. This module does not paper over that: it takes
 * the weights in the order the caller wants ties resolved, so the engine sorts
 * participants by apartment number *before* calling, and index order and
 * apartment order are then the same thing. `distribute` is deliberately order-
 * sensitive for exactly this reason, and its tests pin that it is.
 *
 * @param amount the amount to divide. Signed: a refund allocates its magnitude
 *   and negates every part, and the sum still equals the input.
 * @param weights one weight per participant, **in tie-break order**. Zero is
 *   legal and receives zero. At least one must be non-zero.
 * @throws {MoneyError} if `weights` is empty or all zero — an amount with nothing
 *   to divide it by has no answer, and returning zeros would be a quiet lie. The
 *   engine cannot reach this: it requires at least one participant, and every
 *   strategy gives a participant a positive weight or fails validation first.
 */
export function distribute(
  amount: Money,
  weights: readonly Weight[],
): readonly Money[] {
  return amount.allocateByWeights(weights);
}

/**
 * The paise that did not land on a participant: `Σ parts` subtracted from the
 * amount.
 *
 * Always zero for a distribution this package produces — that is the invariant
 * the whole ledger rests on — and computed rather than assumed so the invariant
 * is *measured*. A regression in the rounding rule would surface here, in the
 * result, instead of being asserted away by a constant.
 *
 * It is a total function so that it can be pointed at a non-conserving set of
 * parts and checked to report a non-zero number, which is what proves it measures
 * anything at all rather than always answering `0n`.
 */
export function undistributedPaise(
  amount: Money,
  parts: readonly Money[],
): Paise {
  let distributed = 0n;
  for (const part of parts) distributed += part.paise;
  return paise(amount.paise - distributed);
}
