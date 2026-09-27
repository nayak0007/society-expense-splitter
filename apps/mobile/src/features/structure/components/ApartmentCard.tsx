import { View } from 'react-native';

import { Card } from '@/components/ui/Card';
import { Text } from '@/components/ui/Text';
import type { Apartment } from '@ses/domain';

import { OCCUPANCY_STATUS_LABELS } from '../schemas/apartment.schemas';

/**
 * Flat list row.
 *
 * One component for the list, so the vocabulary is identical everywhere — including
 * its absences. Every measurement on a flat is nullable, and each one renders its
 * own "not recorded" copy rather than a `0` or a blank: `0` would claim something
 * the society never said (and `0 sq ft` is not a legal area), while a blank line
 * reads as a rendering bug.
 *
 * The badges are the two facts a manager scans a list for — is this flat lived in,
 * and is it charged like a residence. They are text, not colour alone: the occupancy
 * and the commercial flag are the two things that change what a flat is billed, and
 * a distinction that exists only as a colour is invisible to a substantial fraction
 * of users.
 */
export interface ApartmentCardProps {
  readonly apartment: Apartment;
  onPress?: (() => void) | undefined;
}

export function ApartmentCard({ apartment, onPress }: ApartmentCardProps) {
  const floor =
    apartment.floor === null
      ? 'Floor not recorded'
      : apartment.floor === 0
        ? 'Ground floor'
        : `Floor ${apartment.floor}`;

  return (
    <Card variant="filled" onPress={onPress}>
      <View className="gap-2">
        <View className="flex-row items-center justify-between gap-2">
          {/*
            A wrapping `View` rather than `className` on `Text`: `Text` is the
            typography primitive and takes no style props by design, so the flex
            weight lives on the box around it.
          */}
          <View className="flex-1">
            <Text variant="titleMedium" numberOfLines={1}>
              {apartment.apartmentNumber}
            </Text>
          </View>
          <Text variant="labelMedium" color="onSurfaceVariant">
            {floor}
          </Text>
        </View>

        <Text variant="bodySmall" color="onSurfaceVariant">
          {measured(apartment.bhk, (value) => `${value} BHK`)} ·{' '}
          {measured(apartment.carpetAreaSqft, (value) => `${value} sq ft carpet`)}
        </Text>

        <View className="flex-row flex-wrap gap-2">
          <Badge label={OCCUPANCY_STATUS_LABELS[apartment.occupancyStatus]} />
          {apartment.isCommercial ? <Badge label="Commercial" tone="attention" /> : null}
          {apartment.isBillable ? null : <Badge label="Not billed" tone="attention" />}
        </View>
      </View>
    </Card>
  );
}

/** A nullable measurement, or "Not recorded" — never `0` and never blank. */
function measured(value: number | null, format: (value: number) => string): string {
  return value === null ? 'Not recorded' : format(value);
}

function Badge({ label, tone }: { readonly label: string; readonly tone?: 'attention' }) {
  return (
    <View
      className={
        tone === 'attention'
          ? 'rounded-full bg-error-container px-3 py-1'
          : 'rounded-full bg-surface-variant px-3 py-1'
      }
    >
      <Text
        variant="labelSmall"
        color={tone === 'attention' ? 'onErrorContainer' : 'onSurfaceVariant'}
      >
        {label}
      </Text>
    </View>
  );
}
