import type { AreaField, Result } from "@ses/domain";

import type { ApartmentParticipant, SplitError } from "../types";

import { readArea } from "./facts";
import { collect, type BasisOutcome } from "./outcome";

/**
 * `per_sqft_carpet` and `per_sqft_builtup` (PRD §3.5.4) — "the most common fair
 * method for maintenance in India".
 *
 * One module for both because they are one rule: the area is the weight. Which
 * area is the caller's choice of *field*, not a second algorithm, and the field
 * name is the wire's (`carpetAreaSqft` / `builtupAreaSqft`) so the basis maps onto
 * the column without a translation table — the same reason the basis names
 * themselves come from `apartment_basis`.
 *
 * The weight is the area in **hundredths of a square foot** (`numeric(8, 2)`), so
 * `720.5` sqft weighs `72050`. Only the ratio matters — the allocator divides once
 * by the sum it is given — so 720.5 and 72050 produce the same money, and the
 * scale exists only to keep the decimal exact (see `facts.ts`).
 *
 * A flat whose area was never measured is excluded with a `MISSING_AREA` warning
 * rather than weighed as zero: "₹0 because nobody measured it" is a policy the
 * society did not choose, and the warning is what keeps the exclusion visible in
 * the split table (Roadmap T058's own test: three apartments with a null area
 * produce one `MISSING_AREA` warning listing their ids).
 */
export function perSqftWeights(
  participants: readonly ApartmentParticipant[],
  field: AreaField,
): Result<BasisOutcome, SplitError> {
  return collect(participants, (participant) => readArea(participant, field));
}
