/**
 * The split configurator's form state, parsing, validation and payload mapping —
 * Roadmap T075.
 *
 * ## What this file owns, and what it does not
 *
 * It owns exactly three things: how a split is *edited on a phone* (text fields, one
 * row per participant), what makes a configuration *submittable* (the percentage
 * total, the custom remainder, the floor bands), and how the editor's state becomes
 * the two contract payloads the API already accepts (`splitConfig` and
 * `participantSelector`). It owns no allocation arithmetic at all: every amount a
 * treasurer sees is the server's preview or the shared `@ses/split-engine`'s, never a
 * number computed here (SAD §1.1).
 *
 * ## Why the state holds text
 *
 * A percentage, a share count and a custom amount are all *typed*, so the state keeps
 * what the user typed and parses on demand. Storing a parsed number would make
 * `33.3` and `33.30` the same value and would silently rewrite the field under a
 * cursor; storing the text is what lets a half-typed value be *explained* rather than
 * dropped, exactly as `expense-amount.ts` argues for the amount field.
 *
 * ## The vocabulary is the domain's, never a second spelling
 *
 * `SPLIT_STRATEGIES` and `APARTMENT_BASES` are imported from `@ses/domain` — the one
 * list the contract, the database enum and the engine all read — and the two
 * tolerances come from `@ses/split-engine`, which is where the engine's own rule is
 * stated. A literal `10000` here would be a fifth copy of a rule that must not drift.
 */

import { OCCUPANCY_STATUSES } from '@ses/domain';
import type { ApartmentBasis, OccupancyStatus, ParticipantScope, SplitStrategy } from '@ses/domain';
import {
  MAX_SHARE_UNITS,
  ONE_SHARE,
  PERCENT_TOLERANCE_BASIS_POINTS,
  PERCENT_TOTAL_BASIS_POINTS,
} from '@ses/split-engine';
import type {
  CreateExpensePayload,
  ParticipantSelectorPayload,
  SplitConfigPayload,
} from '@ses/contracts';

import { formatPaise, groupIndian } from './expense.schemas';
import { parseRupeeText } from './expense-amount';

// ─────────────────────────────────────────────────────────────────────────────
// Labels — the closed vocabularies, rendered for a treasurer
// ─────────────────────────────────────────────────────────────────────────────

export const SPLIT_STRATEGY_LABELS: Record<SplitStrategy, string> = {
  equal: 'Equal',
  percentage: 'Percentage',
  shares: 'Shares',
  apartment: 'By apartment',
  custom: 'Custom amounts',
};

/** The five strategies, in the enum's own order, as selectable options. */
export const SPLIT_STRATEGY_OPTIONS: readonly {
  readonly value: SplitStrategy;
  readonly label: string;
}[] = (['equal', 'percentage', 'shares', 'apartment', 'custom'] as const).map((value) => ({
  value,
  label: SPLIT_STRATEGY_LABELS[value],
}));

export const APARTMENT_BASIS_LABELS: Record<ApartmentBasis, string> = {
  per_flat: 'Per flat',
  per_sqft_carpet: 'Per sqft (carpet)',
  per_sqft_builtup: 'Per sqft (built-up)',
  per_bhk: 'By BHK',
  per_floor_band: 'By floor band',
  per_parking_slot: 'Per parking slot',
};

/** The six bases, in the enum's own order, as selectable options. */
export const APARTMENT_BASIS_OPTIONS: readonly {
  readonly value: ApartmentBasis;
  readonly label: string;
}[] = (
  [
    'per_flat',
    'per_sqft_carpet',
    'per_sqft_builtup',
    'per_bhk',
    'per_floor_band',
    'per_parking_slot',
  ] as const
).map((value) => ({ value, label: APARTMENT_BASIS_LABELS[value] }));

export const OCCUPANCY_LABELS: Record<OccupancyStatus, string> = {
  owner_occupied: 'Owner-occupied',
  rented: 'Rented',
  vacant: 'Vacant',
  under_construction: 'Under construction',
};

