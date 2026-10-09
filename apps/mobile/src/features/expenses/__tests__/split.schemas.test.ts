import { MAX_SHARE_UNITS } from '@ses/split-engine';

import {
  APARTMENT_BASIS_LABELS,
  APARTMENT_BASIS_OPTIONS,
  SPLIT_STRATEGY_OPTIONS,
  customRemainderPaise,
  defaultSelector,
  emptySplitState,
  floorBandProblem,
  floorBandsProblem,
  formatBasisPoints,
  formatPaiseForEntry,
  formatShareUnits,
  isDefaultSelector,
  parseCustomPaise,
  parsePercentText,
  parseShareText,
  percentageTotalBasisPoints,
  percentageTotalOk,
  pruneSplitConfig,
  splitPayloadFields,
  splitStateFromValues,
  splitStateProblem,
  summaryLine,
  toParticipantSelectorPayload,
  toSplitConfigPayload,
} from '../schemas/split.schemas';
import type {
  FloorBandForm,
  ParticipantSelectorForm,
  SplitFormState,
} from '../schemas/split.schemas';

/** A state with the given overrides, so each test states only the field it is about. */
function state(overrides: Partial<SplitFormState> = {}): SplitFormState {
  return { ...emptySplitState(), ...overrides };
}

describe('the vocabularies are the domain enums, not a second spelling', () => {
  it('offers the five strategies in enum order', () => {
    expect(SPLIT_STRATEGY_OPTIONS.map((option) => option.value)).toEqual([
      'equal',
      'percentage',
      'shares',
      'apartment',
      'custom',
    ]);
  });

  it('offers the six apartment bases in enum order, and not occupied_only', () => {
    const values = APARTMENT_BASIS_OPTIONS.map((option) => option.value);
    expect(values).toEqual([
      'per_flat',
      'per_sqft_carpet',
      'per_sqft_builtup',
      'per_bhk',
      'per_floor_band',
      'per_parking_slot',
    ]);
    expect(values).not.toContain('occupied_only');
  });

  it('labels every basis', () => {
    for (const option of APARTMENT_BASIS_OPTIONS) {
      expect(APARTMENT_BASIS_LABELS[option.value]).toBe(option.label);
    }
  });
});

describe('parsePercentText', () => {
  it('reads two decimals exactly as basis points', () => {
    expect(parsePercentText('33.33')).toBe(3333);
    expect(parsePercentText('0.01')).toBe(1);
    expect(parsePercentText('100')).toBe(10000);
    expect(parsePercentText('100.00')).toBe(10000);
    expect(parsePercentText('0')).toBe(0);
  });

  it('treats blank as zero, and accepts surrounding whitespace', () => {
    expect(parsePercentText('')).toBe(0);
    expect(parsePercentText('   ')).toBe(0);
    expect(parsePercentText('  12.5  ')).toBe(1250);
  });

  it('pads a single decimal rather than misreading its scale', () => {
    expect(parsePercentText('33.3')).toBe(3330);
    expect(parsePercentText('33.30')).toBe(3330);
  });

  it('refuses a value it cannot represent', () => {
    expect(parsePercentText('100.01')).toBeNull();
    expect(parsePercentText('33.333')).toBeNull();
    expect(parsePercentText('-1')).toBeNull();
    expect(parsePercentText('.5')).toBeNull();
    expect(parsePercentText('abc')).toBeNull();
  });
});

describe('formatBasisPoints', () => {
  it('always renders two decimals', () => {
    expect(formatBasisPoints(3333)).toBe('33.33');
    expect(formatBasisPoints(0)).toBe('0.00');
    expect(formatBasisPoints(1)).toBe('0.01');
    expect(formatBasisPoints(10000)).toBe('100.00');
  });

  it('round-trips through parsePercentText', () => {
    for (const value of [0, 1, 999, 3333, 9999, 10000]) {
      expect(parsePercentText(formatBasisPoints(value))).toBe(value);
    }
  });
});

