import { OCCUPANCY_TYPES } from '@ses/domain';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { LoadingIndicator } from '@/components/ui/LoadingIndicator';
import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';
import { ChoiceChips } from '@/components/forms/ChoiceChips';
import { useJoinOptions, useJoinPreview } from '@/features/society/hooks/use-societies';
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
 * (name, city, member count) → **pick your flat** → declare occupancy → submit.
 *
 * ## The flat comes from the society's own list (T049)
 *
 * `GET /societies/join-options` is keyed by the code the user already holds and returns only
 * the selector's fields — id, number, building, wing, floor. The screen therefore never asks
 * anybody to *type* a flat number: a typed number is a label the server would have to resolve,
 * which is how two flats end up claiming one number. Picking none is a legitimate submission
 * (a society whose flats are not recorded yet still has to be joinable); the reviewer assigns
 * one at approval.
 *
 * ## The note is optional on purpose
 *
 * The reviewer sees it beside the request, and the common case — "I am the tenant of A-402" —
 * needs no message at all, so a required text box would only slow the flow down.
 */
export default function SocietyJoin() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string }>();
  const pendingJoinCode = useSocietyStore(selectPendingJoinCode);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  const [flatSearch, setFlatSearch] = useState('');
  const [flatQuery, setFlatQuery] = useState('');

  const { control, handleSubmit, formState, watch } = useForm<JoinFormValues>({
    resolver: joinFormResolver,
    defaultValues: emptyJoinForm(params.code ?? pendingJoinCode ?? ''),
  });

  const code = watch('code');
  const { preview, isSearching, notFound } = useJoinPreview(code);
  const joinSociety = useJoinSociety();

  // One beat behind the keyboard, so the flats are not requested per character. The term the
  // request is made with is separate state — the same pattern the member directory uses.
  useEffect(() => {
    const timer = setTimeout(() => setFlatQuery(flatSearch), 300);
    return () => clearTimeout(timer);
  }, [flatSearch]);

  const options = useJoinOptions(preview === null ? '' : code, flatQuery);

  const submit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      const membership = await joinSociety.mutateAsync(formValuesToJoinPayload(values));
      if (membership.status === 'active') {
        router.replace('/(app)/home');
        return;
      }
      // PRD §3.2: joins are never auto-approved — the request waits for an
      // Admin, and the pending screen is where it is visible (and withdrawable).
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

  const flatOptions = [
    { value: '', label: 'Not sure yet' },
    ...options.flats.map((flat) => ({
      value: flat.id,
      label: `${flat.buildingName} · ${flat.number}`,
    })),
  ];

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
                  setFlatSearch('');
                  setFlatQuery('');
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
              <View className="gap-2">
                <Text variant="titleSmall">Your flat</Text>
                <Text variant="bodySmall" color="onSurfaceVariant">
                  Your Admin confirms the flat when they approve your request — and if somebody else
                  has already claimed it, they see both claims.
                </Text>

                {options.isLoading ? (
                  <LoadingIndicator message="Loading the society's flats…" />
                ) : null}

                {options.error != null ? (
                  <Text variant="bodySmall" color="error">
                    {societyErrorMessage(options.error)}
                  </Text>
                ) : null}

                {!options.isLoading && options.flats.length === 0 ? (
                  <Text variant="bodySmall" color="onSurfaceVariant">
                    This society has not recorded its flats yet. Submit without one and an Admin
                    will assign it when they approve you.
                  </Text>
                ) : null}

                {options.flats.length > 0 ? (
                  <>
                    <TextInput
                      label="Find your flat"
                      value={flatSearch}
                      onChangeText={setFlatSearch}
                      helperText="By flat number or building name"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <Controller
                      control={control}
                      name="apartmentId"
                      render={({ field }) => (
                        <ChoiceChips
                          label={
                            options.total > options.flats.length
                              ? `Showing ${options.flats.length} of ${options.total} flats`
                              : 'Pick your flat'
                          }
                          options={flatOptions}
                          value={field.value}
                          onChange={field.onChange}
                        />
                      )}
                    />
                  </>
                ) : null}
                {/*
                  With no list there is nothing to choose from, so the form keeps its empty
                  value (no flat) rather than silently holding an id the user cannot see. The
                  `apartmentId` field is not rendered at all in that branch.
                */}
              </View>

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

              <Controller
                control={control}
                name="message"
                render={({ field, fieldState }) => (
                  <TextInput
                    label="Message to the reviewer (optional)"
                    value={field.value}
                    onChangeText={field.onChange}
                    onBlur={field.onBlur}
                    error={fieldState.error !== undefined}
                    helperText={fieldState.error?.message ?? 'For example: tenant since March 2026'}
                    multiline
                    numberOfLines={3}
                    maxLength={500}
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
