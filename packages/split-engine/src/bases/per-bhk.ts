import type { Result } from "@ses/domain";

import type { ApartmentParticipant, SplitError } from "../types";

import { readBhk } from "./facts";
import { collect, type BasisOutcome } from "./outcome";

/**
 * `per_bhk` (PRD §3.5.4) — the configuration *is* the weight.
 *
 * A `3` BHK flat weighs three times a `1` BHK flat, which is the same ratio the
 * PRD's shares example uses for its BHK tiers (`3BHK = 3 shares, 2BHK = 2 shares`)
 * — the difference is *where the number comes from*: a shares split is the
 * treasurer's typed weights, this is the flat's recorded configuration, so nobody
 * has to re-enter it every month.
 *
 * The weight is BHK in **tenths** (`numeric(3, 1)`): `2` BHK is `20` and the real,
 * common `1.5` BHK is `15`. Only ratios matter, so the scale changes no money.
 *
 * A flat with no configuration recorded is excluded with a `MISSING_BHK` warning.
 * There is deliberately no "assume 2 BHK" fallback: a substituted configuration is
 * a weight nobody chose, and the flat that was left out is exactly what the
 * warning reports.
 */
export function perBhkWeights(
  participants: readonly ApartmentParticipant[],
): Result<BasisOutcome, SplitError> {
  return collect(participants, readBhk);
}
