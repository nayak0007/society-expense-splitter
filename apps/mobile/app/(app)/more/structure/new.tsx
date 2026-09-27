import { Stack, useRouter } from 'expo-router';
import { useForm } from 'react-hook-form';
import { ScrollView, View } from 'react-native';

import { RequirePermission } from '@/components/layout/RequirePermission';
import { Button } from '@/components/ui/Button';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';
import { BuildingFormFields } from '@/features/structure/components/BuildingFormFields';
import { useCreateBuilding } from '@/features/structure/hooks/use-building-actions';
import { useBuildings } from '@/features/structure/hooks/use-buildings';
import {
  buildingFormResolver,
  emptyBuildingForm,
  formFieldOfError,
  formValuesToCreatePayload,
} from '@/features/structure/schemas/building.schemas';
import type { BuildingFormValues } from '@/features/structure/schemas/building.schemas';
import { buildingErrorMessage } from '@/features/structure/services/building.service';

/**
 * Create building (PRD §5: society structure setup; admin-only).
 *
 * ## The gate is `canManage`, not a role
 *
 * `RequirePermission` is wired to the capability the domain evaluated, which is the
 * same capability the API's `PermissionGuard` reads from the same matrix. The check
 * exists to tell the user *why* they cannot proceed — a deep link, or a stale
 * membership — because the buttons that lead here are already hidden for anyone
 * without it. It is never the security boundary: the server refuses regardless
 * (SAD §5.5).
 *
 * ## Capabilities come from the list query
 *
 * A create screen has no building to read, and inventing a second endpoint for
 * "may I write structure here" would be a permission check with its own
 * implementation. The list query already carries `capabilities`, is already cached
 * from the screen that navigated here, and is the same answer either way.
 */
export default function BuildingCreateScreen() {
  const router = useRouter();
  const { capabilities, isLoading } = useBuildings();
  const createBuilding = useCreateBuilding();

  const { control, handleSubmit, formState, setError } = useForm<BuildingFormValues>({
    resolver: buildingFormResolver,
    defaultValues: emptyBuildingForm(),
  });

  if (isLoading) {
    return <LoadingIndicator message="Loading structure…" />;
  }

  const submit = handleSubmit(async (values) => {
    try {
      await createBuilding.mutateAsync(formValuesToCreatePayload(values));
      // Back to the list rather than to the new building: an edit screen is
      // addressed by an id this screen never learns (the server mints it), and the
      // list is where the user confirms the result.
      router.back();
    } catch (error: unknown) {
      const field = formFieldOfError(error);
      const message = buildingErrorMessage(error);
      if (field !== undefined) {
        setError(field, { message });
        return;
      }
      setError('root', { message });
    }
  });

  const rootError = formState.errors.root?.message;

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ title: 'Add building' }} />
      <RequirePermission action="structure.edit" authorized={capabilities?.canManage ?? true}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <View className="gap-6 p-lg">
            <Text variant="bodyMedium" color="onSurfaceVariant">
              A building is the first level of your society's structure. Wings and floors inside it
              are optional — a small building needs neither.
            </Text>

            <BuildingFormFields control={control} />

            {rootError !== undefined ? (
              <Text variant="bodyMedium" color="error">
                {rootError}
              </Text>
            ) : null}

            <Button
              variant="filled"
              size="lg"
              loading={createBuilding.isPending}
              onPress={() => void submit()}
            >
              Add building
            </Button>
            <Button variant="text" onPress={() => router.back()}>
              Cancel
            </Button>
          </View>
        </ScrollView>
      </RequirePermission>
    </View>
  );
}
