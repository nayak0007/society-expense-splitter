import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';
import { useSociety } from '@/features/society/hooks/use-societies';
import { useDeleteSociety, useLeaveSociety } from '@/features/society/hooks/use-society-actions';
import {
  deleteConfirmSchema,
  type DeleteConfirmValues,
} from '@/features/society/schemas/society.schemas';
import { societyErrorMessage } from '@/features/society/services/society.service';
import { sesResolver } from '@/lib/forms/resolver';
import { useSocietyStore } from '@/stores/society.store';

/**
 * Destructive society actions — leave and delete — behind one explicit
 * confirmation surface (PRD §2: destructive operations are deliberate;
 * deleting a tenant requires the society name typed out).
 *
 * The business rules are NOT re-implemented here: "only an Admin may delete"
 * and "a society can never be left without an active admin" are enforced by
 * the domain rule inside the repository, and its message is what the user
 * sees (SAD §1.1: the server is the only real enforcement layer).
 */
export default function SocietyDanger() {
  const router = useRouter();
  const params = useLocalSearchParams<{ societyId?: string; intent?: string }>();
  const societyId = params.societyId ?? '';
  const intent = params.intent === 'delete' ? 'delete' : 'leave';

  const { society, isLoading } = useSociety(societyId === '' ? null : societyId);
  const removeSociety = useDeleteSociety(societyId);
  const leaveSociety = useLeaveSociety(societyId);
  const [requestError, setRequestError] = useState<string | null>(null);

  const confirmForm = useForm<DeleteConfirmValues>({
    resolver: sesResolver(deleteConfirmSchema(society?.name ?? '')),
    defaultValues: { confirmation: '' },
  });

  const isDeleting = intent === 'delete';
  const isPending = isDeleting ? removeSociety.isPending : leaveSociety.isPending;

  const onFinished = () => {
    const stillAMember = useSocietyStore
      .getState()
      .memberships.some((membership) => membership.societyId !== societyId);
    router.replace(stillAMember ? '/(app)/home' : '/(setup)/society-choice');
  };

  const run = async () => {
    setRequestError(null);
    try {
      if (isDeleting) {
        await removeSociety.mutateAsync();
      } else {
        await leaveSociety.mutateAsync();
      }
      onFinished();
    } catch (error: unknown) {
      setRequestError(societyErrorMessage(error));
    }
  };

  const submitDelete = confirmForm.handleSubmit(run);
  const deleteError = confirmForm.formState.errors.confirmation?.message;

  if (isLoading) {
    return <LoadingIndicator message="Loading society…" />;
  }

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen
        options={{
          presentation: 'modal',
          title: isDeleting ? 'Delete society' : 'Leave society',
        }}
      />
      <ScrollView keyboardShouldPersistTaps="handled">
        <View className="gap-4 p-lg">
          <Text variant="headlineSmall">
            {isDeleting ? 'Delete this society?' : 'Leave this society?'}
          </Text>

          <Card variant="outlined">
            <View className="gap-2">
              <Text variant="titleMedium">{society?.name ?? 'This society'}</Text>
              <Text variant="bodyMedium" color="onSurfaceVariant">
                {isDeleting
                  ? 'Every member loses access and the society is archived. Financial history is retained for audit, but nothing can be added to it afterwards.'
                  : 'You lose access to its expenses, dues and members. You can rejoin with the join code, but a new request may need approval.'}
              </Text>
            </View>
          </Card>

          {isDeleting ? (
            <>
              <Text variant="bodyMedium" color="onSurfaceVariant">
                Type the society name to confirm. Only an Admin can delete a society.
              </Text>
              <Controller
                control={confirmForm.control}
                name="confirmation"
                render={({ field }) => (
                  <TextInput
                    label={`Type "${society?.name ?? ''}"`}
                    value={field.value}
                    onChangeText={field.onChange}
                    onBlur={field.onBlur}
                    error={deleteError !== undefined}
                    helperText={deleteError}
                    autoCapitalize="none"
                  />
                )}
              />
            </>
          ) : (
            <Text variant="bodyMedium" color="onSurfaceVariant">
              If you are the only Admin you cannot leave until another member is promoted — a
              society must always have an admin.
            </Text>
          )}

          {requestError !== null ? (
            <Text variant="bodyMedium" color="error">
              {requestError}
            </Text>
          ) : null}

          <Button
            variant="filled"
            size="lg"
            loading={isPending}
            onPress={() => {
              if (isDeleting) {
                void submitDelete();
              } else {
                void run();
              }
            }}
          >
            {isDeleting ? 'Delete society permanently' : 'Leave society'}
          </Button>
          <Button variant="text" onPress={() => router.back()}>
            Cancel
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}
