import { OCCUPANCY_TYPES } from '@ses/domain';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';
import { ChoiceChips } from '@/features/society/components/ChoiceChips';
import { useJoinPreview } from '@/features/society/hooks/use-societies';
import { useJoinSociety } from '@/features/society/hooks/use-society-actions';
import { OCCUPANCY_LABELS } from '@/features/society/labels';
import {
  emptyJoinForm,
  formValuesToJoinPayload,
  joinFormResolver,
} from '@/features/society/schemas/society.schemas';
import type { JoinFormValues } from '@/features/society/schemas/society.schemas';
import { societyErrorMessage } from '@/features/society/services/society.service';
import { selectPendingJoinCode, useSocietyStore } from '@/stores/society.store';

/**
 * Join society (PRD §3.2 "Join Society"): enter code → preview the society
 * (name, city, member count) → declare occupancy → submit.
 *
 * Choosing the flat is deliberately absent: it must come from the society's
 * real apartment list, which the structure module (T042+) has not created yet.
 * Collecting a flat number here would be inventing data the server cannot
 * validate, so the membership carries the occupancy declaration only and the
 * admin assigns the flat during approval.
 */
export default function SocietyJoin() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string }>();
  const pendingJoinCode = useSocietyStore(selectPendingJoinCode);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);

  const { control, handleSubmit, formState, watch } = useForm<JoinFormValues>({
    resolver: joinFormResolver,
    defaultValues: emptyJoinForm(params.code ?? pendingJoinCode ?? ''),
  });

  const code = watch('code');
  const { preview, isSearching, notFound } = useJoinPreview(code);
  const joinSociety = useJoinSociety();

  const submit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const membership = await joinSociety.mutateAsync(formValuesToJoinPayload(values));
      if (membership.status === 'active') {
        router.replace('/(app)/home');
        return;
      }
      // PRD §3.2: joins are never auto-approved — the request waits for an
      // Admin. The mock backend auto-approves for now; this path renders as
      // soon as the approval queue exists.
      setRequested(true);
    } catch (error: unknown) {
      setSubmitError(societyErrorMessage(error));
    }
  });

  if (requested) {
    return (
      <View className="flex-1 bg-surface">
        <Stack.Screen options={{ title: 'Request sent' }} />
        <View className="flex-1 items-center justify-center gap-3 p-lg">
          <Text variant="titleMedium" align="center">
            Request sent
          </Text>
          <Text variant="bodyMedium" color="onSurfaceVariant" align="center">
            An Admin of {preview?.name ?? 'the society'} has to approve your request before you can
            see its expenses.
          </Text>
          <Button variant="tonal" onPress={() => router.replace('/(setup)/join-pending')}>
            See pending requests
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ title: 'Join society' }} />
      <ScrollView keyboardShouldPersistTaps="handled">
        <View className="gap-4 p-lg">
          <View className="gap-2">
            <Text variant="headlineSmall">Join a society</Text>
            <Text variant="bodyMedium" color="onSurfaceVariant">
              Enter the 6-character code your committee shared. Codes never contain 0, O, 1 or I.
            </Text>
          </View>

          <Controller
            control={control}
            name="code"
            render={({ field, fieldState }) => (
              <TextInput
                label="Join code"
                value={field.value}
                onChangeText={(text) => {
                  setSubmitError(null);
                  field.onChange(text);
                }}
                onBlur={field.onBlur}
                error={fieldState.error !== undefined}
                helperText={fieldState.error?.message}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={8}
              />
            )}
          />

          {isSearching ? <LoadingIndicator message="Looking up that code…" /> : null}

          {notFound ? (
            <Text variant="bodyMedium" color="error">
              No society matches that code. Check for typos, or ask an admin to regenerate it.
            </Text>
          ) : null}

          {preview !== null ? (
            <Card variant="filled">
              <View className="gap-1">
                <Text variant="titleMedium">{preview.name}</Text>
                <Text variant="bodyMedium" color="onSurfaceVariant">
                  {preview.city}, {preview.state} · {preview.memberCount}{' '}
                  {preview.memberCount === 1 ? 'member' : 'members'}
                </Text>
              </View>
            </Card>
          ) : null}

          {preview !== null ? (
            <>
              <Controller
                control={control}
                name="occupancyType"
                render={({ field }) => (
                  <ChoiceChips
                    label="Your occupancy"
                    options={OCCUPANCY_TYPES.map((value) => ({
                      value,
                      label: OCCUPANCY_LABELS[value],
                    }))}
                    value={field.value}
                    onChange={field.onChange}
                    error={formState.errors.occupancyType?.message}
                  />
                )}
              />

              {submitError !== null ? (
                <Text variant="bodyMedium" color="error">
                  {submitError}
                </Text>
              ) : null}

              <Button
                variant="filled"
                size="lg"
                loading={joinSociety.isPending}
                onPress={() => void submit()}
              >
                Join society
              </Button>
            </>
          ) : null}

          <Button variant="text" onPress={() => router.back()}>
            Back
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}