export const OCCUPANCY_OPTIONS: readonly {
  readonly value: OccupancyStatus;
  readonly label: string;
}[] = OCCUPANCY_STATUSES.map((value) => ({ value, label: OCCUPANCY_LABELS[value] }));

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

/** One editable floor band. `from`/`to`/`mult` are text; parsed on demand. */
export interface FloorBandForm {
  readonly from: string;
  readonly to: string;
  readonly mult: string;
}

/**
 * The participant selector as the selector screen edits it — the contract's eight
 * dimensions, with `includeVacant` tri-state (`null` = "not stated", so the society's
 * own `bill_vacant_flats` decides).
 */
export interface ParticipantSelectorForm {
  readonly scope: ParticipantScope;
  readonly buildings: readonly string[];
  readonly wings: readonly string[];
  readonly floors: readonly number[];
  readonly occupancy: readonly OccupancyStatus[];
  readonly excludeApartments: readonly string[];
  readonly includeVacant: boolean | null;
  readonly ownerOnly: boolean;
}

/**
 * The split editor's state.
 *
 * `percentages`, `shares` and `customAmounts` are keyed by apartment id — the same key
 * the contract's per-participant entries use, so resolution's one-outcome-per-flat
 * guarantee is what makes an entry addressable. `customized` records whether the user
 * has taken the strategy/basis away from the category's default, which is the fact
 * §9's "do not overwrite a user-customized strategy" rule needs; it is *local form
 * metadata*, never sent (it is not a contract field).
 */
export interface SplitFormState {
  readonly strategy: SplitStrategy;
  readonly basis: ApartmentBasis | null;
  readonly percentages: Readonly<Record<string, string>>;
  readonly shares: Readonly<Record<string, string>>;
  readonly customAmounts: Readonly<Record<string, string>>;
  readonly floorBands: readonly FloorBandForm[];
  readonly selector: ParticipantSelectorForm;
  readonly customized: boolean;
}

export function defaultSelector(): ParticipantSelectorForm {
  return {
    scope: 'society',
    buildings: [],
    wings: [],
    floors: [],
    occupancy: [],
    excludeApartments: [],
    includeVacant: null,
    ownerOnly: false,
  };
}