describe('parseShareText', () => {
  it('reads shares in thousandths, the column scale', () => {
    expect(parseShareText('1')).toBe(1000);
    expect(parseShareText('1.5')).toBe(1500);
    expect(parseShareText('1.25')).toBe(1250);
    expect(parseShareText('0.001')).toBe(1);
  });

  it('treats blank as zero', () => {
    expect(parseShareText('')).toBe(0);
    expect(parseShareText('  ')).toBe(0);
  });

  it('accepts the engine ceiling and refuses one step past it', () => {
    const max = Number(MAX_SHARE_UNITS / 1000n);
    expect(parseShareText(String(max))).toBe(Number(MAX_SHARE_UNITS));
    expect(parseShareText(String(max + 1))).toBeNull();
  });

  it('parses a zero share, leaving the "greater than zero" rule to validation', () => {
    // `parseShareText` answers "what number is this"; the strategy rule is elsewhere.
    expect(parseShareText('0')).toBe(0);
  });

  it('refuses something that is not a share', () => {
    expect(parseShareText('1.2345')).toBeNull();
    expect(parseShareText('-1')).toBeNull();
    expect(parseShareText('100000')).toBeNull();
    expect(parseShareText('abc')).toBeNull();
  });
});

describe('formatShareUnits', () => {
  it('trims trailing zeros', () => {
    expect(formatShareUnits(1500)).toBe('1.5');
    expect(formatShareUnits(1000)).toBe('1');
    expect(formatShareUnits(100)).toBe('0.1');
    expect(formatShareUnits(10)).toBe('0.01');
    expect(formatShareUnits(1)).toBe('0.001');
    expect(formatShareUnits(0)).toBe('0');
  });

  it('round-trips through parseShareText', () => {
    for (const value of [1, 10, 100, 1000, 1500, 9999999]) {
      expect(parseShareText(formatShareUnits(value))).toBe(value);
    }
  });
});

describe('parseCustomPaise reuses the amount parser', () => {
  it('reads Indian-grouped rupees', () => {
    expect(parseCustomPaise('1,23,456.78')).toBe(12_345_678);
    expect(parseCustomPaise('500')).toBe(50_000);
  });

  it('refuses what the amount parser refuses', () => {
    expect(parseCustomPaise('')).toBeNull();
    expect(parseCustomPaise('0')).toBeNull();
    expect(parseCustomPaise('-5')).toBeNull();
    expect(parseCustomPaise('123,456')).toBeNull();
  });
});

describe('percentage total and tolerance', () => {
  it('sums in integer basis points', () => {
    const configured = state({
      strategy: 'percentage',
      percentages: { a: '33.33', b: '33.33', c: '33.34' },
    });
    expect(percentageTotalBasisPoints(configured)).toBe(10000);
    expect(percentageTotalOk(configured)).toBe(true);
  });

  it('accepts one basis point of deviation and refuses more', () => {
    expect(percentageTotalOk(state({ percentages: { a: '99.99' } }))).toBe(true);
    expect(percentageTotalOk(state({ percentages: { a: '100.01' } }))).toBe(false);
    expect(percentageTotalOk(state({ percentages: { a: '99.98' } }))).toBe(false);
    expect(percentageTotalOk(state({ percentages: { a: '60' } }))).toBe(false);
  });

  it('counts an unparseable entry as zero rather than crashing', () => {
    expect(percentageTotalBasisPoints(state({ percentages: { a: 'abc' } }))).toBe(0);
  });
});

describe('customRemainderPaise is signed, never clamped', () => {
  const AMOUNT = 1_000_00; // ₹1,000.00

  it('reports unassigned money as a positive remainder', () => {
    const configured = state({ strategy: 'custom', customAmounts: { a: '300.00' } });
    expect(customRemainderPaise(configured, AMOUNT)).toBe(700_00);
  });

  it('preserves a negative remainder when over-allocated', () => {
    const configured = state({ customAmounts: { a: '600.00', b: '500.00' } });
    expect(customRemainderPaise(configured, AMOUNT)).toBe(-100_00);
  });

  it('is zero when the amounts assign the whole expense', () => {
    const configured = state({ customAmounts: { a: '400.00', b: '600.00' } });
    expect(customRemainderPaise(configured, AMOUNT)).toBe(0);
  });

  it('treats a null amount as zero, so nothing fabricated is subtracted', () => {
    expect(customRemainderPaise(state({ customAmounts: { a: '400.00' } }), null)).toBe(-400_00);
  });
});

describe('floorBandProblem', () => {
  it('accepts a well-formed band, including a zero multiplier', () => {
    expect(floorBandProblem({ from: '0', to: '0', mult: '1' })).toBeNull();
    expect(floorBandProblem({ from: '-2', to: '4', mult: '0' })).toBeNull();
    expect(floorBandProblem({ from: '1', to: '9', mult: '1.5' })).toBeNull();
  });

  it('refuses a reversed range, a non-integer floor and a negative multiplier', () => {
    expect(floorBandProblem({ from: '5', to: '4', mult: '1' })).toMatch(/must not be above/);
    expect(floorBandProblem({ from: 'a', to: '4', mult: '1' })).toMatch(/whole numbers/);
    expect(floorBandProblem({ from: '0', to: '4', mult: '-1' })).toMatch(/zero or more/);
  });
});

