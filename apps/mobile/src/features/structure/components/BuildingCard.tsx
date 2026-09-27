import { View } from 'react-native';

import { Card } from '@/components/ui/Card';
import { Text } from '@/components/ui/Text';

/**
 * Building list row.
 *
 * One component for the list, so the floor vocabulary is identical everywhere —
 * including its absence. `totalFloors` is `null` when the society has not counted
 * its floors, and that is rendered as *"Floors not recorded"* rather than as `0` or
 * as nothing at all: a blank line reads as a rendering bug, and `0 floors` would
 * claim something the society never said (PRD §5: floors are optional levels).
 */
export interface BuildingCardProps {
  readonly name: string;
  readonly totalFloors: number | null;
  onPress?: (() => void) | undefined;
}

export function BuildingCard({ name, totalFloors, onPress }: BuildingCardProps) {
  return (
    <Card variant="filled" onPress={onPress}>
      <View className="gap-1">
        <Text variant="titleMedium" numberOfLines={1}>
          {name}
        </Text>
        <Text variant="bodySmall" color="onSurfaceVariant">
          {totalFloors === null
            ? 'Floors not recorded'
            : `${totalFloors} ${totalFloors === 1 ? 'floor' : 'floors'}`}
        </Text>
      </View>
    </Card>
  );
}
