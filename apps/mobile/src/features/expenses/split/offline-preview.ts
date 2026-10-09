/**
 * Offline preview — the local `@ses/split-engine` fallback for T075.
 *
 * ## The one thing this file must not do
 *
 * It must not *guess*. A split is a statement about who owes what, and the facts it
 * rests on — which flats participate, who each charge is addressed to, and every
 * apartment attribute a basis weighs — are decided by T063's server-side participant
 * resolution, which reads society state the phone does not hold. Running the engine on
 * a device is therefore permitted **only** when the device already holds an exact,
 * society-scoped **resolved participant snapshot**; otherwise the honest answer is the
 * "Offline preview unavailable" state this module's gate produces. Fabricating an
 * apartment's area, occupancy, ownership or membership would be inventing a bill
 * (T075 §5).
 *
 * ## What it reuses, and what it re-states
 *
 * The allocation, the remainder and the weighting are the shared engine's — `computeSplit`
 * is called, never re-implemented. The *assembly* of a `SplitInput` from a snapshot and a
 * config is re-stated from the API's `buildSplitInput` (that function lives in the API
 * app and cannot be imported here), because the engine's input is a value, not a
 * service. The parity suite drives the same snapshots through both paths and asserts the
 * two agree, which is what keeps this mapping honest (`__tests__/offline-preview.test.ts`).
 *
 * ## Parity is engine parity, and it is labelled as such
 *
 * An offline result is byte-identical to a server result **for the same snapshot and the
 * same config** — that is what the shared engine guarantees and what the tests prove. It
 * is *not* a claim that the phone can reproduce the server's participant resolution:
 * that is end-to-end parity, and it is bounded by whether a snapshot of the resolution
 * is available at all. The two are reported separately (T075 §6).
 */

import { Money, asApartmentId, asMemberId, paise } from '@ses/domain';
import type { ApartmentBasis, SplitStrategy, UnassignedReason } from '@ses/domain';
import { ONE_SHARE, computeSplit } from '@ses/split-engine';
import type {
  ApartmentParticipant,
  CustomParticipant,
  FloorBand,
  PercentageParticipant,
  ShareParticipant,
  SplitInput,
} from '@ses/split-engine';
import type { PreviewSplitResponseDto } from '@ses/contracts';

/** One resolved participant with the facts an apartment basis needs. */
export interface OfflineParticipant {
  readonly memberId: string;
  readonly apartmentId: string;
  readonly apartmentNumber: string;
  /** `apartments.share_units` in the column's own scale (`numeric(8, 3)`): `1.5` is one and a half. */
  readonly shareUnits: number;
  readonly floor: number | null;
  readonly carpetAreaSqft: number | null;
  readonly builtupAreaSqft: number | null;
  readonly bhk: number | null;
  readonly parkingSlots: number;
}

/** A billable flat the resolver could not address — T063's flagged case, carried for offline reporting. */
export interface OfflineUnassigned {
  readonly apartmentId: string;
  readonly apartmentNumber: string;
  readonly reason: UnassignedReason;
}

/**
 * The exact input the local engine may run over.
 *
 * `selectorKey` is the canonical string of the selector this snapshot was resolved
 * against: a snapshot resolved for one selector says nothing about a different one, so
 * re-running the engine under a selector that has since changed would be a fabricated
 * preview. `societyId` and `capturedAt` bound it to a tenant and a moment.
 */
export interface OfflineParticipantSnapshot {
  readonly societyId: string;
  readonly selectorKey: string;
  /** ISO instant the snapshot was resolved. */
  readonly capturedAt: string;
  readonly participants: readonly OfflineParticipant[];
  readonly unassigned: readonly OfflineUnassigned[];
}

/** What the offline engine will run with: the effective strategy and its basis. */
export interface OfflinePlan {
  readonly strategy: SplitStrategy;
  readonly basis: ApartmentBasis | null;
}

/** The strategy-specific configuration, structurally the contract's `splitConfig`. */
export interface OfflineSplitConfig {
  readonly percentages?:
    readonly { readonly apartmentId: string; readonly basisPoints: number }[] | undefined;
  readonly shares?:
    readonly { readonly apartmentId: string; readonly shareUnits: number }[] | undefined;
  readonly customAmounts?:
    readonly { readonly apartmentId: string; readonly amountPaise: number }[] | undefined;
  readonly floorBands?:
    readonly { readonly from: number; readonly to: number; readonly mult: number }[] | undefined;
}

