import { Stack, useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { ErrorScreen } from '@/components/ui/ErrorScreen';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Text } from '@/components/ui/Text';
import { JoinCodeCard } from '@/features/society/components/JoinCodeCard';
import { useActiveSociety } from '@/features/society/hooks/use-societies';
import { useRegenerateJoinCode } from '@/features/society/hooks/use-society-actions';
import {
  MEMBERSHIP_STATUS_LABELS,
  ROLE_LABELS,
  SOCIETY_TYPE_LABELS,
} from '@/features/society/labels';
import { selectMemberships, useSocietyStore } from '@/stores/society.store';

/**
 * Society profile (PRD §3.2 view + the Update/Delete/Leave entry points).
 *
 * Reads the *active* society from the session store, so it needs no route
 * param and always matches the tenant every other screen is scoped to.
 * Mutating actions live in the danger modal, keeping destructive operations
 * behind one explicit confirmation surface.
 */
export default function SocietyProfile() {
  const router = useRouter();
  const { society, membership, isLoading, error, refetch } = useActiveSociety();
  const regenerate = useRegenerateJoinCode(society?.id ?? '');
  const membershipCount = useSocietyStore(selectMemberships).length;

  if (isLoading) {
    return <LoadingIndicator message="Loading society…" />;
  }

  if (society === null) {
    return (
      <View className="flex-1 bg-surface">
        <Stack.Screen options={{ title: 'Society' }} />
        <ErrorScreen
          title={error !== null ? 'Could not load this society' : 'No society selected'}
          description={
            error !== null
              ? 'Check your connection and try again.'
              : 'Switch to a society, or create one, to see its profile.'
          }
          onRetry={error !== null ? refetch : undefined}
        />
      </View>
    );
  }

  const isAdmin = membership?.role === 'admin';
  const address = [society.addressLine1, society.addressLine2, society.city, society.state]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(', ');

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ title: society.name }} />
      <ScrollView>
        <View className="gap-4 p-lg">
          <View className="gap-1">
            <Text variant="headlineSmall">{society.name}</Text>
            <Text variant="bodyMedium" color="onSurfaceVariant">
              {SOCIETY_TYPE_LABELS[society.type]} · {society.memberCount}{' '}
              {society.memberCount === 1 ? 'member' : 'members'}
            </Text>
            {membership !== null ? (
              <Text variant="labelMedium" color="onSurfaceVariant">
                Your role: {ROLE_LABELS[membership.role]} ·{' '}
                {MEMBERSHIP_STATUS_LABELS[membership.status]}
              </Text>
            ) : null}
          </View>

          <JoinCodeCard
            societyName={society.name}
            joinCode={society.joinCode}
            canManage={isAdmin}
            isRegenerating={regenerate.isPending}
            onRegenerate={() => regenerate.mutate()}
          />
          {regenerate.isError ? (
            <Text variant="bodySmall" color="error">
              Only an Admin can regenerate the join code.
            </Text>
          ) : null}

          <Card variant="outlined">
            <View className="gap-2">
              <Text variant="titleSmall">Details</Text>
              <DetailRow label="Address" value={address.length > 0 ? address : 'Not set'} />
              <DetailRow label="PIN code" value={society.pincode ?? 'Not set'} />
              <DetailRow label="Registration no." value={society.registrationNumber ?? 'Not set'} />
              <DetailRow label="Plan" value={society.plan} />
            </View>
          </Card>

          <Card variant="outlined">
            <View className="gap-2">
              <Text variant="titleSmall">Financial defaults</Text>
              <DetailRow
                label="Billing day"
                value={`${society.settings.billingDay} of the month`}
              />
              <DetailRow label="Due day" value={`${society.settings.dueDay} of the month`} />
              <DetailRow
                label="Approval threshold"
                value={formatRupees(society.settings.approvalThresholdPaise)}
              />
              <DetailRow label="Currency" value={society.currency} />
            </View>
          </Card>

          <Button variant="tonal" onPress={() => router.push('/(app)/more/society/edit')}>
            Edit society details
          </Button>
          <Button variant="outlined" onPress={() => router.push('/(modals)/society-switcher')}>
            {membershipCount > 1 ? 'Switch society' : 'Add another society'}
          </Button>
          <Button
            variant="text"
            onPress={() =>
              router.push({
                pathname: '/(modals)/society-danger',
                params: { societyId: society.id, intent: 'leave' },
              })
            }
          >
            Leave society
          </Button>
          {isAdmin ? (
            <Button
              variant="text"
              onPress={() =>
                router.push({
                  pathname: '/(modals)/society-danger',
                  params: { societyId: society.id, intent: 'delete' },
                })
              }
            >
              Delete society
            </Button>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-start justify-between gap-4">
      <Text variant="bodyMedium" color="onSurfaceVariant">
        {label}
      </Text>
      <View className="flex-1">
        <Text variant="bodyMedium" align="right">
          {value}
        </Text>
      </View>
    </View>
  );
}

/** Paise → ₹ display (PRD §18: money is stored in paise, rendered in ₹). */
function formatRupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
}