describe('floorBandsProblem rejects overlap and touching', () => {
  it('requires at least one band', () => {
    expect(floorBandsProblem([])).toMatch(/at least one floor band/);
  });

  it('accepts a clean, ordered table', () => {
    const bands: FloorBandForm[] = [
      { from: '0', to: '0', mult: '1' },
      { from: '1', to: '2', mult: '2' },
      { from: '3', to: '9', mult: '0' },
    ];
    expect(floorBandsProblem(bands)).toBeNull();
  });

  it('refuses overlapping bands', () => {
    const bands: FloorBandForm[] = [
      { from: '0', to: '4', mult: '1' },
      { from: '2', to: '6', mult: '1' },
    ];
    expect(floorBandsProblem(bands)).toBe('Floor 2 is in more than one band');
  });

  it('refuses touching bands, because a shared floor matches twice', () => {
    const bands: FloorBandForm[] = [
      { from: '0', to: '4', mult: '1' },
      { from: '4', to: '6', mult: '1' },
    ];
    expect(floorBandsProblem(bands)).toBe('Floor 4 is in more than one band');
  });

  it('sorts before comparing, so an out-of-order table is still checked', () => {
    const bands: FloorBandForm[] = [
      { from: '2', to: '6', mult: '1' },
      { from: '0', to: '4', mult: '1' },
    ];
    expect(floorBandsProblem(bands)).not.toBeNull();
  });

  it('reports a single band’s own problem before the table’s', () => {
    expect(floorBandsProblem([{ from: '5', to: '4', mult: '1' }])).toMatch(/must not be above/);
  });
});

describe('splitStateProblem — the client gate the server also enforces', () => {
  it('lets an equal split through with no configuration', () => {
    expect(splitStateProblem(state(), 100_00)).toBeNull();
  });

  it('blocks a percentage split that is off 100%', () => {
    const problem = splitStateProblem(
      state({ strategy: 'percentage', percentages: { a: '60' } }),
      0,
    );
    expect(problem).toContain('100.00%');
    expect(problem).toContain('60.00%');
  });

  it('lets a percentage split through within tolerance', () => {
    const configured = state({
      strategy: 'percentage',
      percentages: { a: '33.33', b: '33.33', c: '33.34' },
    });
    expect(splitStateProblem(configured, 0)).toBeNull();
  });

  it('refuses a malformed share and a zero share, but allows a blank one', () => {
    expect(splitStateProblem(state({ strategy: 'shares', shares: { a: '1.2345' } }), 0)).toMatch(
      /number like 1.5/,
    );
    expect(splitStateProblem(state({ strategy: 'shares', shares: { a: '0' } }), 0)).toMatch(
      /greater than zero/,
    );
    expect(splitStateProblem(state({ strategy: 'shares', shares: { a: '' } }), 0)).toBeNull();
  });

  it('blocks a custom split until the remainder is exactly zero', () => {
    const under = state({ strategy: 'custom', customAmounts: { a: '300.00' } });
    expect(splitStateProblem(under, 1_000_00)).toMatch(/Remaining:/);

    const over = state({ strategy: 'custom', customAmounts: { a: '600.00', b: '500.00' } });
    expect(splitStateProblem(over, 1_000_00)).toMatch(/Over by/);

    const balanced = state({ strategy: 'custom', customAmounts: { a: '400.00', b: '600.00' } });
    expect(splitStateProblem(balanced, 1_000_00)).toBeNull();
  });

  it('refuses a malformed custom amount before reporting a remainder', () => {
    const configured = state({ strategy: 'custom', customAmounts: { a: 'nope' } });
    expect(splitStateProblem(configured, 1_000_00)).toMatch(/Enter custom amounts/);
  });

  it('validates floor bands only for the per_floor_band basis', () => {
    const bands: FloorBandForm[] = [
      { from: '0', to: '4', mult: '1' },
      { from: '4', to: '6', mult: '1' },
    ];
    expect(
      splitStateProblem(
        state({ strategy: 'apartment', basis: 'per_floor_band', floorBands: bands }),
        0,
      ),
    ).not.toBeNull();
    expect(
      splitStateProblem(state({ strategy: 'apartment', basis: 'per_flat', floorBands: bands }), 0),
    ).toBeNull();
  });
});

