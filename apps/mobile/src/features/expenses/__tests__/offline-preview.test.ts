import { Money, asApartmentId, asMemberId, paise } from '@ses/domain';
import { basisPoints, computeSplit, shareUnits } from '@ses/split-engine';
import type {
  ApartmentParticipant,
  CustomParticipant,
  PercentageParticipant,
  ShareParticipant,
  SplitInput,
  SplitResult,
} from '@ses/split-engine';

import {
  OFFLINE_SNAPSHOT_MAX_AGE_MS,
  buildOfflineSplitInput,
  computeOfflinePreview,
  offlineUnavailableReason,
} from '../split/offline-preview';
import type {
  OfflineParticipant,
  OfflineParticipantSnapshot,
  OfflinePlan,
  OfflineSplitConfig,
} from '../split/offline-preview';

/**
 * Offline preview (T075 §5, §6).
 *
 * Two different claims are tested here, deliberately kept apart:
 *
 *  1. **Engine parity.** Offline and server results are identical *for the same snapshot and
 *     config* — that is the shared engine's guarantee, and the tests assert it by running the
 *     same facts through `computeSplit` directly and comparing. This covers the mapping (the
 *     shares fall-back, the custom omission, the percentage default) that the API performs.
 *  2. **Refusal to fabricate.** When the exact resolved facts are not held — no snapshot, the
 *     wrong society, a changed selector, a stale capture — the offline path must produce its
 *     explicit unavailable state and *no numbers*. Engine parity does not imply resolution
 *     parity, and nothing here pretends otherwise.
 */

const AMOUNT = 70_000; // ₹700.00 — divisible six ways in the cases below.

function participant(
  overrides: Partial<OfflineParticipant> & { readonly index: number },
): OfflineParticipant {
  const { index, ...rest } = overrides;
  return {
    memberId: `m${String(index)}`,
    apartmentId: `ap${String(index)}`,
    apartmentNumber: `A-10${String(index)}`,
    shareUnits: 1,
    floor: 0,
    carpetAreaSqft: 1000,
    builtupAreaSqft: 1200,
    bhk: 2,
    parkingSlots: 1,
    ...rest,
  };
}

const P1 = participant({ index: 1 });
const P2 = participant({
  index: 2,
  shareUnits: 2,
  floor: 1,
  carpetAreaSqft: 2000,
  builtupAreaSqft: 2400,
  bhk: 3,
  parkingSlots: 0,
});
const P3 = participant({ index: 3, floor: 5, parkingSlots: 2 });

const CAPTURED_AT = '2026-10-09T10:00:00.000Z';
const NOW = Date.parse(CAPTURED_AT) + 1000;

function snapshot(overrides: Partial<OfflineParticipantSnapshot> = {}): OfflineParticipantSnapshot {
  return {
    societyId: 'soc-1',
    selectorKey: '{"includeVacant":null,"ownerOnly":false}',
    capturedAt: CAPTURED_AT,
    participants: [P1, P2, P3],
    unassigned: [],
    ...overrides,
  };
}

/** The allocate-half of `computeSplit`, in the preview DTO's own shape. */
function projectAllocations(result: SplitResult) {
  return result.allocations.map((allocation) => ({
    memberId: allocation.memberId,
    apartmentId: allocation.apartmentId,
    apartmentNumber: allocation.apartmentNumber,
    weight: Number(allocation.weight),
    amountPaise: Number(allocation.amount.paise),
  }));
}

/** Just the amounts, in allocation order — the assertion most tests want to read. */
function amounts(preview: {
  readonly allocations: readonly {
    readonly apartmentNumber: string;
    readonly amountPaise: number;
  }[];
}): [string, number][] {
  return preview.allocations.map((allocation) => [
    allocation.apartmentNumber,
    allocation.amountPaise,
  ]);
}

