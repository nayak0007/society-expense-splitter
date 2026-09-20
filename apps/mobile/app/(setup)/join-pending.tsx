import { useQueryClient } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Text } from '@/components/ui/Text';
import { useSociety } from '@/features/society/hooks/use-societies';
import { societyKeys } from '@/features/society/hooks/society-keys';
import { selectMemberships, useSocietyStore } from '@/stores/society.store';

/**
 * Pending-approval state (SAD §5.2: `memberships.every(m => m.status ===
 * 'pending')` routes here).
 *
 * A pending member is not a member: they must not see expenses, dues or
 * member data until an Admin approves. Showing this screen instead of the app
 * is what makes "never auto-approve" visible to the user (PRD §3.2).
 */
export default function JoinPending() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const memberships = useSocietyStore(selectMemberships);
  const pending = memberships.filter((membership) => membership.status === 'pending');

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: societyKeys.all });
  };

  if (pending.length === 0) {
    return (
      <View className="flex-1 bg-surface">
        <Stack.Screen options={{ title: 'Awaiting approval' }} />
        <EmptyState
          title="Nothing pending"
          description="Your requests have been resolved. Continue into the app."
          actionLabel="Continue"
          onAction={() => router.replace('/(app)/home')}
        />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ title: 'Awaiting approval' }} />
      <ScrollView>
        <View className="gap-4 p-lg">
          <Text variant="headlineSmall">Awaiting approval</Text>
          <Text variant="bodyMedium" color="onSurfaceVariant">
            An Admin has to approve your request before you can see the society's expenses, dues and
            members.
          </Text>

          {pending.map((membership) => (
            <PendingSocietyRow key={membership.id} societyId={membership.societyId} />
          ))}

          <Button variant="tonal" onPress={refresh}>
            Check again
          </Button>
          <Button variant="text" onPress={() => router.push('/(setup)/society-choice')}>
            Join another society
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}

/** Reads the society detail so the pending list shows a real name, not an id. */
function PendingSocietyRow({ societyId }: { societyId: string }) {
  const { society, isLoading } = useSociety(societyId);

  return (
    <View className="rounded-card bg-surface-container-low p-4">
      <Text variant="titleSmall">{society?.name ?? (isLoading ? 'Loading…' : 'Society')}</Text>
      <Text variant="bodySmall" color="onSurfaceVariant">
        {society === null ? 'Request pending' : `Request pending · ${society.city}`}
      </Text>
    </View>
  );
}