describe('summaryLine', () => {
  it('describes each strategy in one line', () => {
    expect(summaryLine(state())).toMatch(/Equal split/);
    expect(summaryLine(state({ strategy: 'percentage', percentages: { a: '40', b: '60' } }))).toBe(
      'Percentage split · total 100.00%',
    );
    expect(summaryLine(state({ strategy: 'shares', shares: { a: '1', b: '2' } }))).toBe(
      'Weighted by shares · 2 flat(s) overridden',
    );
    expect(summaryLine(state({ strategy: 'apartment', basis: 'per_bhk' }))).toBe(
      'Weighted by By BHK',
    );
    expect(summaryLine(state({ strategy: 'apartment', basis: null }))).toBe('Weighted by per flat');
    expect(summaryLine(state({ strategy: 'custom', customAmounts: { a: '100' } }))).toBe(
      'Custom amounts · 1 flat(s) assigned',
    );
  });
});

describe('toParticipantSelectorPayload', () => {
  it('is empty for the untouched selector, so a stored `{}` round-trips to `{}`', () => {
    /*
      The API stores the untouched selector as `{}`, and an edit that changes only the title must
      not look like a participant-selector change: emitting the defaults
      (`includeVacant: null`, `ownerOnly: false`) made every edit carry a phantom patch.
    */
    expect(toParticipantSelectorPayload(defaultSelector())).toEqual({});
  });

  it('carries the scope and the dimensions that are set', () => {
    const selector: ParticipantSelectorForm = {
      ...defaultSelector(),
      scope: 'building',
      buildings: ['b1'],
      occupancy: ['rented', 'owner_occupied'],
      includeVacant: true,
      ownerOnly: true,
    };
    expect(toParticipantSelectorPayload(selector)).toEqual({
      scope: 'building',
      buildings: ['b1'],
      occupancy: ['rented', 'owner_occupied'],
      includeVacant: true,
      ownerOnly: true,
    });
  });

  it('omits a `false` ownerOnly and a null includeVacant — both are the server’s own defaults', () => {
    const selector: ParticipantSelectorForm = { ...defaultSelector(), floors: [3] };
    expect(toParticipantSelectorPayload(selector)).toEqual({ floors: [3] });
  });
});

describe('isDefaultSelector', () => {
  it('is true only for the untouched selector', () => {
    expect(isDefaultSelector(defaultSelector())).toBe(true);
    expect(isDefaultSelector({ ...defaultSelector(), buildings: ['b1'] })).toBe(false);
    expect(isDefaultSelector({ ...defaultSelector(), includeVacant: true })).toBe(false);
    expect(isDefaultSelector({ ...defaultSelector(), ownerOnly: true })).toBe(false);
    expect(isDefaultSelector({ ...defaultSelector(), scope: 'building' })).toBe(false);
  });
});

describe('toSplitConfigPayload', () => {
  it('emits percentage entries for the effective strategy', () => {
    const configured = state({ strategy: 'percentage', percentages: { a: '40', b: '60' } });
    expect(toSplitConfigPayload(configured, null)).toEqual({
      percentages: [
        { apartmentId: 'a', basisPoints: 4000 },
        { apartmentId: 'b', basisPoints: 6000 },
      ],
    });
  });

  it('drops a percentage entry for a flat the roster does not charge', () => {
    const configured = state({ strategy: 'percentage', percentages: { a: '40', b: '60' } });
    expect(toSplitConfigPayload(configured, ['a'])).toEqual({
      percentages: [{ apartmentId: 'a', basisPoints: 4000 }],
    });
  });

  it('emits only non-empty share entries', () => {
    const configured = state({ strategy: 'shares', shares: { a: '', b: '1.5' } });
    expect(toSplitConfigPayload(configured, null)).toEqual({
      shares: [{ apartmentId: 'b', shareUnits: 1500 }],
    });
  });

  it('emits only non-empty custom entries — exclusion by omission', () => {
    const configured = state({ strategy: 'custom', customAmounts: { a: '100.00', b: '' } });
    expect(toSplitConfigPayload(configured, null)).toEqual({
      customAmounts: [{ apartmentId: 'a', amountPaise: 10_000 }],
    });
  });

  it('emits the floor bands only for the per_floor_band basis', () => {
    const bands: FloorBandForm[] = [{ from: '1', to: '9', mult: '1.5' }];
    const configured = state({ strategy: 'apartment', basis: 'per_floor_band', floorBands: bands });
    expect(toSplitConfigPayload(configured, null)).toEqual({
      floorBands: [{ from: 1, to: 9, mult: 1.5 }],
    });
    const perFlat = state({ strategy: 'apartment', basis: 'per_flat', floorBands: bands });
    expect(toSplitConfigPayload(perFlat, null)).toEqual({});
  });

  it('returns an empty config for strategies with nothing to carry', () => {
    expect(toSplitConfigPayload(state(), null)).toEqual({});
  });

  it('returns an empty config rather than an empty-keyed object', () => {
    const configured = state({ strategy: 'percentage', percentages: {} });
    expect(toSplitConfigPayload(configured, null)).toEqual({});
  });
});

