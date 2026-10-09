import { View } from 'react-native';

import { Text } from '@/components/ui/Text';

import type { RosterEntry } from '../hooks/use-split-preview';
import { formatPaise } from '../schemas/expense.schemas';
import { parseCustomPaise } from '../schemas/split.schemas';

import { ParticipantValueRow } from './ParticipantValueRow';

/**
 * Custom split editor (PRD §3.5.5, T075 §8).
 *
 * The treasurer types an **exact amount** per flat and a live `Remaining: ₹X` shows what
 * is left to assign. Save is disabled by the parent until the remainder is exactly ₹0;
 * this component's job is to *show* the number honestly — and, in particular, **not to
 * clamp it**: an over-allocation reads `−₹100` (the sign carried by `formatPaise`)
 * rather than `₹0`, because a remainder that looks struck when it is not is how a bill
 * silently loses or invents money.
 *
 * The rupee field reuses **T074's exact parser** (`parseRupeeText`, via
 * `parseCustomPaise`): Indian grouping accepted, no floating point at any point. A flat
 * with an empty field is omitted from the split — T057's "exclusion by omission" — so a
 * blank row means "this flat is not charged", not "zero".
 */
export interface CustomAmountEditorProps {
  readonly roster: readonly RosterEntry[];
  readonly values: Readonly<Record<string, string>>;
  /** The expense amount, or `null` while it is not yet valid. */
  readonly amountPaise: number | null;
  /** The signed remainder in paise (positive unassigned, negative overallocated). */
  readonly remainderPaise: number;
  onChange: (apartmentId: string, text: string) => void;
}

export function CustomAmountEditor({
  roster,
  values,
  amountPaise,
  remainderPaise,
  onChange,
}: CustomAmountEditorProps) {
  const balanced = amountPaise !== null && remainderPaise === 0;

  return (
    <View className="gap-3">
      <Text variant="titleSmall">Amount per flat</Text>

      <View className="flex-row items-center justify-between rounded-md bg-surface-container px-3 py-2">
        <Text variant="labelLarge" color="onSurfaceVariant">
          Remaining
        </Text>
        <Text variant="titleSmall" color={balanced ? 'success' : 'error'}>
          {formatPaise(remainderPaise)}
        </Text>
      </View>
      {!balanced ? (
        <Text variant="bodySmall" color="error">
          The amounts must assign the whole expense exactly before it can be saved.
        </Text>
      ) : null}

      <View className="gap-3">
        {roster.map((participant) => {
          const value = values[participant.apartmentId] ?? '';
          const invalid = value.trim().length > 0 && parseCustomPaise(value) === null;
          return (
            <ParticipantValueRow
              key={participant.apartmentId}
              apartmentNumber={participant.apartmentNumber}
              value={value}
              placeholder="0.00"
              error={invalid ? 'Enter an amount like 1,23,456.78' : undefined}
              onChangeText={(text) => onChange(participant.apartmentId, text)}
              testID={`custom-${participant.apartmentId}`}
            />
          );
        })}
      </View>
    </View>
  );
}