/** A fresh split state: the category's defaults are applied by the caller. */
export function emptySplitState(): SplitFormState {
  return {
    strategy: 'equal',
    basis: null,
    percentages: {},
    shares: {},
    customAmounts: {},
    floorBands: [{ from: '0', to: '0', mult: '1' }],
    selector: defaultSelector(),
    customized: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parsing — text ⇄ the engine's own integer scales
// ─────────────────────────────────────────────────────────────────────────────

const DECIMALS_TWO = /^\d{1,3}(?:\.\d{1,2})?$/;

/**
 * `"33.33"` → `3333` basis points, or `null`.
 *
 * Pure string arithmetic, never a float: the whole part is `× 100` and the two
 * decimals are the last `× 1`, combined as integers — the same discipline the amount
 * parser keeps, so a percentage cannot round on its way in.
 */
export function parsePercentText(raw: string): number | null {
  const text = raw.trim();
  if (text.length === 0) return 0;
  if (!DECIMALS_TWO.test(text)) return null;
  const [whole = '0', decimals = ''] = text.split('.');
  const value = Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
  if (!Number.isSafeInteger(value)) return null;
  if (value < 0 || value > Number(PERCENT_TOTAL_BASIS_POINTS)) return null;
  return value;
}

/** `3333` → `"33.33"` — always two decimals, exactly as the engine's error echoes it. */
export function formatBasisPoints(value: number): string {
  const whole = Math.trunc(value / 100);
  const hundredths = value % 100;
  return `${String(whole)}.${String(hundredths).padStart(2, '0')}`;
}

/**
 * `"1.5"` → `1500` thousandths (the engine's `ShareUnits` scale), or `null`.
 *
 * Up to three decimals — the `apartments.share_units numeric(8, 3)` scale — and the
 * ceiling is the engine's own `MAX_SHARE_UNITS`, so a share the form accepts is one
 * the engine and the column both accept.
 */
export function parseShareText(raw: string): number | null {
  const text = raw.trim();
  if (text.length === 0) return 0;
  if (!/^\d{1,5}(?:\.\d{1,3})?$/.test(text)) return null;
  const [whole = '0', decimals = ''] = text.split('.');
  const value = Number(whole) * Number(ONE_SHARE) + Number(decimals.padEnd(3, '0'));
  if (!Number.isSafeInteger(value)) return null;
  if (value < 0 || value > Number(MAX_SHARE_UNITS)) return null;
  return value;
}

/** `1500` → `"1.5"` — trailing zeros trimmed so `1.500` reads `1.5`. */
export function formatShareUnits(value: number): string {
  const whole = Math.trunc(value / 1000);
  const rest = value % 1000;
  if (rest === 0) return String(whole);
  return `${String(whole)}.${String(rest).padStart(3, '0').replace(/0+$/, '')}`;
}

/** The rupee text for a custom entry, parsed to paise or `null`. **Reuses T074's parser.** */
export function parseCustomPaise(raw: string): number | null {
  return parseRupeeText(raw).paise;
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived totals — the two live indicators
// ─────────────────────────────────────────────────────────────────────────────

/** The sum of the configured percentages, in basis points (unparseable entries count 0). */
export function percentageTotalBasisPoints(state: SplitFormState): number {
  let total = 0;
  for (const text of Object.values(state.percentages)) {
    total += parsePercentText(text) ?? 0;
  }
  return total;
}

/** True when the percentage total is within the engine's one-basis-point tolerance. */
export function percentageTotalOk(state: SplitFormState): boolean {
  const deviation = Math.abs(
    percentageTotalBasisPoints(state) - Number(PERCENT_TOTAL_BASIS_POINTS),
  );
  return deviation <= Number(PERCENT_TOLERANCE_BASIS_POINTS);
}

/**
 * The custom remainder: `amount − Σ entered`, in paise.
 *
 * **Signed on purpose** — positive is unassigned money, negative is over-allocation —
 * and never clamped to zero (§8: "Preserve negative remaining values when
 * overallocated; do not clamp them to zero"): a treasurer who has assigned ₹100 more
 * than the bill must see `−₹100`, not `₹0`, or the balance looks struck when it is
 * not.
 */
export function customRemainderPaise(state: SplitFormState, amountPaise: number | null): number {
  let assigned = 0;
  for (const text of Object.values(state.customAmounts)) {
    assigned += parseCustomPaise(text) ?? 0;
  }
  return (amountPaise ?? 0) - assigned;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why one floor band is malformed, or `null`.
 *
 * Bounds are the engine's own (`FLOOR_MIN`/`FLOOR_MAX`) so the editor refuses exactly
 * the bands the engine would refuse, turning a field error the treasurer can fix into
 * one the server would otherwise raise after a round trip.
 */
export function floorBandProblem(band: FloorBandForm): string | null {
  const from = Number(band.from.trim());
  const to = Number(band.to.trim());
  const mult = Number(band.mult.trim());
  if (!Number.isInteger(from) || !Number.isInteger(to)) return 'Floors must be whole numbers';
  if (from > to) return 'The “from” floor must not be above the “to” floor';
  if (!Number.isFinite(mult) || mult < 0) return 'The multiplier must be zero or more';
  return null;
}

/**
 * Overlap/touching detection across the whole band table — the engine's own rule,
 * restated here so the editor *rejects* a bad table at input time (§8: "Reject
 * overlapping or touching bands", and the acceptance test names it).
 *
 * Two bands touch at a shared floor (one ends at 4, the next starts at 4) and that is
 * refused for the same reason the engine refuses it: a flat on floor 4 would match
 * both, so which multiplier applies would depend on the table's order.
 */
export function floorBandsProblem(bands: readonly FloorBandForm[]): string | null {
  if (bands.length === 0) return 'Add at least one floor band';
  for (const band of bands) {
    const problem = floorBandProblem(band);
    if (problem !== null) return problem;
  }
  const ranges = bands
    .map((band) => ({ from: Number(band.from.trim()), to: Number(band.to.trim()) }))
    .sort((a, b) => a.from - b.from);
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (previous === undefined || current === undefined) continue;
    if (current.from <= previous.to) {
      return `Floor ${String(current.from)} is in more than one band`;
    }
  }
  return null;
}

/**
 * Whether the whole split is submittable, or the sentence that blocks it.
 *
 * Shared by both screens so the configurator's Save and the form's Save agree. The
 * custom remainder rule ("exactly ₹0") is enforced here as the client's own gate; the
 * engine enforces the same rule server-side, and this is an explanation, not the
 * authority (SAD §5.5).
 */
export function splitStateProblem(
  state: SplitFormState,
  amountPaise: number | null,
): string | null {
  if (state.strategy === 'percentage') {
    if (!percentageTotalOk(state)) {
      return `Percentages must total 100.00%; they total ${formatBasisPoints(
        percentageTotalBasisPoints(state),
      )}%.`;
    }
    return null;
  }

  if (state.strategy === 'shares') {
    for (const text of Object.values(state.shares)) {
      const parsed = parseShareText(text);
      if (parsed === null) return 'Every share must be a number like 1.5';
      if (text.trim().length > 0 && parsed <= 0) return 'A share must be greater than zero';
    }
    return null;
  }

  if (state.strategy === 'custom') {
    for (const text of Object.values(state.customAmounts)) {
      if (text.trim().length === 0) continue;
      if (parseCustomPaise(text) === null) return 'Enter custom amounts like 1,23,456.78';
    }
    const remainder = customRemainderPaise(state, amountPaise);
    if (remainder !== 0) {
      return remainder > 0
        ? `Remaining: ${formatPaise(remainder)} — assign the whole amount before saving.`
        : `Over by ${formatPaise(-remainder)} — reduce amounts before saving.`;
    }
    return null;
  }

  if (state.strategy === 'apartment' && state.basis === 'per_floor_band') {
    return floorBandsProblem(state.floorBands);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Summaries — one line for the form's split section
// ─────────────────────────────────────────────────────────────────────────────

/** A short, human description of the configured split, for the form's summary card. */
export function summaryLine(state: SplitFormState): string {
  switch (state.strategy) {
    case 'equal':
      return 'Equal split across the selected flats.';
    case 'percentage':
      return `Percentage split · total ${formatBasisPoints(percentageTotalBasisPoints(state))}%`;
    case 'shares':
      return `Weighted by shares · ${String(Object.keys(state.shares).length)} flat(s) overridden`;
    case 'apartment':
      return `Weighted by ${state.basis === null ? 'per flat' : APARTMENT_BASIS_LABELS[state.basis]}`;
    case 'custom':
      return `Custom amounts · ${String(Object.keys(state.customAmounts).length)} flat(s) assigned`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Payloads — the editor's state → the contract's own shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The selector payload — **only what differs from the product's own defaults**.
 *
 * Every field of the contract's selector is optional, and the server reads an absent one as its
 * default (`DEFAULT_PARTICIPANT_SCOPE` for `scope`, the society's `bill_vacant_flats` for an
 * unstated `includeVacant`, every eligible flat for `ownerOnly`). So the untouched selector is
 * `{}` — which is also the canonical form the API stores in `expenses.participant_selector`, and
 * the reason this must not spray the defaults: an edit that touches only the title would otherwise
 * diff a `{}` row against `{includeVacant: null, ownerOnly: false}` and send a participant-selector
 * patch nobody asked for.
 *
 * `scope` is carried whenever it is not `society`. It is a real choice (the participant selector
 * offers it, and a `building`-scoped selector is refused without buildings), so dropping it would
 * silently record the whole-society reading of a narrowed selection — `isDefaultSelector` is
 * precisely "this payload would be empty".
 */
export function toParticipantSelectorPayload(
  selector: ParticipantSelectorForm,
): ParticipantSelectorPayload {
  return {
    ...(selector.scope === 'society' ? {} : { scope: selector.scope }),
    ...(selector.buildings.length === 0 ? {} : { buildings: [...selector.buildings] }),
    ...(selector.wings.length === 0 ? {} : { wings: [...selector.wings] }),
    ...(selector.floors.length === 0 ? {} : { floors: [...selector.floors] }),
    ...(selector.occupancy.length === 0 ? {} : { occupancy: [...selector.occupancy] }),
    ...(selector.excludeApartments.length === 0
      ? {}
      : { excludeApartments: [...selector.excludeApartments] }),
    ...(selector.includeVacant === null ? {} : { includeVacant: selector.includeVacant }),
    ...(selector.ownerOnly ? { ownerOnly: true } : {}),
  };
}

/** True when the selector asks for the whole society with no filters — the default. */
export function isDefaultSelector(selector: ParticipantSelectorForm): boolean {
  return (
    selector.scope === 'society' &&
    selector.buildings.length === 0 &&
    selector.wings.length === 0 &&
    selector.floors.length === 0 &&
    selector.occupancy.length === 0 &&
    selector.excludeApartments.length === 0 &&
    selector.includeVacant === null &&
    !selector.ownerOnly
  );
}

/**
 * The split's configuration, for the *effective* strategy only.
 *
 * `restrictTo` is the resolved participant set when known (the preview's roster): an
 * entry for a flat outside it is dropped rather than sent, because the API refuses an
 * entry naming an uncharged flat (a `422` the editor would show as an opaque failure).
 * Custom entries are emitted only for non-empty values, which is exactly T057's
 * "exclusion by omission".
 */
export function toSplitConfigPayload(
  state: SplitFormState,
  restrictTo: readonly string[] | null,
): SplitConfigPayload {
  const allowed = restrictTo === null ? null : new Set(restrictTo);
  const keep = (id: string): boolean => allowed === null || allowed.has(id);

  if (state.strategy === 'percentage') {
    const entries = Object.entries(state.percentages)
      .filter(([id]) => keep(id))
      .map(([apartmentId, text]) => ({ apartmentId, basisPoints: parsePercentText(text) ?? 0 }));
    return entries.length === 0 ? {} : { percentages: entries };
  }

  if (state.strategy === 'shares') {
    const entries = Object.entries(state.shares)
      .filter(([id, text]) => keep(id) && text.trim().length > 0)
      .map(([apartmentId, text]) => ({ apartmentId, shareUnits: parseShareText(text) ?? 0 }));
    return entries.length === 0 ? {} : { shares: entries };
  }

  if (state.strategy === 'custom') {
    const entries = Object.entries(state.customAmounts)
      .filter(([id, text]) => keep(id) && text.trim().length > 0)
      .map(([apartmentId, text]) => ({
        apartmentId,
        amountPaise: parseCustomPaise(text) ?? 0,
      }));
    return entries.length === 0 ? {} : { customAmounts: entries };
  }

  if (state.strategy === 'apartment' && state.basis === 'per_floor_band') {
    const bands = state.floorBands.map((band) => ({
      from: Number(band.from.trim()),
      to: Number(band.to.trim()),
      mult: Number(band.mult.trim()),
    }));
    return bands.length === 0 ? {} : { floorBands: bands };
  }

  return {};
}

/**
 * Drop configuration entries for flats the current resolution does not charge.
 *
 * Applied when the configurator is finished, so a flat that was configured and then excluded
 * (or removed by a selector change) does not travel as an entry the API would refuse — the
 * preview restricts itself to the roster already, and this keeps the *submitted* payload to the
 * same set. Percentages, shares and custom amounts only: floor bands belong to the whole split,
 * not to one flat, so they are never pruned.
 */
export function pruneSplitConfig(
  state: SplitFormState,
  chargedApartmentIds: readonly string[],
): Pick<SplitFormState, 'percentages' | 'shares' | 'customAmounts'> {
  const allowed = new Set(chargedApartmentIds);
  const keep = (entries: Readonly<Record<string, string>>): Record<string, string> =>
    Object.fromEntries(Object.entries(entries).filter(([id]) => allowed.has(id)));
  return {
    percentages: keep(state.percentages),
    shares: keep(state.shares),
    customAmounts: keep(state.customAmounts),
  };
}

/**
 * The four split fields the create/update payloads carry.
 *
 * `restrictTo` is the resolved roster when the preview has answered; before that the
 * config is sent as typed, so an early save still describes what the user configured.
 */
export function splitPayloadFields(
  state: SplitFormState,
  restrictTo: readonly string[] | null,
): Pick<
  CreateExpensePayload,
  'splitStrategy' | 'apartmentBasis' | 'splitConfig' | 'participantSelector'
> {
  return {
    splitStrategy: state.strategy,
    apartmentBasis: state.strategy === 'apartment' ? state.basis : null,
    splitConfig: toSplitConfigPayload(state, restrictTo),
    participantSelector: toParticipantSelectorPayload(state.selector),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hydration — a stored expense → the editor's state
// ─────────────────────────────────────────────────────────────────────────────

/** The four stored split fields, as any of a row, a draft's values or the editor shares them. */
export interface SplitValuesLike {
  readonly splitStrategy: SplitStrategy;
  readonly apartmentBasis: ApartmentBasis | null;
  readonly splitConfig: SplitConfigPayload;
  readonly participantSelector: ParticipantSelectorPayload;
}

/**
 * The editor's state from the stored split fields.
 *
 * `splitConfig` is already the contract's parsed shape (the response schema and the form's own
 * `splitConfigSchema` guarantee it), so each entry is copied into the text map the editor edits —
 * a percentage basis point back to `"33.33"`, a share unit back to `"1.5"`, a custom amount back
 * to rupee text. `customized` is passed in because it is a fact about *where* the values came
 * from, not about the values themselves: a stored expense is the user's choice (`true`), a fresh
 * create is not (`false`).
 */
export function splitStateFromValues(source: SplitValuesLike, customized: boolean): SplitFormState {
  const percentages: Record<string, string> = {};
  const shares: Record<string, string> = {};
  const customAmounts: Record<string, string> = {};

  for (const entry of source.splitConfig.percentages ?? []) {
    percentages[entry.apartmentId] = formatBasisPoints(entry.basisPoints);
  }
  for (const entry of source.splitConfig.shares ?? []) {
    shares[entry.apartmentId] = formatShareUnits(entry.shareUnits);
  }
  for (const entry of source.splitConfig.customAmounts ?? []) {
    customAmounts[entry.apartmentId] = formatPaiseForEntry(entry.amountPaise);
  }

  const bands: readonly FloorBandForm[] =
    source.splitConfig.floorBands === undefined || source.splitConfig.floorBands.length === 0
      ? [{ from: '0', to: '0', mult: '1' }]
      : source.splitConfig.floorBands.map((band) => ({
          from: String(band.from),
          to: String(band.to),
          mult: String(band.mult),
        }));

  const selector = source.participantSelector;

  return {
    strategy: source.splitStrategy,
    basis: source.apartmentBasis,
    percentages,
    shares,
    customAmounts,
    floorBands: bands,
    selector: {
      scope: selector.scope ?? 'society',
      buildings: selector.buildings ?? [],
      wings: selector.wings ?? [],
      floors: selector.floors ?? [],
      occupancy: selector.occupancy ?? [],
      excludeApartments: selector.excludeApartments ?? [],
      includeVacant: selector.includeVacant ?? null,
      ownerOnly: selector.ownerOnly ?? false,
    },
    customized,
  };
}

/**
 * Integer paise → rupee text **without** the `₹` symbol, for the custom editor.
 *
 * Written here rather than reusing `formatPaise`, which adds the symbol and the
 * `en-IN` grouping a text *field* must not contain — the field re-parses what it
 * holds, and `parseRupeeText` accepts an optional `₹` but a caret in a prefilled field
 * should carry a bare number.
 */
export function formatPaiseForEntry(paise: number): string {
  const total = BigInt(paise);
  const rupees = total / 100n;
  const remainder = total % 100n;
  return `${groupIndian(rupees.toString())}.${String(remainder).padStart(2, '0')}`;
}