function okPreview(
  snapshotValue: OfflineParticipantSnapshot,
  plan: OfflinePlan,
  config: OfflineSplitConfig | undefined = undefined,
) {
  const result = computeOfflinePreview(snapshotValue, plan, AMOUNT, config);
  if (!result.ok) throw new Error(`expected an offline preview, got: ${result.problem}`);
  return result.preview;
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine parity — all five strategies, all six bases
// ─────────────────────────────────────────────────────────────────────────────

const FACTS: readonly ApartmentParticipant[] = [P1, P2, P3].map((entry) => ({
  memberId: asMemberId(entry.memberId),
  apartmentId: asApartmentId(entry.apartmentId),
  apartmentNumber: entry.apartmentNumber,
  floor: entry.floor,
  carpetAreaSqft: entry.carpetAreaSqft,
  builtupAreaSqft: entry.builtupAreaSqft,
  bhk: entry.bhk,
  parkingSlots: entry.parkingSlots,
}));

interface ParityCase {
  readonly name: string;
  readonly plan: OfflinePlan;
  readonly config: OfflineSplitConfig | undefined;
  /** The same request assembled the way the API's `buildSplitInput` does. */
  readonly input: SplitInput;
}

const EQUAL_INPUT: SplitInput = {
  strategy: 'equal',
  amount: Money.fromPaise(paise(AMOUNT)),
  participants: FACTS.map(({ memberId, apartmentId, apartmentNumber }) => ({
    memberId,
    apartmentId,
    apartmentNumber,
  })),
};

const PARITY_CASES: readonly ParityCase[] = [
  {
    name: 'equal',
    plan: { strategy: 'equal', basis: null },
    config: undefined,
    input: EQUAL_INPUT,
  },
  {
    name: 'percentage',
    plan: { strategy: 'percentage', basis: null },
    config: {
      percentages: [
        { apartmentId: 'ap1', basisPoints: 5000 },
        { apartmentId: 'ap2', basisPoints: 3000 },
        { apartmentId: 'ap3', basisPoints: 2000 },
      ],
    },
    input: {
      strategy: 'percentage',
      amount: Money.fromPaise(paise(AMOUNT)),
      participants: FACTS.map<PercentageParticipant>(
        ({ memberId, apartmentId, apartmentNumber }, index) => ({
          memberId,
          apartmentId,
          apartmentNumber,
          percentage: basisPoints([5000, 3000, 2000][index] ?? 0),
        }),
      ),
    },
  },
  {
    // No `shares` entry: the flat's stored `share_units` is the fall-back — the API's rule.
    name: 'shares (stored share_units fall-back)',
    plan: { strategy: 'shares', basis: null },
    config: undefined,
    input: {
      strategy: 'shares',
      amount: Money.fromPaise(paise(AMOUNT)),
      participants: FACTS.map<ShareParticipant>(
        ({ memberId, apartmentId, apartmentNumber }, index) => ({
          memberId,
          apartmentId,
          apartmentNumber,
          share: shareUnits([1000, 2000, 1000][index] ?? 0),
        }),
      ),
    },
  },
  {
    name: 'custom',
    plan: { strategy: 'custom', basis: null },
    config: {
      customAmounts: [
        { apartmentId: 'ap1', amountPaise: 14000 },
        { apartmentId: 'ap2', amountPaise: 35000 },
        { apartmentId: 'ap3', amountPaise: 21000 },
      ],
    },
    input: {
      strategy: 'custom',
      amount: Money.fromPaise(paise(AMOUNT)),
      participants: FACTS.map<CustomParticipant>(
        ({ memberId, apartmentId, apartmentNumber }, index) => ({
          memberId,
          apartmentId,
          apartmentNumber,
          amount: Money.fromPaise(paise([14000, 35000, 21000][index] ?? 0)),
        }),
      ),
    },
  },
  {
    name: 'apartment per_flat',
    plan: { strategy: 'apartment', basis: 'per_flat' },
    config: undefined,
    input: {
      strategy: 'apartment',
      basis: 'per_flat',
      amount: Money.fromPaise(paise(AMOUNT)),
      participants: FACTS,
    },
  },
  {
    name: 'apartment per_sqft_carpet',
    plan: { strategy: 'apartment', basis: 'per_sqft_carpet' },
    config: undefined,
    input: {
      strategy: 'apartment',
      basis: 'per_sqft_carpet',
      amount: Money.fromPaise(paise(AMOUNT)),
      participants: FACTS,
    },
  },
  {
    name: 'apartment per_sqft_builtup',
    plan: { strategy: 'apartment', basis: 'per_sqft_builtup' },
    config: undefined,
    input: {
      strategy: 'apartment',
      basis: 'per_sqft_builtup',
      amount: Money.fromPaise(paise(AMOUNT)),
      participants: FACTS,
    },
  },
  {
    name: 'apartment per_bhk',
    plan: { strategy: 'apartment', basis: 'per_bhk' },
    config: undefined,
    input: {
      strategy: 'apartment',
      basis: 'per_bhk',
      amount: Money.fromPaise(paise(AMOUNT)),
      participants: FACTS,
    },
  },
  {
    name: 'apartment per_parking_slot',
    plan: { strategy: 'apartment', basis: 'per_parking_slot' },
    config: undefined,
    input: {
      strategy: 'apartment',
      basis: 'per_parking_slot',
      amount: Money.fromPaise(paise(AMOUNT)),
      participants: FACTS,
    },
  },
  {
    name: 'apartment per_floor_band',
    plan: { strategy: 'apartment', basis: 'per_floor_band' },
    config: {
      floorBands: [
        { from: 0, to: 0, mult: 1 },
        { from: 1, to: 2, mult: 2 },
        { from: 3, to: 9, mult: 0 },
      ],
    },
    input: {
      strategy: 'apartment',
      basis: 'per_floor_band',
      amount: Money.fromPaise(paise(AMOUNT)),
      participants: FACTS,
      floorBands: [
        { from: 0, to: 0, mult: 1 },
        { from: 1, to: 2, mult: 2 },
        { from: 3, to: 9, mult: 0 },
      ],
    },
  },
];

describe('engine parity — the offline projection equals computeSplit over the same facts', () => {
  it.each(PARITY_CASES.map((testCase) => [testCase.name, testCase] as const))(
    '%s',
    (_name, testCase) => {
      const preview = okPreview(snapshot(), testCase.plan, testCase.config);
      const direct = computeSplit(testCase.input);
      expect(direct.ok).toBe(true);
      if (!direct.ok) return;

      expect(preview.allocations).toEqual(projectAllocations(direct.value));
      expect(preview.residualPaise).toBe(Number(direct.value.residualPaise));
      expect(preview.warnings).toEqual(
        direct.value.warnings.map((warning) => ({
          code: warning.code,
          message: warning.message,
          apartmentIds: [...warning.apartmentIds],
        })),
      );
    },
  );
});

describe('the explicit numbers — so a change in either engine or mapping is visible', () => {
  it('splits equally with the residual paisa on the lowest flat number', () => {
    const preview = okPreview(snapshot(), { strategy: 'equal', basis: null });
    expect(amounts(preview)).toEqual([
      ['A-101', 23334],
      ['A-102', 23333],
      ['A-103', 23333],
    ]);
    expect(preview.participantCount).toBe(3);
    expect(preview.totalPaise).toBe(AMOUNT);
    expect(preview.residualPaise).toBe(0);
  });

  it('weights a shares split by share units', () => {
    const preview = okPreview(
      snapshot(),
      { strategy: 'shares', basis: null },
      {
        shares: [
          { apartmentId: 'ap1', shareUnits: 1000 },
          { apartmentId: 'ap2', shareUnits: 2000 },
          { apartmentId: 'ap3', shareUnits: 1000 },
        ],
      },
    );
    expect(amounts(preview)).toEqual([
      ['A-101', 17500],
      ['A-102', 35000],
      ['A-103', 17500],
    ]);
    expect(preview.allocations.map((allocation) => allocation.weight)).toEqual([1000, 2000, 1000]);
  });

  it('weights by carpet area', () => {
    const preview = okPreview(snapshot(), { strategy: 'apartment', basis: 'per_sqft_carpet' });
    expect(amounts(preview)).toEqual([
      ['A-101', 17500],
      ['A-102', 35000],
      ['A-103', 17500],
    ]);
  });

  it('weights by BHK', () => {
    const preview = okPreview(snapshot(), { strategy: 'apartment', basis: 'per_bhk' });
    expect(amounts(preview)).toEqual([
      ['A-101', 20000],
      ['A-102', 30000],
      ['A-103', 20000],
    ]);
  });

  it('exempts a zero-parking flat at ₹0 but still lists it', () => {
    const preview = okPreview(snapshot(), { strategy: 'apartment', basis: 'per_parking_slot' });
    expect(amounts(preview)).toEqual([
      ['A-101', 23333],
      ['A-102', 0],
      ['A-103', 46667],
    ]);
    expect(preview.participantCount).toBe(3);
  });

  it('charges a zero-multiplier floor band exactly ₹0 and still lists it', () => {
    const preview = okPreview(
      snapshot(),
      { strategy: 'apartment', basis: 'per_floor_band' },
      {
        floorBands: [
          { from: 0, to: 0, mult: 1 },
          { from: 1, to: 2, mult: 2 },
          { from: 3, to: 9, mult: 0 },
        ],
      },
    );
    expect(amounts(preview)).toEqual([
      ['A-101', 23333],
      ['A-102', 46667],
      ['A-103', 0],
    ]);
  });

  it('every strategy conserves the amount exactly', () => {
    for (const testCase of PARITY_CASES) {
      const preview = okPreview(snapshot(), testCase.plan, testCase.config);
      const sum = preview.allocations.reduce(
        (total, allocation) => total + allocation.amountPaise,
        0,
      );
      expect({ name: testCase.name, sum }).toEqual({ name: testCase.name, sum: AMOUNT });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Missing facts, exclusion, and unassigned
// ─────────────────────────────────────────────────────────────────────────────

describe('missing apartment facts are the engine’s own warning, not a papered-over default', () => {
  it('excludes a flat with no carpet area and reports MISSING_AREA', () => {
    const preview = okPreview(
      snapshot({ participants: [P1, participant({ index: 2, carpetAreaSqft: null })] }),
      { strategy: 'apartment', basis: 'per_sqft_carpet' },
    );
    expect(amounts(preview)).toEqual([['A-101', AMOUNT]]);
    expect(preview.participantCount).toBe(1);
    expect(preview.warnings).toEqual([
      {
        code: 'MISSING_AREA',
        message: expect.any(String),
        apartmentIds: ['ap2'],
      },
    ]);
  });

  it('reports MISSING_BHK and shares the whole amount among the rest', () => {
    const preview = okPreview(
      snapshot({ participants: [P1, participant({ index: 2, bhk: null }), P3] }),
      { strategy: 'apartment', basis: 'per_bhk' },
    );
    expect(preview.warnings.map((warning) => warning.code)).toEqual(['MISSING_BHK']);
    expect(preview.warnings[0]?.apartmentIds).toEqual(['ap2']);
    expect(preview.allocations.map((allocation) => allocation.apartmentNumber)).toEqual([
      'A-101',
      'A-103',
    ]);
  });

  it('reports MISSING_FLOOR and leaves the unbanded flat out', () => {
    const preview = okPreview(
      snapshot({ participants: [P1, participant({ index: 2, floor: null }), P3] }),
      { strategy: 'apartment', basis: 'per_floor_band' },
      {
        floorBands: [
          { from: 0, to: 0, mult: 1 },
          { from: 1, to: 2, mult: 2 },
          { from: 3, to: 9, mult: 0 },
        ],
      },
    );
    expect(preview.warnings.map((warning) => warning.code)).toEqual(['MISSING_FLOOR']);
    expect(preview.allocations.map((allocation) => allocation.apartmentNumber)).not.toContain(
      'A-102',
    );
  });

  it('carries no warning for a strategy that cannot produce one', () => {
    expect(okPreview(snapshot(), { strategy: 'equal', basis: null }).warnings).toEqual([]);
  });
});

describe('custom exclusion by omission', () => {
  it('lists only the flats with an amount, and still conserves the whole expense', () => {
    const preview = okPreview(
      snapshot(),
      { strategy: 'custom', basis: null },
      {
        customAmounts: [
          { apartmentId: 'ap1', amountPaise: 30000 },
          { apartmentId: 'ap3', amountPaise: 40000 },
        ],
      },
    );
    expect(preview.allocations.map((allocation) => allocation.apartmentNumber)).toEqual([
      'A-101',
      'A-103',
    ]);
    expect(preview.participantCount).toBe(2);
    expect(amounts(preview)).toEqual([
      ['A-101', 30000],
      ['A-103', 40000],
    ]);
  });
});

describe('unassigned flats are carried through from the snapshot', () => {
  it('reports them alongside the allocations', () => {
    const preview = okPreview(
      snapshot({
        unassigned: [
          { apartmentId: 'ap9', apartmentNumber: 'A-109', reason: 'unassigned_no_owner' },
        ],
      }),
      { strategy: 'equal', basis: null },
    );
    expect(preview.unassigned).toEqual([
      { apartmentId: 'ap9', apartmentNumber: 'A-109', reason: 'unassigned_no_owner' },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A run that cannot proceed is a returned failure, never invented numbers
// ─────────────────────────────────────────────────────────────────────────────

describe('a split the engine refuses is reported, not guessed', () => {
  it('refuses a custom split that does not assign the whole expense', () => {
    const result = computeOfflinePreview(snapshot(), { strategy: 'custom', basis: null }, AMOUNT, {
      customAmounts: [{ apartmentId: 'ap1', amountPaise: 100 }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toMatch(/must assign exactly/);
  });

  it('refuses percentages that do not total 100%', () => {
    const result = computeOfflinePreview(
      snapshot(),
      { strategy: 'percentage', basis: null },
      AMOUNT,
      {
        percentages: [{ apartmentId: 'ap1', basisPoints: 5000 }],
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toContain('100.00%');
  });

  it('refuses an empty participant list rather than returning an empty split', () => {
    const result = computeOfflinePreview(
      snapshot({ participants: [] }),
      { strategy: 'equal', basis: null },
      AMOUNT,
      undefined,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).toMatch(/at least one participant/);
  });
});

describe('buildOfflineSplitInput mirrors the API mapping', () => {
  it('defaults a missing percentage entry to zero, not to a share of the rest', () => {
    const input = buildOfflineSplitInput(
      snapshot(),
      { strategy: 'percentage', basis: null },
      AMOUNT,
      {
        percentages: [{ apartmentId: 'ap2', basisPoints: 10000 }],
      },
    );
    expect(input.strategy).toBe('percentage');
    if (input.strategy !== 'percentage') return;
    expect(input.participants.map((entry) => entry.percentage)).toEqual([0n, 10000n, 0n]);
  });

  it('falls a missing share entry back to the flat’s stored share_units', () => {
    const input = buildOfflineSplitInput(
      snapshot(),
      { strategy: 'shares', basis: null },
      AMOUNT,
      undefined,
    );
    if (input.strategy !== 'shares') throw new Error('expected a shares input');
    expect(input.participants.map((entry) => entry.share)).toEqual([1000n, 2000n, 1000n]);
  });

  it('excludes a custom participant that has no stated amount', () => {
    const input = buildOfflineSplitInput(snapshot(), { strategy: 'custom', basis: null }, AMOUNT, {
      customAmounts: [{ apartmentId: 'ap2', amountPaise: AMOUNT }],
    });
    if (input.strategy !== 'custom') throw new Error('expected a custom input');
    expect(input.participants.map((entry) => entry.apartmentNumber)).toEqual(['A-102']);
  });

  it('defaults the apartment basis to per_flat when none is stated', () => {
    const input = buildOfflineSplitInput(
      snapshot(),
      { strategy: 'apartment', basis: null },
      AMOUNT,
      undefined,
    );
    if (input.strategy !== 'apartment') throw new Error('expected an apartment input');
    expect(input.basis).toBe('per_flat');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The availability gate — the explicit refusal
// ─────────────────────────────────────────────────────────────────────────────

describe('offlineUnavailableReason', () => {
  const selectorKey = snapshot().selectorKey;
  const base = { societyId: 'soc-1', selectorKey, now: NOW };

  it('permits the run when the snapshot is exact, current and non-empty', () => {
    expect(offlineUnavailableReason({ ...base, snapshot: snapshot() })).toBeNull();
  });

  it('refuses when no snapshot is held', () => {
    expect(offlineUnavailableReason({ ...base, snapshot: null })).toMatch(
      /no resolved participant snapshot/,
    );
    expect(offlineUnavailableReason({ ...base, snapshot: undefined })).toMatch(
      /no resolved participant snapshot/,
    );
  });

  it('refuses a snapshot from another society, or with no society at all', () => {
    expect(
      offlineUnavailableReason({ ...base, snapshot: snapshot({ societyId: 'soc-2' }) }),
    ).toMatch(/different society/);
    expect(offlineUnavailableReason({ ...base, societyId: null, snapshot: snapshot() })).toMatch(
      /different society/,
    );
  });

  it('refuses a snapshot resolved against a different selector', () => {
    expect(
      offlineUnavailableReason({
        ...base,
        selectorKey: '{"ownerOnly":true}',
        snapshot: snapshot(),
      }),
    ).toMatch(/selection has changed/);
  });

  it('refuses a snapshot older than the freshness bound', () => {
    expect(
      offlineUnavailableReason({
        ...base,
        now: Date.parse(CAPTURED_AT) + OFFLINE_SNAPSHOT_MAX_AGE_MS + 1,
        snapshot: snapshot(),
      }),
    ).toMatch(/too old/);
  });

  it('accepts a snapshot exactly at the freshness bound', () => {
    expect(
      offlineUnavailableReason({
        ...base,
        now: Date.parse(CAPTURED_AT) + OFFLINE_SNAPSHOT_MAX_AGE_MS,
        snapshot: snapshot(),
      }),
    ).toBeNull();
  });

  it('refuses an unreadable capture instant', () => {
    expect(
      offlineUnavailableReason({ ...base, snapshot: snapshot({ capturedAt: 'not-a-date' }) }),
    ).toMatch(/too old/);
  });

  it('refuses an empty snapshot — there is nobody to charge', () => {
    expect(offlineUnavailableReason({ ...base, snapshot: snapshot({ participants: [] }) })).toMatch(
      /no participants/,
    );
  });

  it('never leaks allocation numbers in a refusal sentence', () => {
    const reason = offlineUnavailableReason({ ...base, snapshot: null });
    expect(reason).not.toMatch(/₹/);
  });
});
