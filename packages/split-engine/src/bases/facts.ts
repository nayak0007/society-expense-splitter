import {
  AREA_MAX_SQFT,
  AREA_MIN_SQFT,
  BHK_MAX,
  BHK_MIN,
  FLOOR_MAX,
  FLOOR_MIN,
  PARKING_SLOTS_MAX,
  PARKING_SLOTS_MIN,
  weight,
  type AreaField,
  type Weight,
} from "@ses/domain";

import {
  splitError,
  type ApartmentParticipant,
  type SplitError,
  type SplitWarningCode,
} from "../types";

/**
 * Reading an apartment fact into an exact weight (Roadmap T058).
 *
 * The apartment bases differ only in *which* column they weigh, so this module
 * holds the part they share: turning a column's value into the exact integer
 * `Money.allocateByWeights` needs, or saying precisely why it cannot.
 *
 * ## Three outcomes, and why "missing" is not "invalid"
 *
 *  - **`units`** — the fact is there and exact: the weight.
 *  - **`missing`** — the column is `NULL`, i.e. the society has not recorded it.
 *    The flat is *excluded* from the split and a warning names it (Roadmap T058:
 *    "Apartments missing the required attribute are excluded and reported as a
 *    warning, never silently dropped"). An unrecorded area is ordinary, not a bug.
 *  - **`invalid`** — the value is present but could not have come from the
 *    database: a floor of `-9`, a BHK of `2.25`, an area of `0`. Each of these is
 *    refused by a column `CHECK` and by the domain's own value object
 *    (`createFloor`, `createBhk`, `createArea`), so reaching one means a caller
 *    built the input by hand or moved a decimal point in transit. That is a field
 *    error, not a data-quality note: computing a plausible bill from an impossible
 *    fact is the failure this distinction exists to prevent.
 *
 * The distinction is the same one SAD draws between `422` and a warning, and it
 * is why the engine never substitutes a default — `area = 1`, `floor = 0` — for
 * a fact it could not read.
 *
 * ## Decimals are scaled by reading the number's own text
 *
 * A decimal column becomes an integer weight by *reading* the value, not by
 * multiplying it: `exactUnits` works on `String(value)`, so `720.5` is
 * `"720.5"` → `72050` hundredths with no float multiplication anywhere. `0.1 + 0.2`
 * is `0.30000000000000004`, whose text has seventeen decimal places, so a value
 * that has *already* drifted is refused rather than rounded into money — the same
 * stance `Money.fromRupees` takes on `"1.234"`. Every scale is the column's:
 * `numeric(8, 2)` areas are hundredths, `numeric(3, 1)` BHK is tenths.
 */
export type FactReading =
  | { readonly kind: "units"; readonly units: Weight }
  | { readonly kind: "missing"; readonly code: SplitWarningCode }
  | { readonly kind: "invalid"; readonly error: SplitError };

/** `numeric(8, 2)`: an area weight is hundredths of a square foot. */
const AREA_DECIMALS = 2;

/** `numeric(3, 1)`: a BHK weight is tenths. */
const BHK_DECIMALS = 1;

/**
 * A non-negative decimal, as an exact integer of `10^-decimals`.
 *
 * `undefined` when the value cannot be represented at that scale — a negative, an
 * infinity, a `NaN`, more decimal places than the column has, or a value that
 * JavaScript rendered in exponent form (`String(1e-7)` is `"1e-7"`, which is not a
 * decimal that can be placed at a fixed scale without guessing).
 *
 * Exact by construction: the digits come from the number's own text, so
 * `720.5 × 100` never happens and cannot round.
 */
export function exactUnits(
  value: number,
  decimals: number,
): bigint | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;

  const text = String(value);
  if (text.includes("e") || text.includes("E")) return undefined;

  // Sliced at the point rather than destructured from `split(".")`: a number's own
  // text always has a digit before the point (`0.5`, never `.5`), so a default for
  // the whole part would be a branch nothing can reach.
  const point = text.indexOf(".");
  const whole = point === -1 ? text : text.slice(0, point);
  const fraction = point === -1 ? "" : text.slice(point + 1);
  if (fraction.length > decimals) return undefined;

  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0"))
  );
}

/**
 * A carpet or built-up area (PRD §3.5.4's `per_sqft`), in hundredths of a sqft.
 *
 * `0` is refused although the column permits it, matching `createArea`: every
 * per-sqft rule divides by this number, so a zero would be answered with a
 * division by zero rather than with a bill.
 */
