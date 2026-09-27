import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';

import { RequirePermission } from '@/components/layout/RequirePermission';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorScreen } from '@/components/ui/ErrorScreen';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';
import { ApartmentCard } from '@/features/structure/components/ApartmentCard';
import { useApartments } from '@/features/structure/hooks/use-apartments';
import { useBuilding } from '@/features/structure/hooks/use-buildings';
import { apartmentErrorMessage } from '@/features/structure/services/apartment.service';
import { buildingErrorMessage } from '@/features/structure/services/building.service';

/**
 * Flats of one building (PRD §2 screen 73, §5: `Building → Wing → Floor →
 * Apartment`).
 *
 * ## Read from the query, decide from the capabilities
 *
 * The screen never looks at a role. `capabilities.canManage` — evaluated in the
 * domain against the same matrix `PermissionGuard` and the RLS policies use —
 * decides whether the add affordance and each row's edit action exist at all. A
 * Guest, whose role holds no `structure.view`, is stopped by `RequirePermission`
 * before the list renders rather than by a failed request.
 *
 * ## Two queries, and why the building is read as well
 *
 * The list answers "what is in this building"; the building answers "which building
 * am I in" — its name is the header, and without it the screen would show a list of
 * flat numbers with no statement of where they are. It is the *same* cached read the
 * building edit screen performed on the way here, so in the ordinary flow it is not
 * a second request at all.
 *
 * ## Three states, and the empty one is not an error
 *
 * A building that was just created genuinely has no flats, so an empty array renders
 * "add your first flat" — the screen that fixes it — rather than a failure. That is
 * what makes the structure step of onboarding work: the society is set up building
 * by building, and each one starts empty on purpose.
 */
export default function BuildingApartmentsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ buildingId?: string }>();
  const buildingId = params.buildingId ?? null;

  const buildingResult = useBuilding(buildingId);
  const { apartments, capabilities, isLoading, isRefreshing, error, refetch } =
    useApartments(buildingId);

  if (isLoading || buildingResult.isLoading) {
    return <LoadingIndicator message="Loading flats…" />;
  }

  // The building is the screen's subject: a list of flats whose building is unknown
  // (removed, or in another society) is not a list worth rendering.
  if (buildingResult.building === null) {
    return (
      <ErrorScreen
        title="Building not available"
        description={
          buildingResult.error != null
            ? buildingErrorMessage(buildingResult.error)
            : 'This building may have been removed. Check the list for the current structure.'
        }
        retryLabel="Reload"
        onRetry={buildingResult.refetch}
      />
    );
  }

  const building = buildingResult.building;

  // Only when there is nothing to show: a failed *refetch* over cached rows keeps
  // the rows on screen, because stale structure is more useful than an error page.
  if (error != null && apartments.length === 0) {
    return (
      <ErrorScreen
        title="Could not load flats"
        description={apartmentErrorMessage(error)}
        onRetry={refetch}
      />
    );
  }

  const canManage = capabilities?.canManage === true;
  const addFlat = () =>
    router.push({
      pathname: '/(app)/more/structure/[buildingId]/new',
      params: { buildingId: building.id },
    });

  // Built conditionally rather than passed as `undefined`: `EmptyState`'s props are
  // optional-but-not-undefined under `exactOptionalPropertyTypes`, and a spread is
  // how an absent action stays absent instead of becoming an empty button.
  const emptyAction = canManage ? { actionLabel: 'Add flat', onAction: addFlat } : {};

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ title: building.name }} />
      <RequirePermission action="structure.view" authorized={capabilities?.canView ?? true}>
        <ScrollView>
          <View className="gap-3 p-lg">
            {apartments.length === 0 ? (
              <EmptyState
                icon={<Ionicons name="home-outline" size={48} />}
                title="No flats yet"
                description={`A flat is the level residents, dues and meter readings attach to. Add the first one to ${building.name}.`}
                {...emptyAction}
              />
            ) : (
              <>
                <Text variant="bodySmall" color="onSurfaceVariant">
                  Listed by floor, then flat number. Tap a flat to edit it.
                </Text>

                {apartments.map((apartment) => (
                  <ApartmentCard
                    key={apartment.id}
                    apartment={apartment}
                    onPress={
                      canManage
                        ? () =>
                            router.push({
                              pathname: '/(app)/more/structure/[buildingId]/[apartmentId]/edit',
                              params: {
                                buildingId: building.id,
                                apartmentId: apartment.id,
                              },
                            })
                        : undefined
                    }
                  />
                ))}

                {canManage ? (
                  <View className="mt-2">
                    <Button variant="tonal" onPress={addFlat}>
                      Add flat
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
