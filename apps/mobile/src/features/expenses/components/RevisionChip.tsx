import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/Text';

/**
 * The "edited" chip (PRD §3.5.3). It is the affordance that opens the revision history, so
 * the chip and the history screen are one control — a chip that only *reported* edits would
 * leave the history unreachable.
 *
 * ## Three states, and each says something true
 *
 * ```text
 *   no revisions   "Not edited" — plain text, not pressable: there is no history to open
 *   revisions      "Edited · N revisions" — pressable, opens the history
 * ```
 *
 * The count is the number of `expense_revisions` rows the server returned, never
 * `version - 1`: a draft edit bumps the version without writing a revision (revisions are a
 * published expense's mechanism, T068), so deriving the count from the version would claim
 * history that does not exist.
 *
 * The touch target is the MD3 48 dp minimum (`min-h-touch-target`), because the chip sits
 * beside dense financial text on a phone and a small target there is a mis-tap.
 */
export interface RevisionChipProps {
  readonly revisionCount: number;
  /** Opens the revision history. Required when there is at least one revision. */
  onPress?: (() => void) | undefined;
}

export function RevisionChip({ revisionCount, onPress }: RevisionChipProps) {
  if (revisionCount === 0) {
    return (
      <Text variant="bodySmall" color="onSurfaceVariant">
        Not edited
      </Text>
    );
  }

  const label = `Edited · ${String(revisionCount)} revision${revisionCount === 1 ? '' : 's'}`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}. Open the revision history.`}
      onPress={onPress}
      className="min-h-touch-target justify-center rounded-full bg-surface-variant px-3 py-1 active:opacity-80"
    >
      <View className="flex-row items-center gap-1">
        <Text variant="labelMedium" color="onSurfaceVariant">
          {label}
        </Text>
        <Text variant="labelMedium" color="primary">
          View
        </Text>
      </View>
    </Pressable>
  );
}
