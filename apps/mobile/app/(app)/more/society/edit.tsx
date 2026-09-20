import { Stack, useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/Button';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { RequirePermission } from '@/components/layout/RequirePermission';
import { Text } from '@/components/ui/Text';
import { SocietyFormFields } from '@/features/society/components/SocietyFormFields';
import { useActiveSociety } from '@/features/society/hooks/use-societies';
import { useUpdateSociety } from '@/features/society/hooks/use-society-actions';
import {
  emptySocietyForm,
  formValuesToUpdatePayload,
  societyFormResolver,
  societyToFormValues,
} from '@/features/society/schemas/society.schemas';
import type { SocietyFormValues } from '@/features/society/schemas/society.schemas';
import { societyErrorMessage } from '@/features/society/services/society.service';

/**
 * Edit society (PRD §2: only an Admin may change society details — the
 * Treasurer explicitly cannot change society structure).
 *
 * The guard is the route-level `RequirePermission` (SAD §5.5 layer 2) wired to
 * a *real* role evaluation now that memberships carry roles. The repository
 * enforces the same rule again; the UI check exists so the user is told why,
 * never as the security boundary.
 */
export default function SocietyEdit() {
  const router = useRouter();
  const { society, membership, isLoading } = useActiveSociety();
  const updateSociety = useUpdateSociety(society?.id ?? '');

  const { control, handleSubmit, formState, setError } = useForm<SocietyFormValues>({
    resolver: societyFormResolver,
    // `values` (not defaultValues) so the form fills in once the fetch lands.
    values: society === null ? emptySocietyForm() : societyToFormValues(society),
  });

  if (isLoading) {
    return <LoadingIndicator message="Loading society…" />;
  }

  const submit = handleSubmit(async (values) => {
    try {
      await updateSociety.mutateAsync(formValuesToUpdatePayload(values));
      router.back();
    } catch (error: unknown) {
      setError('root', { message: societyErrorMessage(error) });
    }
  });

  const rootError = formState.errors.root?.message;

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ title: 'Edit society' }} />
      <RequirePermission action="society.update" authorized={membership?.role === 'admin'}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <View className="gap-6 p-lg">
            <SocietyFormFields control={control} errors={formState.errors} />

            {rootError !== undefined ? (
              <Text variant="bodyMedium" color="error">
                {rootError}
              </Text>
            ) : null}

            <Button
              variant="filled"
              size="lg"
              loading={updateSociety.isPending}
              onPress={() => void submit()}
            >
              Save changes
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
