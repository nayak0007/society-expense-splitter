/**
 * `@ses/split-engine` — the deterministic expense split engine (Roadmap T056,
 * PRD §3.5).
 *
 * The single most important shared package in the monorepo (SAD §4.1): the mobile
 * app previews a split with it and the API publishes the bill with it, so the
 * number a treasurer saw and the number a resident was charged cannot be two
 * different numbers. That is why it is a package and not a method on the expense
 * aggregate — the client has no expense aggregate and must not grow one.
 *
 * Zero runtime dependencies beyond `@ses/domain`: no Nest, no React, no driver, no
 * database and no HTTP. It compiles unchanged for Node and for Hermes.
 *
 * ## What is public
 *
 * `computeSplit` and the types its signature is written in, and nothing else. The
 * allocation helpers (`rounding.ts`, `strategies/*`) stay internal so that
 * strategies are added by T057/T058 rather than by every caller inventing its own
 * path to the rounding rule — the one piece of arithmetic that must never be
 * reimplemented.
 *
 * ## All five strategies
 *
 * `equal` and `percentage` (T056), `shares` and `custom` (T057), and `apartment`
 * (T058) with its six bases — the database's `split_strategy` enum, whole. A
 * result may also carry typed `warnings` (T058) when an apartment split had to
 * leave a flat out because the attribute it weighs was never recorded.
 *
 * @example
 * ```ts
 * const result = computeSplit({
 *   strategy: "equal",
 *   amount: Money.fromPaise(1_200_000),      // ₹12,000
 *   participants: flats,                      // 96 of them
 * });
 * if (!result.ok) return result.error;        // a returned failure, not a throw
 * result.value.allocations[0]?.amount.format(); // "₹125.00"
 * ```
 */

export { computeSplit } from "./engine";

export {
  APARTMENT_BASES,
  MAX_SHARE_UNITS,
  ONE_SHARE,
  PERCENT_TOLERANCE_BASIS_POINTS,
  PERCENT_TOTAL_BASIS_POINTS,
  SPLIT_ERROR_CODES,
  SPLIT_STRATEGIES,
  SPLIT_WARNING_CODES,
  SplitError,
  basisPoints,
  isSplitError,
  shareUnits,
  splitError,
} from "./types";

export type {
  ApartmentAttributeBasis,
  ApartmentAttributeSplitInput,
  ApartmentBasis,
  ApartmentFloorBandSplitInput,
  ApartmentParticipant,
  ApartmentSplitInput,
  BasisPoints,
  CustomParticipant,
  CustomSplitInput,
  EqualSplitInput,
  FloorBand,
  PercentageParticipant,
  PercentageSplitInput,
  ShareParticipant,
  ShareUnits,
  SharesSplitInput,
  SplitAllocation,
  SplitErrorCode,
  SplitInput,
  SplitParticipant,
  SplitResult,
  SplitStrategy,
  SplitWarning,
  SplitWarningCode,
} from "./types";