/** How old a snapshot may be before the client stops trusting it for a preview. */
export const OFFLINE_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000;

/** The conditions the offline path must satisfy, or the reason it cannot be used. */
export interface OfflineAvailabilityInput {
  readonly snapshot: OfflineParticipantSnapshot | null | undefined;
  readonly societyId: string | null;
  /** The canonical selector key the *current* editor state resolves to. */
  readonly selectorKey: string;
  /** `Date.now()`, injected so the freshness rule is testable. */
  readonly now: number;
}

/**
 * Why an offline preview is unavailable, or `null` when it may run.
 *
 * The checks are §5's list, in the order the cheapest refusal comes first: a snapshot
 * must exist, belong to the **active** society, have been resolved against the **same**
 * selector, and be recent enough that a society-wide edit cannot have moved the flats
 * under it. A snapshot that does not hold every fact a basis needs is refused by
 * {@link computeOfflinePreview}, not here — that is a property of the run, not the data.
 */
export function offlineUnavailableReason(input: OfflineAvailabilityInput): string | null {
  const { snapshot, societyId, selectorKey, now } = input;
  if (snapshot === null || snapshot === undefined) {
    return 'Offline preview unavailable — no resolved participant snapshot is held on this device.';
  }
  if (societyId === null || snapshot.societyId !== societyId) {
    return 'Offline preview unavailable — the held snapshot belongs to a different society.';
  }
  if (snapshot.selectorKey !== selectorKey) {
    return 'Offline preview unavailable — the participant selection has changed since the snapshot was taken.';
  }
  const capturedAt = Date.parse(snapshot.capturedAt);
  if (!Number.isFinite(capturedAt) || now - capturedAt > OFFLINE_SNAPSHOT_MAX_AGE_MS) {
    return 'Offline preview unavailable — the held snapshot is too old to trust.';
  }
  if (snapshot.participants.length === 0) {
    return 'Offline preview unavailable — the held snapshot has no participants.';
  }
  return null;
}

/** The paise of a custom amount, refusing a non-integer rather than rounding it. */
function toMoney(amountPaise: number): Money {
  return Money.fromPaise(paise(amountPaise));
}

/** `apartments.share_units numeric(8, 3)` → the engine's thousandths — the API's own crossing. */
function storedShareUnits(value: number): number {
  return Math.round(value * Number(ONE_SHARE));
}

function indexByApartment<TEntry extends { readonly apartmentId: string }>(
  entries: readonly TEntry[] | undefined,
  read: (entry: TEntry) => number,
): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  for (const entry of entries ?? []) map.set(entry.apartmentId, read(entry));
  return map;
}

function toApartmentParticipant(participant: OfflineParticipant): ApartmentParticipant {
  return {
    memberId: asMemberId(participant.memberId),
    apartmentId: asApartmentId(participant.apartmentId),
    apartmentNumber: participant.apartmentNumber,
    floor: participant.floor,
    carpetAreaSqft: participant.carpetAreaSqft,
    builtupAreaSqft: participant.builtupAreaSqft,
    bhk: participant.bhk,
    parkingSlots: participant.parkingSlots,
  };
}

/**
 * Snapshot + config → the engine's own `SplitInput` — the mapping the API performs,
 * restated for the device.
 *
 * The defaults are the strategy's own, exactly as `buildSplitInput` applies them: a
 * percentage with no entry is `0`; a share with no entry is the flat's stored
 * `share_units`; a custom entry absent means the flat is excluded; equal and apartment
 * take every resolved participant.
 */
