import type { MemberRole, MembershipStatus, SocietyType } from '@ses/domain';
import { View } from 'react-native';

import { Card } from '@/components/ui/Card';
import { Text } from '@/components/ui/Text';

import { MEMBERSHIP_STATUS_LABELS, ROLE_LABELS, SOCIETY_TYPE_LABELS } from '../labels';

/**
 * Society summary card — used by the switcher and the profile screen. One
 * component for both keeps the role/status vocabulary identical everywhere
 * (PRD §2: roles are always named the same way to the user).
 */
export interface SocietyCardProps {
  readonly name: string;
  readonly city: string;
  readonly type: SocietyType;
  readonly role: MemberRole;
  readonly status: MembershipStatus;
  readonly memberCount: number;
  /** Marks the society the session is currently scoped to. */
  readonly isActive?: boolean;
  onPress?: (() => void) | undefined;
}

export function SocietyCard({
  name,
  city,
  type,
  role,
  status,
  memberCount,
  isActive = false,
  onPress,
}: SocietyCardProps) {
  return (
    <Card variant={isActive ? 'outlined' : 'filled'} onPress={onPress}>
      <View className="gap-1">
        <View className="flex-row items-center justify-between gap-2">
          <Text variant="titleMedium" numberOfLines={1}>
            {name}
          </Text>
          {isActive ? (
            <Text variant="labelSmall" color="primary">
              Current
            </Text>
          ) : null}
        </View>
        <Text variant="bodySmall" color="onSurfaceVariant">
          {SOCIETY_TYPE_LABELS[type]} · {city} · {memberCount}{' '}
          {memberCount === 1 ? 'member' : 'members'}
        </Text>
        <Text variant="labelMedium" color="onSurfaceVariant">
          {ROLE_LABELS[role]} · {MEMBERSHIP_STATUS_LABELS[status]}
        </Text>
      </View>
    </Card>
  );
}
