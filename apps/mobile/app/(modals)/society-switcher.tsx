import { Stack, useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { SocietyCard } from '@/features/society/components/SocietyCard';
import { useSociety } from '@/features/society/hooks/use-societies';
import { selectActiveSocietyId, selectMemberships, useSocietyStore } from '@/stores/society.store';

/**
 * Society switcher modal (PRD §3.1: "Multiple → Society Switcher, with the
 * last-used society remembered").
 *
 * Switching only changes `activeSocietyId`: every query key and the
 * `X-Society-Id` header derive from it, so nothing else needs invalidating.
 * Presented as a modal because switching is orthogonal to the current stack
 * (SAD §5.3).
 */
export default function SocietySwitcher() {
  const router = useRouter();
  const memberships = useSocietyStore(selectMemberships);
  const activeSocietyId = useSocietyStore(selectActiveSocietyId);
  const setActiveSocietyId = useSocietyStore((state) => state.setActiveSocietyId);

  const switchTo = (societyId: string) => {
    setActiveSocietyId(societyId as typeof activeSocietyId);
    router.back();
  };

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ presentation: 'modal', title: 'Your societies' }} />
      <ScrollView>
        <View className="gap-3 p-lg">
          {memberships.length === 0 ? (
            <EmptyState
              title="No societies yet"
              description="Create a society or join one with an invite code."
              actionLabel="Create a society"
              onAction={() => router.replace('/(setup)/society-create')}
            />
          ) : (
            memberships.map((membership) => (
              <SwitcherRow
                key={membership.id}
                societyId={membership.societyId}
                isActive={membership.societyId === activeSocietyId}
                onPress={() => switchTo(membership.societyId)}
              />
            ))
          )}

          <Button variant="tonal" onPress={() => router.replace('/(setup)/society-join')}>
            Join another society
          </Button>
          <Button variant="text" onPress={() => router.replace('/(setup)/society-create')}>
            Create a society
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}

function SwitcherRow({
  societyId,
  isActive,
  onPress,
}: {
  societyId: string;
  isActive: boolean;
  onPress: () => void;
}) {
  const { society, isLoading } = useSociety(societyId);
  const membership = useSocietyStore(selectMemberships).find(
    (item) => item.societyId === societyId,
  );

  if (society === null) {
    return <LoadingIndicator message={isLoading ? 'Loading societies…' : 'Unavailable'} />;
  }

  return (
    <SocietyCard
      name={society.name}
      city={society.city}
      type={society.type}
      role={membership?.role ?? 'resident'}
      status={membership?.status ?? 'active'}
      memberCount={society.memberCount}
      isActive={isActive}
      onPress={onPress}
    />
  );
}
