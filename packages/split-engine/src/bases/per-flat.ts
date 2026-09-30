import { ok, type Result } from "@ses/domain";

import { equalWeights } from "../strategies/equal";
import type { ApartmentParticipant, SplitError } from "../types";

import { NO_WARNINGS, type BasisOutcome } from "./outcome";

/**
 * `per_flat` (PRD §3.5.4) — "identical to equal, but scoped to flats not people".
 *
 * The one basis that reads nothing. Every participant weighs `1`, and that is why
 * it is written as a call to the *same* `equalWeights` the equal strategy uses
 * rather than as its own `1n` loop: "per-flat is equal over flats" is then a fact
 * about the code, not a coincidence two implementations maintain, and the
 * engine's own equivalence test (a per-flat split and an equal split of the same
 * flats are the same result, weights and residual paisa included) is checking a
 * shared function rather than agreeing with itself.
 *
 * ## Nothing can be missing, so there are no warnings
 *
 * The scoping is participant resolution's job (T063): a per-flat split is
 * "whatever set of flats this expense applies to, one share each", and a flat with
 * no recorded area or floor is still exactly one flat. So this basis never
 * excludes, and returning `NO_WARNINGS` is a statement about the basis rather than
 * a placeholder.
 *
 * Its result shape is a `Result` like every other basis's, so the engine's dispatch
 * does not have to special-case the one basis that cannot fail — and an
 * unreachable `err` would be a branch no test could cover.
 */
export function perFlatWeights(
  participants: readonly ApartmentParticipant[],
): Result<BasisOutcome, SplitError> {
  return ok({
    included: participants,
    weights: equalWeights(participants),
    warnings: NO_WARNINGS,
  });
}