describe('pruneSplitConfig', () => {
  it('drops entries for flats the resolution no longer charges, and keeps bands untouched', () => {
    const configured = state({
      strategy: 'percentage',
      percentages: { a: '40', b: '60' },
      shares: { a: '1' },
      customAmounts: { a: '100', b: '200' },
    });
    const pruned = pruneSplitConfig(configured, ['a']);
    expect(pruned.percentages).toEqual({ a: '40' });
    expect(pruned.shares).toEqual({ a: '1' });
    expect(pruned.customAmounts).toEqual({ a: '100' });
  });
});

describe('splitPayloadFields', () => {
  it('carries the strategy, the basis only for apartment, the config and the selector', () => {
    const configured = state({ strategy: 'apartment', basis: 'per_bhk', customized: true });
    expect(splitPayloadFields(configured, null)).toEqual({
      splitStrategy: 'apartment',
      apartmentBasis: 'per_bhk',
      splitConfig: {},
      // The untouched selector is `{}` — the API's own canonical empty selector.
      participantSelector: {},
    });
  });

  it('nulls the basis for a strategy that is not apartment, even if one is set', () => {
    const configured = state({ strategy: 'shares', basis: 'per_flat', shares: { a: '1' } });
    expect(splitPayloadFields(configured, null).apartmentBasis).toBeNull();
  });
});

describe('splitStateFromValues — hydration from stored fields', () => {
  it('rebuilds each text map from the contract shape', () => {
    const hydrated = splitStateFromValues(
      {
        splitStrategy: 'percentage',
        apartmentBasis: null,
        splitConfig: {
          percentages: [{ apartmentId: 'a', basisPoints: 3333 }],
          shares: [{ apartmentId: 'b', shareUnits: 1500 }],
          customAmounts: [{ apartmentId: 'c', amountPaise: 12_345_678 }],
          floorBands: [{ from: 1, to: 9, mult: 1.5 }],
        },
        participantSelector: {
          buildings: ['b1'],
          includeVacant: true,
          ownerOnly: false,
        },
      },
      true,
    );

    expect(hydrated.strategy).toBe('percentage');
    expect(hydrated.basis).toBeNull();
    expect(hydrated.percentages).toEqual({ a: '33.33' });
    expect(hydrated.shares).toEqual({ b: '1.5' });
    expect(hydrated.customAmounts).toEqual({ c: '1,23,456.78' });
    expect(hydrated.floorBands).toEqual([{ from: '1', to: '9', mult: '1.5' }]);
    expect(hydrated.selector.buildings).toEqual(['b1']);
    expect(hydrated.selector.includeVacant).toBe(true);
    expect(hydrated.customized).toBe(true);
  });

  it('falls back to a single neutral band when none were stored', () => {
    const hydrated = splitStateFromValues(
      {
        splitStrategy: 'equal',
        apartmentBasis: null,
        splitConfig: {},
        participantSelector: {},
      },
      false,
    );
    expect(hydrated.floorBands).toEqual([{ from: '0', to: '0', mult: '1' }]);
    expect(hydrated.selector).toEqual(defaultSelector());
    expect(hydrated.customized).toBe(false);
  });
});

describe('formatPaiseForEntry', () => {
  it('groups like a bill and never carries the symbol', () => {
    expect(formatPaiseForEntry(12_345_678)).toBe('1,23,456.78');
    expect(formatPaiseForEntry(50_000)).toBe('500.00');
    expect(formatPaiseForEntry(100)).toBe('1.00');
    expect(formatPaiseForEntry(0)).toBe('0.00');
    expect(formatPaiseForEntry(12_345_678)).not.toContain('₹');
  });

  it('round-trips through the amount parser', () => {
    for (const paise of [1, 100, 99_999, 12_345_678]) {
      expect(parseCustomPaise(formatPaiseForEntry(paise))).toBe(paise);
    }
  });
});
