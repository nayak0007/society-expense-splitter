import { Stack, useRouter } from 'expo-router';
import { ScrollView, View } from 'react-native';
import { useForm } from 'react-hook-form';

import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { SocietyFormFields } from '@/features/society/components/SocietyFormFields';
import { useCreateSociety } from '@/features/society/hooks/use-society-actions';
import {
  emptySocietyForm,
  formValuesToCreatePayload,
  societyFormResolver,
} from '@/features/society/schemas/society.schemas';
import type { SocietyFormValues } from '@/features/society/schemas/society.schemas';
import { societyErrorMessage } from '@/features/society/services/society.service';

/**
 * Create society (PRD §3.2, step 1 basics + step 3 financial defaults).
 *
 * Scope note: the PRD's wizard has four steps — structure (buildings, wings,
 * floors, flats) and bulk invite belong to the structure and members modules
 * (T042–T053) and are deliberately not implemented here. This screen creates
 * the society and its seeded `society_settings` row, which is everything the
 * remaining steps depend on.
 */
export default function SocietyCreate() {
  const router = useRouter();
  const createSociety = useCreateSociety();
  const { control, handleSubmit, formState, setError } = useForm<SocietyFormValues>({
    resolver: societyFormResolver,
    defaultValues: emptySocietyForm(),
  });

  const submit = handleSubmit(async (values) => {
    try {
      await createSociety.mutateAsync(formValuesToCreatePayload(values));
      // The creator becomes Admin — land on the profile where the join code
      // and the invite action live (PRD §3.2 step 4).
      router.replace('/(app)/more/society');
    } catch (error: unknown) {
      setError('root', { message: societyErrorMessage(error) });
    }
  });

  const rootError = formState.errors.root?.message;

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ title: 'Create society' }} />
      <ScrollView keyboardShouldPersistTaps="handled">
        <View className="gap-6 p-lg">
          <View className="gap-2">
            <Text variant="headlineSmall">Create your society</Text>
            <Text variant="bodyMedium" color="onSurfaceVariant">
              You will be its Society Admin. Buildings, flats and members come next; this step sets
              up the society and the financial defaults its bills will use.
            </Text>
          </View>

          <SocietyFormFields control={control} errors={formState.errors} />

          {rootError !== undefined ? (
            <Text variant="bodyMedium" color="error">
              {rootError}
            </Text>
          ) : null}

          <Button
            variant="filled"
            size="lg"
            loading={createSociety.isPending}
            onPress={() => void submit()}
          >
            Create society
          </Button>
          <Button variant="text" onPress={() => router.back()}>
            Cancel
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}
