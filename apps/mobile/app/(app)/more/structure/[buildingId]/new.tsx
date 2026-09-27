import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useForm } from 'react-hook-form';
import { ScrollView, View } from 'react-native';

import { RequirePermission } from '@/components/layout/RequirePermission';
import { Button } from '@/components/ui/Button';
import { ErrorScreen } from '@/components/ui/ErrorScreen';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';
import { ApartmentFormFields } from '@/features/structure/components/ApartmentFormFields';
import { useCreateApartment } from '@/features/structure/hooks/use-apartment-actions';
import { useApartments } from '@/features/structure/hooks/use-apartments';
import { useBuilding } from '@/features/structure/hooks/use-buildings';
import {
  apartmentFormResolver,
  emptyApartmentForm,
  formFieldOfError,
  formValuesToCreatePayload,
} from '@/features/structure/schemas/apartment.schemas';
import type { ApartmentFormValues } from '@/features/structure/schemas/apartment.schemas';
import { apartmentErrorMessage } from '@/features/structure/services/apartment.service';
import { buildingErrorMessage } from '@/features/structure/services/building.service';

/**
 * Create a flat in one building (PRD §5; admin-only).
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
 * ## Capabilities come from the flat list, which is already cached
 *
 * This screen is reached from the building's list, so its query is warm and carries
 * `capabilities` — inventing a second endpoint for "may I write structure here"
 * would be a permission check with its own implementation. The building read is
 * made as well, only for the title: a flat is created *inside* something, and the
 * form should say which building.
 */
export default function ApartmentCreateScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ buildingId?: string }>();
  const buildingId = params.buildingId ?? null;

  const { capabilities, isLoading } = useApartments(buildingId);
  const buildingResult = useBuilding(buildingId);
  const createApartment = useCreateApartment(buildingId);

  const { control, handleSubmit, formState, setError } = useForm<ApartmentFormValues>({
    resolver: apartmentFormResolver,
    defaultValues: emptyApartmentForm(),
  });

  if (isLoading || buildingResult.isLoading) {
    return <LoadingIndicator message="Loading structure…" />;
  }

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

  const buildingName = buildingResult.building.name;

  const submit = handleSubmit(async (values) => {
    try {
      await createApartment.mutateAsync(formValuesToCreatePayload(values));
      // Back to the list rather than to the new flat: an edit screen is addressed by
      // an id this screen never learns (the server mints it), and the list is where
      // the user confirms the result.
      router.back();
    } catch (error: unknown) {
      const field = formFieldOfError(error);
      const message = apartmentErrorMessage(error);
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
      <Stack.Screen options={{ title: 'Add flat' }} />
      <RequirePermission action="structure.edit" authorized={capabilities?.canManage ?? true}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <View className="gap-6 p-lg">
            <Text variant="bodyMedium" color="onSurfaceVariant">
              {`A flat in ${buildingName}. Only the number is required — areas, configuration and parking can be filled in later, and every measurement can be cleared again.`}
            </Text>

            <ApartmentFormFields control={control} errors={formState.errors} />

            {rootError !== undefined ? (
              <Text variant="bodyMedium" color="error">
                {rootError}
              </Text>
            ) : null}

            <Button
              variant="filled"
              size="lg"
              loading={createApartment.isPending}
              onPress={() => void submit()}
            >
              Add flat
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
