import { View } from 'react-native';

import { Text } from '@/components/ui/Text';

import type { RosterEntry } from '../hooks/use-split-preview';
import { formatBasisPoints } from '../schemas/split.schemas';

import { ParticipantValueRow } from './ParticipantValueRow';

/**
 * Percentage split editor (PRD §3.5.2, T075 §8).
 *
 * Each flat gets a percentage; the live line shows the running total in basis points —
 * hundredths of a percent, the engine's own scale — so `33.33 + 33.33 + 33.34` reads
 * `100.00%` exactly. The total is computed with integer arithmetic (`split.schemas.ts`),
 * never a float sum, and the one-basis-point tolerance the engine accepts is applied by
 * `percentageTotalOk`.
 *
 * The rows are the **resolved roster**, so this editor never lists a flat the selector
 * does not charge — the API refuses an entry for a flat outside the resolution, and
 * showing one would make Save fail on a row the treasurer was allowed to fill.
 */
export interface PercentageEditorProps {
  readonly roster: readonly RosterEntry[];
  readonly values: Readonly<Record<string, string>>;
  /** Total in basis points, passed in so the parent computes it once. */
  readonly totalBasisPoints: number;
  readonly totalOk: boolean;
  onChange: (apartmentId: string, text: string) => void;
}

export function PercentageEditor({
  roster,
  values,
  totalBasisPoints,
  totalOk,
  onChange,
}: PercentageEditorProps) {
  return (
    <View className="gap-3">
      <Text variant="titleSmall">Percentage per flat</Text>
      <View className="flex-row items-center justify-between rounded-md bg-surface-container px-3 py-2">
        <Text variant="labelLarge" color="onSurfaceVariant">
          Total
        </Text>
        <Text variant="titleSmall" color={totalOk ? 'success' : 'error'}>
          {`${formatBasisPoints(totalBasisPoints)}%`}
        </Text>
      </View>
      {!totalOk ? (
        <Text variant="bodySmall" color="error">
          Percentages must total 100.00% before the expense can be saved.
        </Text>
      ) : null}

      <View className="gap-3">
        {roster.map((participant) => (
          <ParticipantValueRow
            key={participant.apartmentId}
            apartmentNumber={participant.apartmentNumber}
            value={values[participant.apartmentId] ?? ''}
            placeholder="0.00"
            onChangeText={(text) => onChange(participant.apartmentId, text)}
            testID={`percentage-${participant.apartmentId}`}
          />
        ))}
      </View>
    </View>
  );
}
