import { err, ok, type Result, type Weight } from "@ses/domain";

import {
  SPLIT_WARNING_CODES,
  type ApartmentParticipant,
  type SplitError,
  type SplitWarning,
  type SplitWarningCode,
} from "../types";

import type { FactReading } from "./facts";

/**
 * What every apartment basis produces, and how exclusions become warnings
 * (Roadmap T058).
 *
 * ## One shape for six bases
 *
 * A basis is a pure function from the ordered participants and its own
 * configuration to a {@link BasisOutcome}: the flats that took a share, one weight
 * each, and the warnings for the flats that could not. Because the shape is shared,
 * the six bases are five-line functions over their own reader, and the engine
 * handles exclusion, empty results and warnings once rather than six times.
 *
 * ## Why an exclusion is not a zero weight
 *
 * A flat with a weight of `0` — a ground-floor flat in a lift charge, a flat with
 * no allotted parking slot — **is in the result** with an amount of ₹0, because a
 * resident reading the split table must see that the flat was considered and owes
 * nothing. A flat whose *fact is not recorded* is **not in the result** and is
 * named in a warning, because there is no defensible weight for it at all: ₹0 would
 * be a policy nobody chose, and a ratio would have to be invented. That is the
 * whole distinction between the roadmap's "charges ground-floor flats exactly ₹0"
 * and "missing the required attribute are excluded".
 */
export interface BasisOutcome {
  /** The participants that took a share, in the order they were given. */
  readonly included: readonly ApartmentParticipant[];
  /** Their weights, index-aligned with {@link included}. */
  readonly weights: readonly Weight[];
  /** One entry per warning code that applied, in `SPLIT_WARNING_CODES` order. */
  readonly warnings: readonly SplitWarning[];
}

/** A flat a basis could not weigh, and the warning code that says why. */
interface Exclusion {
  readonly participant: ApartmentParticipant;
  readonly code: SplitWarningCode;
}

/**
 * The shared driver: read one fact per participant, then split the list into
 * weighed flats, excluded flats and — on the first unreadable fact — an error.
 *
 * The first `invalid` reading wins, and it wins *before* any exclusion is
 * reported, deliberately: an input that could not have come from the database is
 * a caller bug, and answering it with a partial split plus warnings would bury a
 * broken field under plausible-looking money.
 */
export function collect(
  participants: readonly ApartmentParticipant[],
  read: (participant: ApartmentParticipant) => FactReading,
): Result<BasisOutcome, SplitError> {
  const included: ApartmentParticipant[] = [];
  const weights: Weight[] = [];
  const exclusions: Exclusion[] = [];

  for (const participant of participants) {
    const reading = read(participant);

    switch (reading.kind) {
      case "invalid":
        return err(reading.error);
      case "units":
        included.push(participant);
        weights.push(reading.units);
        break;
      case "missing":
        exclusions.push({ participant, code: reading.code });
        break;
    }
  }

  return ok({ included, weights, warnings: buildWarnings(exclusions) });
}

/**
 * What each warning is about, in the words the message uses.
 *
 * Keyed by the code and exhaustive over `SplitWarningCode`, so adding a code
 * without wording is a compile error. The phrase describes the *data*, not the
 * basis: `MISSING_AREA` says "no area recorded" whichever of the two per-sqft
 * bases met it, and the caller knows which basis it asked for.
 */
const EXCLUSION_REASON: Readonly<Record<SplitWarningCode, string>> = {
  MISSING_AREA: "no area recorded",
  MISSING_BHK: "no BHK configuration recorded",
  MISSING_FLOOR: "no floor recorded",
  NO_FLOOR_BAND: "a floor outside every configured band",
};

/**
 * Exclusions → one warning per code, in `SPLIT_WARNING_CODES` order.
 *
 * Determinism is not incidental here. Aggregating *by code* (rather than emitting
 * one warning per flat) is what the PRD's own example does — "3 apartments have no
 * carpet area and were excluded", with all three ids on one warning. Ordering by
 * the code list, rather than by the order flats happened to be walked, means two
 * callers who passed the same flats in different orders get **byte-identical**
 * warnings; the ids inside a warning follow the engine's participant order for the
 * same reason. A `Map`'s iteration order would have made warning order depend on
 * insertion order, which is exactly the accident this avoids.
 */
function buildWarnings(
  exclusions: readonly Exclusion[],
): readonly SplitWarning[] {
  if (exclusions.length === 0) return NO_WARNINGS;

  const warnings: SplitWarning[] = [];

  for (const code of SPLIT_WARNING_CODES) {
    const affected = exclusions.filter((exclusion) => exclusion.code === code);
    if (affected.length === 0) continue;

    warnings.push(
      Object.freeze({
        code,
        message: `${affected.length === 1 ? "1 apartment was" : `${affected.length} apartments were`} excluded: ${EXCLUSION_REASON[code]}.`,
        apartmentIds: Object.freeze(
          affected.map((exclusion) => exclusion.participant.apartmentId),
        ),
      }),
    );
  }

  return Object.freeze(warnings);
}

/**
 * The empty warning list, shared rather than allocated.
 *
 * Frozen, and handed to every result that has nothing to report — which is every
 * split the other four strategies produce, and any apartment split whose facts are
 * all recorded. One shared instance is safe precisely because it cannot be
 * mutated, and it keeps "no warnings" from being a fresh array that a caller could
 * later mistake for state.
 */
export const NO_WARNINGS: readonly SplitWarning[] = Object.freeze([]);