export function readArea(
  participant: ApartmentParticipant,
  field: AreaField,
): FactReading {
  const value = participant[field];

  if (value === null) {
    return { kind: "missing", code: "MISSING_AREA" };
  }

  const label = field === "carpetAreaSqft" ? "Carpet area" : "Built-up area";

  if (
    !Number.isFinite(value) ||
    value <= AREA_MIN_SQFT ||
    value > AREA_MAX_SQFT
  ) {
    return invalid(
      participant,
      field,
      `${label} must be between ${AREA_MIN_SQFT} and ${AREA_MAX_SQFT} sq ft.`,
    );
  }

  const units = exactUnits(value, AREA_DECIMALS);
  if (units === undefined) {
    return invalid(
      participant,
      field,
      `${label} must have at most ${AREA_DECIMALS} decimal places.`,
    );
  }

  return { kind: "units", units: weight(units) };
}

/** A BHK configuration, in tenths: `2` BHK is `20`, `1.5` BHK is `15`. */
export function readBhk(participant: ApartmentParticipant): FactReading {
  const value = participant.bhk;

  if (value === null) {
    return { kind: "missing", code: "MISSING_BHK" };
  }

  if (!Number.isFinite(value) || value < BHK_MIN || value > BHK_MAX) {
    return invalid(
      participant,
      "bhk",
      `Configuration must be between ${BHK_MIN} and ${BHK_MAX} BHK.`,
    );
  }

  const units = exactUnits(value, BHK_DECIMALS);
  if (units === undefined) {
    return invalid(
      participant,
      "bhk",
      `Configuration must have at most ${BHK_DECIMALS} decimal place; 1.5 is a configuration, 1.25 is not.`,
    );
  }

  return { kind: "units", units: weight(units) };
}

/**
 * A floor, as the whole number the bands are matched against.
 *
 * Not a `FactReading`, unlike the others: a floor is never a weight — it selects
 * a band, and the band supplies the multiplier — so this reader answers with the
 * floor itself and `floor-band.ts` turns it into a weight.
 */
export type FloorReading =
  | { readonly kind: "floor"; readonly floor: number }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly error: SplitError };

export function readFloor(participant: ApartmentParticipant): FloorReading {
  const floor = participant.floor;

  if (floor === null) return { kind: "missing" };

  if (!Number.isInteger(floor) || floor < FLOOR_MIN || floor > FLOOR_MAX) {
    return {
      kind: "invalid",
      error: invalid(
        participant,
        "floor",
        `Floor must be a whole number between ${FLOOR_MIN} and ${FLOOR_MAX}.`,
      ).error,
    };
  }

  return { kind: "floor", floor };
}

/**
 * The allotted parking slots, as a whole number.
 *
 * Zero is a legitimate weight of `0` — a flat with no allotted slot owes nothing
 * from a parking charge — and not a missing fact, because the column is
 * `smallint NOT NULL DEFAULT 0`: there is no "unrecorded" state to distinguish it
 * from. So this reader never reports `missing`.
 */
export function readParkingSlots(
  participant: ApartmentParticipant,
): FactReading {
  const slots = participant.parkingSlots;

  if (
    !Number.isInteger(slots) ||
    slots < PARKING_SLOTS_MIN ||
    slots > PARKING_SLOTS_MAX
  ) {
    return invalid(
      participant,
      "parkingSlots",
      `Parking slots must be a whole number between ${PARKING_SLOTS_MIN} and ${PARKING_SLOTS_MAX}.`,
    );
  }

  return { kind: "units", units: weight(slots) };
}

/**
 * A field error that names the flat it came from.
 *
 * `details.apartmentId` alongside `details.field` is what lets the preview
 * endpoint (T064) point at the offending row instead of at the whole request, and
 * the field path is the same `participants.<property>` shape the other strategies
 * use.
 */
function invalid(
  participant: ApartmentParticipant,
  field: string,
  message: string,
): Extract<FactReading, { readonly kind: "invalid" }> {
  return {
    kind: "invalid",
    error: splitError("validation", message, {
      field: `participants.${field}`,
      apartmentId: participant.apartmentId,
      apartmentNumber: participant.apartmentNumber,
    }),
  };
}