export function buildOfflineSplitInput(
  snapshot: OfflineParticipantSnapshot,
  plan: OfflinePlan,
  amountPaise: number,
  config: OfflineSplitConfig | undefined,
): SplitInput {
  const amount = toMoney(amountPaise);
  const participants = snapshot.participants;

  switch (plan.strategy) {
    case 'equal':
      return {
        strategy: 'equal',
        amount,
        participants: participants.map((participant) => ({
          memberId: asMemberId(participant.memberId),
          apartmentId: asApartmentId(participant.apartmentId),
          apartmentNumber: participant.apartmentNumber,
        })),
      };

    case 'percentage': {
      const entries = indexByApartment(config?.percentages, (entry) => entry.basisPoints);
      const list: PercentageParticipant[] = participants.map((participant) => ({
        memberId: asMemberId(participant.memberId),
        apartmentId: asApartmentId(participant.apartmentId),
        apartmentNumber: participant.apartmentNumber,
        percentage: BigInt(
          entries.get(participant.apartmentId) ?? 0,
        ) as PercentageParticipant['percentage'],
      }));
      return { strategy: 'percentage', amount, participants: list };
    }

    case 'shares': {
      const entries = indexByApartment(config?.shares, (entry) => entry.shareUnits);
      const list: ShareParticipant[] = participants.map((participant) => ({
        memberId: asMemberId(participant.memberId),
        apartmentId: asApartmentId(participant.apartmentId),
        apartmentNumber: participant.apartmentNumber,
        share: BigInt(
          entries.get(participant.apartmentId) ?? storedShareUnits(participant.shareUnits),
        ) as ShareParticipant['share'],
      }));
      return { strategy: 'shares', amount, participants: list };
    }

    case 'custom': {
      const entries = indexByApartment(config?.customAmounts, (entry) => entry.amountPaise);
      const list: CustomParticipant[] = [];
      for (const participant of participants) {
        const stated = entries.get(participant.apartmentId);
        if (stated === undefined) continue; // exclusion by omission — T057
        list.push({
          memberId: asMemberId(participant.memberId),
          apartmentId: asApartmentId(participant.apartmentId),
          apartmentNumber: participant.apartmentNumber,
          amount: toMoney(stated),
        });
      }
      return { strategy: 'custom', amount, participants: list };
    }

    case 'apartment': {
      const facts: readonly ApartmentParticipant[] = participants.map(toApartmentParticipant);
      const basis = plan.basis ?? 'per_flat';
      if (basis === 'per_floor_band') {
        const floorBands: readonly FloorBand[] = (config?.floorBands ?? []).map((band) => ({
          from: band.from,
          to: band.to,
          mult: band.mult,
        }));
        return { strategy: 'apartment', basis, amount, participants: facts, floorBands };
      }
      return { strategy: 'apartment', basis, amount, participants: facts };
    }
  }
}

/** The local engine's answer, or the sentence that explains why it could not run. */
export type OfflinePreviewResult =
  | { readonly ok: true; readonly preview: PreviewSplitResponseDto }
  | { readonly ok: false; readonly problem: string };

/**
 * Run the shared engine over a snapshot and report it in the preview endpoint's own
 * shape, so the configurator renders an online and an offline result through one path.
 *
 * A missing fact an apartment basis needs is **the engine's own** refusal (the flat is
 * excluded with a `MISSING_*` warning), not something this function papers over: the
 * snapshot either holds the truth or the result carries the engine's warning about it.
 */
export function computeOfflinePreview(
  snapshot: OfflineParticipantSnapshot,
  plan: OfflinePlan,
  amountPaise: number,
  config: OfflineSplitConfig | undefined,
): OfflinePreviewResult {
  const input = buildOfflineSplitInput(snapshot, plan, amountPaise, config);
  const computed = computeSplit(input);
  if (!computed.ok) {
    return { ok: false, problem: computed.error.message };
  }

  const result = computed.value;
  const sum = result.allocations.reduce((total, allocation) => total + allocation.amount.paise, 0n);
  if (sum !== result.total.paise) {
    // The engine cannot produce this; a mismatch would be a genuine defect, and refusing
    // to render it is the same conservation check the API's boundary keeps.
    return { ok: false, problem: 'The local split did not reconcile with the amount.' };
  }

  const preview: PreviewSplitResponseDto = {
    totalPaise: Number(result.total.paise),
    participantCount: result.allocations.length,
    allocations: result.allocations.map((allocation) => ({
      memberId: allocation.memberId,
      apartmentId: allocation.apartmentId,
      apartmentNumber: allocation.apartmentNumber,
      weight: Number(allocation.weight),
      amountPaise: Number(allocation.amount.paise),
    })),
    residualPaise: Number(result.residualPaise),
    warnings: result.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
      apartmentIds: [...warning.apartmentIds],
    })),
    unassigned: snapshot.unassigned.map((entry) => ({
      apartmentId: entry.apartmentId,
      apartmentNumber: entry.apartmentNumber,
      reason: entry.reason,
    })),
  };

  return { ok: true, preview };
}
