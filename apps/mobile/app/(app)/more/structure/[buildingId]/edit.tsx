import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ScrollView, View } from 'react-native';

import { RequirePermission } from '@/components/layout/RequirePermission';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ErrorScreen } from '@/components/ui/ErrorScreen';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';
import { BuildingFormFields } from '@/features/structure/components/BuildingFormFields';
import {
  useDeleteBuilding,
  useUpdateBuilding,
} from '@/features/structure/hooks/use-building-actions';
import { useBuilding } from '@/features/structure/hooks/use-buildings';
import {
  buildingFormResolver,
  buildingToFormValues,
  emptyBuildingForm,
  formFieldOfError,
  formValuesToUpdatePayload,
} from '@/features/structure/schemas/building.schemas';
import type { BuildingFormValues } from '@/features/structure/schemas/building.schemas';
import { buildingErrorMessage } from '@/features/structure/services/building.service';

/**
 * Edit building, and delete it (PRD §5: admin-only writes with a soft delete).
 *
 * ## One screen for both, because the delete is a mode of the edit
 *
 * The destructive action is presented *inside* the thing it destroys rather than as
 * a separate modal route: the user is already looking at the building, its name is
 * on screen, and a second screen would be a second place to keep the confirmation
 * copy in step. Society deletion is a modal because it destroys a **tenant** — the
 * session, the routing and every cached query change with it — and the user is
 * navigated elsewhere. Deleting a building changes none of that.
 *
 * ## Nothing here decides who may write
 *
 * `RequirePermission` renders in place of the form for a caller without
 * `structure.edit`, and the delete control is only offered with `canManage`. Both
 * read the domain's evaluated capabilities, and both are *explanations*: the API's
 * `PermissionGuard` and the RLS policies refuse the same operations underneath
 * whatever this screen renders (SAD §5.5, §9.3).
 */
export default function BuildingEditScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ buildingId?: string }>();
  const buildingId = params.buildingId ?? null;

  const { building, capabilities, isLoading, error, refetch } = useBuilding(buildingId);
  const updateBuilding = useUpdateBuilding(buildingId);
  const deleteBuilding = useDeleteBuilding(buildingId);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  const { control, handleSubmit, formState, setError } = useForm<BuildingFormValues>({
    resolver: buildingFormResolver,
    // `values` (not `defaultValues`) so the form fills in once the fetch lands.
    values: building === null ? emptyBuildingForm() : buildingToFormValues(building),
  });

  if (isLoading) {
    return <LoadingIndicator message="Loading building…" />;
  }

  if (building === null) {
    return (
      <ErrorScreen
        title="Building not available"
        description={
          error != null
            ? buildingErrorMessage(error)
            : 'This building may have been removed. Check the list for the current structure.'
        }
        retryLabel="Reload"
        onRetry={refetch}
      />
    );
  }

  const submit = handleSubmit(async (values) => {
    try {
      await updateBuilding.mutateAsync(formValuesToUpdatePayload(values));
      router.back();
    } catch (caught: unknown) {
      const field = formFieldOfError(caught);
      const message = buildingErrorMessage(caught);
      if (field !== undefined) {
        setError(field, { message });
        return;
      }
      setError('root', { message });
    }
  });

  const remove = async () => {
    try {
      await deleteBuilding.mutateAsync();
      router.back();
    } catch (caught: unknown) {
      setError('root', { message: buildingErrorMessage(caught) });
      setIsConfirmingDelete(false);
    }
  };

  const rootError = formState.errors.root?.message;
  const canManage = capabilities?.canManage === true;

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ title: building.name }} />
      <RequirePermission action="structure.edit" authorized={capabilities?.canManage ?? true}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <View className="gap-6 p-lg">
            {/*
              The way into a building's flats. It sits above the form because it is
              navigation rather than an edit: a manager who came here to look at what
              is inside the building should not have to scroll past three fields to
              find it. The flats screen is `structure.view`, which every role but a
              Guest holds, so this is offered unconditionally.
            */}
            <Card variant="outlined">
              <View className="gap-3">
                <Text variant="titleSmall">Flats</Text>
                <Text variant="bodySmall" color="onSurfaceVariant">
                  The flats inside this building, and what they are billed as. They are listed by
                  floor, then flat number.
                </Text>
                <Button
                  variant="outlined"
                  onPress={() =>
                    router.push({
                      pathname: '/(app)/more/structure/[buildingId]',
                      params: { buildingId: building.id },
                    })
                  }
                >
                  View flats
                </Button>
              </View>
            </Card>

            <BuildingFormFields control={control} />

            {rootError !== undefined ? (
              <Text variant="bodyMedium" color="error">
                {rootError}
              </Text>
            ) : null}

            <Button
              variant="filled"
              size="lg"
              loading={updateBuilding.isPending}
              onPress={() => void submit()}
            >
              Save changes
            </Button>
            <Button variant="text" onPress={() => router.back()}>
              Cancel
            </Button>

            {canManage ? (
              <Card variant="outlined">
                <View className="gap-3">
                  <Text variant="titleSmall" color="error">
                    Delete building
                  </Text>
                  <Text variant="bodySmall" color="onSurfaceVariant">
                    It disappears from every list and cannot be edited again. Flats and financial
                    history that point at it are kept, so nothing already recorded is lost.
                  </Text>

                  {isConfirmingDelete ? (
                    <View className="gap-2">
                      <Button
                        variant="filled"
                        loading={deleteBuilding.isPending}
                        onPress={() => void remove()}
                      >
                        {`Delete "${building.name}"`}
                      </Button>
                      <Button variant="text" onPress={() => setIsConfirmingDelete(false)}>
                        Keep it
                      </Button>
                    </View>
                  ) : (
                    <Button variant="outlined" onPress={() => setIsConfirmingDelete(true)}>
                      Delete building…
                    </Button>
                  )}
                </View>
              </Card>
            ) : null}
          </View>
        </ScrollView>
      </RequirePermission>
    </View>
  );
}
