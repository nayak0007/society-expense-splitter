import type { MemberView } from '@ses/domain';
import { View } from 'react-native';

import { Card } from '@/components/ui/Card';
import { Text } from '@/components/ui/Text';

import { MEMBER_ROLE_LABELS, MEMBER_STATUS_LABELS } from '../schemas/member.schemas';

/**
 * Member directory row (PRD §3.3: "list with flat number, role badge, occupancy").
 *
 * One component for the list, so the vocabulary is identical everywhere — including its
 * absences:
 *
 *  - **No flat** renders as *"No flat recorded"* rather than a blank line. A shadow member
 *    added before the flats were set up is a real and common case, and an empty line reads as
 *    a rendering bug.
 *  - **Withheld contact** renders as *"Contact details not shared"*, not as an empty space.
 *    `phone: null` is ambiguous between "nobody recorded one" and "this member has not
 *    consented", and the domain answers which one it is (`contactVisible`); a row that showed
 *    them the same way would tell the user something false about their own society's data.
 *
 * The badges are text rather than colour alone, for the reason `ApartmentCard` records: the
 * status decides whether somebody may act at all, and a distinction that exists only as a
 * colour is invisible to a substantial fraction of users. A suspended row is marked as
 * *attention* — it is the state a manager is scanning for.
 */
export interface MemberCardProps {
  readonly member: MemberView;
  onPress?: (() => void) | undefined;
}

export function MemberCard({ member, onPress }: MemberCardProps) {
  const flat = member.apartment === null ? null : describeFlat(member);

  return (
    <Card variant="filled" onPress={onPress}>
      <View className="gap-2">
        <View className="flex-row items-center justify-between gap-2">
          <View className="flex-1">
            <Text variant="titleMedium" numberOfLines={1}>
              {member.displayName}
            </Text>
          </View>
          <Text variant="labelMedium" color="onSurfaceVariant">
            {MEMBER_ROLE_LABELS[member.role]}
          </Text>
        </View>

        <Text variant="bodySmall" color="onSurfaceVariant">
          {flat ?? 'No flat recorded'}
          {member.isPrimary ? ' · Primary occupant' : ''}
        </Text>

        <Text variant="bodySmall" color="onSurfaceVariant">
          {contactLine(member)}
        </Text>

        <View className="flex-row flex-wrap gap-2">
          <Badge
            label={MEMBER_STATUS_LABELS[member.status]}
            tone={member.status === 'active' ? 'neutral' : 'attention'}
          />
          {member.userId === null ? <Badge label="No app account" /> : null}
          {member.shareContact ? null : <Badge label="Contact private" />}
        </View>
      </View>
    </Card>
  );
}

/**
 * "Tower A · A-101" — the label the member joined server-side.
 *
 * `buildingName` is nullable because it is joined from a table that can lag (a building
 * removed by a repair): the flat number is the part a person recognises, so the building is
 * simply left out when it is unknown rather than rendering `null` as text.
 */
function describeFlat(member: MemberView): string {
  const apartment = member.apartment;
  if (apartment === null) return 'No flat recorded';
  return apartment.buildingName === null
    ? apartment.number
    : `${apartment.buildingName} · ${apartment.number}`;
}

/**
 * The phone, the email, or the reason neither is shown.
 *
 * `contactVisible === false` is the consent flag doing its job (PRD §3.3) — the caller is
 * looking at somebody else's row, and that somebody has not agreed to share. Saying so is the
 * whole point of the flag travelling with the row.
 */
function contactLine(member: MemberView): string {
  if (!member.contactVisible) return 'Contact details not shared';
  const parts = [member.phone, member.email].filter(
    (value): value is string => value !== null && value.length > 0,
  );
  return parts.length === 0 ? 'No contact details on file' : parts.join(' · ');
}

function Badge({
  label,
  tone,
}: {
  readonly label: string;
  readonly tone?: 'attention' | 'neutral';
}) {
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
