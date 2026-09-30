import type { Result } from "@ses/domain";

import type { ApartmentParticipant, SplitError } from "../types";

import { readParkingSlots } from "./facts";
import { collect, type BasisOutcome } from "./outcome";

/**
 * `per_parking_slot` (PRD §3.5.4) — what a parking charge is split by.
 *
 * The weight is the allotted slot count, whole: two slots weigh `2`, one weighs
 * `1`. A flat with **no slot weighs `0` and stays in the split with an amount of
 * ₹0**, which is the same treatment a ground-floor flat gets in a lift charge
 * (see `floor-band.ts`) and for the same reason: the flat has a *recorded* fact
 * that happens to be zero, so the resident must be able to see that the flat was
 * considered. Excluding it would make "we checked, you have no slot" look
 * identical to "we could not find your flat".
 *
 * ## Why this basis has no `MISSING_` warning
 *
 * `apartments.parking_slots` is `smallint NOT NULL DEFAULT 0`
 * (`20260924140000_structure_apartments.sql`): there is no unrecorded state. `0`
 * is not a missing value, it is the value, which is why this reader has no
 * `missing` arm and the basis can produce no warning of its own. A slot count that
 * is *impossible* — negative, fractional, above the column's bound — is a field
 * error, not a warning, exactly as in the other bases.
 */
export function perParkingSlotWeights(
  participants: readonly ApartmentParticipant[],
): Result<BasisOutcome, SplitError> {
  return collect(participants, readParkingSlots);
}
