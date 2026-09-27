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
import { ApartmentFormFields } from '@/features/structure/components/ApartmentFormFields';
import {
  useDeleteApartment,
  useUpdateApartment,
} from '@/features/structure/hooks/use-apartment-actions';
import { useApartment } from '@/features/structure/hooks/use-apartments';
import {
  apartmentFormResolver,
  apartmentToFormValues,
  emptyApartmentForm,
  formFieldOfError,
  formValuesToUpdatePayload,
} from '@/features/structure/schemas/apartment.schemas';
import type { ApartmentFormValues } from '@/features/structure/schemas/apartment.schemas';
import { apartmentErrorMessage } from '@/features/structure/services/apartment.service';

/**
 * Edit a flat, and delete it (PRD §5: admin-only writes with a soft delete).
 *
 * ## One screen for both, because the delete is a mode of the edit
 *
 * The destructive action is presented *inside* the thing it destroys rather than as
 * a separate modal route, for the reason the building edit screen records: the user
 * is already looking at the flat, its number is on screen, and a second screen would
 * be a second place to keep the confirmation copy in step.
 *
 * ## Emptying a field is how a measurement is retracted
 *
 * This is the one behaviour that differs from the building form, and it is worth
 * stating on the screen: clearing the carpet area sends `null` — "we no longer claim
 * to know" — rather than leaving the stored number in place. That is why the form's
 * mapper distinguishes an empty field on create (omit) from an empty field on edit
 * (clear); without it, the only way to retract a wrong area would be to delete the
 * flat, which would take its members and history with it.
 *
 * ## Nothing here decides who may write
 *
 * `RequirePermission` renders in place of the form for a caller without
 * `structure.edit`, and the delete control is only offered with `canManage`. Both
 * read the domain's evaluated capabilities, and both are *explanations*: the API's
 * `PermissionGuard` and the RLS policies refuse the same operations underneath
 * whatever this screen renders (SAD §5.5, §9.3).
 */
export default function ApartmentEditScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ buildingId?: string; apartmentId?: string }>();
  const apartmentId = params.apartmentId ?? null;

  const { apartment, capabilities, isLoading, error, refetch } = useApartment(apartmentId);
  const updateApartment = useUpdateApartment(apartmentId);
  const deleteApartment = useDeleteApartment(apartmentId);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);

  const { control, handleSubmit, formState, setError } = useForm<ApartmentFormValues>({
    resolver: apartmentFormResolver,
    // `values` (not `defaultValues`) so the form fills in once the fetch lands.
    values: apartment === null ? emptyApartmentForm() : apartmentToFormValues(apartment),
  });

  if (isLoading) {
    return <LoadingIndicator message="Loading flat…" />;
  }

  if (apartment === null) {
    return (
      <ErrorScreen
        title="Flat not available"
        description={
          error != null
            ? apartmentErrorMessage(error)
            : 'This flat may have been removed. Check the building for the current structure.'
        }
        retryLabel="Reload"
        onRetry={refetch}
      />
    );
  }

  const submit = handleSubmit(async (values) => {
    try {
      await updateApartment.mutateAsync(formValuesToUpdatePayload(values));
      router.back();
    } catch (caught: unknown) {
      const field = formFieldOfError(caught);
      const message = apartmentErrorMessage(caught);
      if (field !== undefined) {
        setError(field, { message });
        return;
      }
      setError('root', { message });
    }
  });

  const remove = async () => {
    try {
      await deleteApartment.mutateAsync();
      router.back();
    } catch (caught: unknown) {
      setError('root', { message: apartmentErrorMessage(caught) });
      setIsConfirmingDelete(false);
    }
  };

  const rootError = formState.errors.root?.message;
  const canManage = capabilities?.canManage === true;

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ title: apartment.apartmentNumber }} />
      <RequirePermission action="structure.edit" authorized={capabilities?.canManage ?? true}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <View className="gap-6 p-lg">
            <ApartmentFormFields control={control} errors={formState.errors} />

            {rootError !== undefined ? (
              <Text variant="bodyMedium" color="error">
                {rootError}
              </Text>
            ) : null}

            <Button
              variant="filled"
              size="lg"
              loading={updateApartment.isPending}
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
                    Delete flat
                  </Text>
                  <Text variant="bodySmall" color="onSurfaceVariant">
                    It disappears from every list and cannot be edited again. Dues and meter
                    readings that point at it are kept, so nothing already recorded is lost.
                  </Text>

                  {isConfirmingDelete ? (
                    <View className="gap-2">
                      <Button
                        variant="filled"
                        loading={deleteApartment.isPending}
                        onPress={() => void remove()}
                      >
                        {`Delete "${apartment.apartmentNumber}"`}
                      </Button>
                      <Button variant="text" onPress={() => setIsConfirmingDelete(false)}>
                        Keep it
                      </Button>
                    </View>
                  ) : (
                    <Button variant="outlined" onPress={() => setIsConfirmingDelete(true)}>
                      Delete flat…
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
