import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { RequirePermission } from '@/components/layout/RequirePermission';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorScreen } from '@/components/ui/ErrorScreen';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';
import { BuildingCard } from '@/features/structure/components/BuildingCard';
import { useBuildings } from '@/features/structure/hooks/use-buildings';
import { buildingErrorMessage } from '@/features/structure/services/building.service';

/**
 * Buildings list (PRD §5: `Society → Building → Wing → Floor → Apartment`).
 *
 * ## Read from the query, decide from the capabilities
 *
 * The screen never looks at a role. `capabilities.canManage` — evaluated in the
 * domain against the same matrix `PermissionGuard` and the RLS policies use —
 * decides whether the add affordance and each row's edit action exist at all
 * (SAD §9.3: a disabled button and a rejected request must not be able to
 * disagree). A Guest, whose role holds no `structure.view`, is stopped by
 * `RequirePermission` before the list renders rather than by a failed request.
 *
 * ## Three states, and the empty one is not an error
 *
 * A society that has just been created genuinely has no buildings, so an empty
 * array renders "add your first building" — the screen that fixes it — instead of a
 * failure. That is deliberate and is what makes the structure step of onboarding
 * work at all.
 */
export default function BuildingsScreen() {
  const router = useRouter();
  const { buildings, capabilities, isLoading, isRefreshing, error, refetch } = useBuildings();

  if (isLoading) {
    return <LoadingIndicator message="Loading buildings…" />;
  }

  // Only when there is nothing to show: a failed *refetch* over cached rows keeps
  // the rows on screen, because stale structure is more useful than an error page.
  if (error != null && buildings.length === 0) {
    return (
      <ErrorScreen
        title="Could not load buildings"
        description={buildingErrorMessage(error)}
        onRetry={refetch}
      />
    );
  }

  const canManage = capabilities?.canManage === true;
  // Read separately from `canManage`, because the two are different grants: a
  // resident may view the structure without being allowed to change it.
  const canView = capabilities?.canView === true;
  // Built conditionally rather than passed as `undefined`: `EmptyState`'s props are
  // optional-but-not-undefined under `exactOptionalPropertyTypes`, and a spread is
  // how an absent action stays absent instead of becoming an empty button.
  const emptyAction = canManage
    ? {
        actionLabel: 'Add building',
        onAction: () => router.push('/(app)/more/structure/new'),
      }
    : {};

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ title: 'Buildings' }} />
      <RequirePermission action="structure.view" authorized={capabilities?.canView ?? true}>
        <ScrollView>
          <View className="gap-3 p-lg">
            {buildings.length === 0 ? (
              <EmptyState
                icon={<Ionicons name="business-outline" size={48} />}
                title="No buildings yet"
                description="Buildings are how flats are grouped. Add the first one to start setting up your society's structure."
                {...emptyAction}
              />
            ) : (
              <>
                <Text variant="bodySmall" color="onSurfaceVariant">
                  {canManage
                    ? 'Listed in display order. Tap a building to edit it, or open it to see its flats.'
                    : 'Listed in display order. Tap a building to see its flats.'}
                </Text>

                {buildings.map((building) => (
                  <BuildingCard
                    key={building.id}
                    name={building.name}
                    totalFloors={building.totalFloors}
                    onPress={
                      // Which screen a tap opens is the caller's capability, and the
                      // reason is not cosmetic: the edit screen is `structure.edit`
                      // and would render a denial, while a resident or tenant may
                      // read the structure and has every reason to look at the flats
                      // inside a building. Managers keep the direct edit path they
                      // had in T042 and reach the flats from that screen; everyone
                      // else — and anyone who follows a deep link — lands on the
                      // flats, which is the level this feature is about.
                      canManage
                        ? () =>
                            router.push({
                              pathname: '/(app)/more/structure/[buildingId]/edit',
                              params: { buildingId: building.id },
                            })
                        : canView
                          ? () =>
                              router.push({
                                pathname: '/(app)/more/structure/[buildingId]',
                                params: { buildingId: building.id },
                              })
                          : undefined
                    }
                  />
                ))}

                {canManage ? (
                  <View className="mt-2">
                    <Button
                      variant="tonal"
                      onPress={() => router.push('/(app)/more/structure/new')}
                    >
                      Add building
                    </Button>
                  </View>
                ) : null}
              </>
            )}

            {isRefreshing ? (
              <Text variant="bodySmall" color="outline" align="center">
                Refreshing…
              </Text>
            ) : null}
          </View>
        </ScrollView>
      </RequirePermission>
    </View>
  );
}
