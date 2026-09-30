import {
  FLOOR_MAX,
  FLOOR_MIN,
  err,
  ok,
  weight,
  type Result,
  type Weight,
} from "@ses/domain";

import {
  splitError,
  type ApartmentParticipant,
  type FloorBand,
  type SplitError,
} from "../types";

import { exactUnits, readFloor, type FactReading } from "./facts";
import { collect, type BasisOutcome } from "./outcome";

/**
 * `per_floor_band` (PRD §3.5.4) — the basis a lift charge uses.
 *
 * > e.g. lift charges: ground floor 0×, floors 1–3 1×, floors 4+ 1.5×
 *
 * ## The one basis that needs configuration
 *
 * Every other basis reads its weight off the flat; this one reads the floor and
 * looks the floor up in a table that belongs to the *expense*, which is why the
 * bands are required on the input rather than on the participant
 * (`ApartmentFloorBandSplitInput`). `from` and `to` are **inclusive** floor numbers
 * — a band `1–3` covers floors 1, 2 and 3 — and floors are the domain's own
 * integers, so basements are negative and `0` is the ground floor, not "unknown".
 * `null` is unknown.
 *
 * ## A zero multiplier exempts; it does not exclude
 *
 * The roadmap's own test is "lift charge with ground floor at 0× charges
 * ground-floor flats exactly ₹0". The ground-floor flat is a participant with a
 * **weight of `0`**, so it appears in the result with an amount of ₹0 and is
 * certainly *not* dropped: a resident reading the split table sees that the flat
 * was considered and owes nothing, which is the point of an exemption. Weight `0`
 * is legal all the way down — `Weight` documents it as "owes nothing from this
 * pool" and `Money.allocateByWeights` gives it zero — so this needs no special
 * case, only the engine's guard against a *whole split* of zeros.
 *
 * The multiplier is read at **thousandths**: `1.5×` weighs `1500` and `0×` weighs
 * `0`. Only ratios matter, so the scale changes no money. There is no ceiling on a
 * multiplier — it is a ratio, the arithmetic is `bigint`, and a society's policy is
 * its own — so what is validated is what could not be true: a negative, a `NaN`, or
 * a value finer than the scale.
 *
 * ## What is validated here, and what is a warning
 *
 * The band *table* is configuration, so a table that could not mean anything is a
 * **field error** before any flat is weighed: empty; a `from`/`to` that is not a
 * whole floor in the domain's range `[-5, 200]`; a reversed range (`from > to`);
 * a negative or over-fine multiplier; and two bands that overlap, so a floor could
 * match both (Roadmap T058: "Overlapping bands rejected at validation"). Bands
 * need not be sorted, and adjacent bands (`1–3`, `4–8`) are fine — they do not
 * overlap.
 *
 * Two *per-flat* situations are warnings instead, because neither is the flat's
 * fault and neither should block a bill:
 *
 *  - a flat with no floor recorded is excluded with `MISSING_FLOOR`;
 *  - a flat whose floor matches no band is excluded with `NO_FLOOR_BAND`.
 *
 * The second one is a judgement worth stating. It is not "missing metadata" — the
 * floor is recorded — but the consequence for the split is the same: the table
 * gives that flat no multiplier, and inventing one (`1×`, say) would put a number
 * on a bill that no rule produced. Refusing the whole expense would be worse: one
 * floor left out of a table (a new top floor, a caretaker's mezzanine) would stop
 * a society billing everyone. So the flat is excluded, the ledger still conserves
 * over the flats the table covers, and the warning names it so the treasurer can
 * extend the bands and re-publish.
 */
export function floorBandWeights(
  participants: readonly ApartmentParticipant[],
  bands: readonly FloorBand[],
): Result<BasisOutcome, SplitError> {
  const validated = validateBands(bands);
  if (!validated.ok) return validated;

  return collect(participants, (participant) =>
    readBand(participant, validated.value),
  );
}

/** A band whose range and multiplier have been checked, multiplier already exact. */
interface ValidBand {
  readonly from: number;
  readonly to: number;
  readonly multiplier: Weight;
}

/** `numeric(12, 4)` is not where this lives, so the scale is the engine's: thousandths. */
const MULTIPLIER_DECIMALS = 3;

/**
 * The band table, checked as a whole: each band on its own, then the bands against
 * each other.
 *
 * Overlap is detected against the bands already accepted rather than by index
 * arithmetic over the array, which keeps the loop free of the "index might be out
 * of range" branch that TypeScript's `noUncheckedIndexedAccess` inserts and that
 * no test could ever cover.
 */
function validateBands(
  bands: readonly FloorBand[],
): Result<readonly ValidBand[], SplitError> {
  if (bands.length === 0) {
    return err(
      splitError(
        "validation",
        "A per-floor-band split needs at least one band.",
        {
          field: "floorBands",
        },
      ),
    );
  }

  const valid: ValidBand[] = [];

  for (const band of bands) {
    if (
      !Number.isInteger(band.from) ||
      !Number.isInteger(band.to) ||
      band.from < FLOOR_MIN ||
      band.from > FLOOR_MAX ||
      band.to < FLOOR_MIN ||
      band.to > FLOOR_MAX
    ) {
      return err(
        splitError(
          "validation",
          `Floor bands must use whole floor numbers between ${FLOOR_MIN} and ${FLOOR_MAX}, received ${band.from}–${band.to}.`,
          { field: "floorBands", from: band.from, to: band.to },
        ),
      );
    }

    if (band.from > band.to) {
      return err(
        splitError(
          "validation",
          `Floor band ${band.from}–${band.to} is reversed; a band's from must not be greater than its to.`,
          { field: "floorBands", from: band.from, to: band.to },
        ),
      );
    }

    const multiplier = exactUnits(band.mult, MULTIPLIER_DECIMALS);
    if (multiplier === undefined) {
      return err(
        splitError(
          "validation",
          `A floor band multiplier must be zero or greater with at most ${MULTIPLIER_DECIMALS} decimal places, received ${String(band.mult)}.`,
          { field: "floorBands", from: band.from, to: band.to },
        ),
      );
    }

    valid.push({
      from: band.from,
      to: band.to,
      multiplier: weight(multiplier),
    });
  }

  const accepted: ValidBand[] = [];
  for (const band of valid) {
    for (const other of accepted) {
      if (band.from <= other.to && other.from <= band.to) {
        return err(
          splitError(
            "validation",
            `Floor bands ${other.from}–${other.to} and ${band.from}–${band.to} overlap; a floor must match at most one band.`,
            { field: "floorBands" },
          ),
        );
      }
    }
    accepted.push(band);
  }

  return ok(valid);
}

/**
 * One flat's floor, the band it falls in, and that band's multiplier.
 *
 * `missing` is returned for two different reasons — no floor recorded, or no band
 * covering the floor — and they are different codes and different sentences,
 * because one is a missing fact and the other is a table that does not reach the
 * flat.
 */
function readBand(
  participant: ApartmentParticipant,
  bands: readonly ValidBand[],
): FactReading {
  const floor = readFloor(participant);
  if (floor.kind === "invalid") return { kind: "invalid", error: floor.error };
  if (floor.kind === "missing") {
    return { kind: "missing", code: "MISSING_FLOOR" };
  }

  const band = bands.find(
    (candidate) => floor.floor >= candidate.from && floor.floor <= candidate.to,
  );
  if (band === undefined) return { kind: "missing", code: "NO_FLOOR_BAND" };

  return { kind: "units", units: band.multiplier };
}
