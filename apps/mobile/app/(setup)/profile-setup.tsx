import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { ScrollView, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';
import { logout } from '@/features/auth/api/auth.api';
import { profileErrorMessage, saveProfile } from '@/features/auth/api/profile.api';
import {
  profileSetupResolver,
  type ProfileSetupValues,
} from '@/features/auth/schemas/auth.schemas';
import { selectAuthUser, selectProfile, useAuthStore } from '@/stores/auth.store';

/**
 * Profile bootstrap (SAD §5.2: an authenticated user whose profile is incomplete
 * lands here before anything else).
 *
 * "Complete" is computed by the database (`profiles.is_profile_complete`), not by
 * this screen: the API, the RLS layer and the client must agree on what a usable
 * account is, and the only place all three can read the same answer is the row
 * itself. Saving the name flips it, and the resolver moves the user on.
 *
 * Phone is not collected here — it is an identity with an OTP step (PRD §3.1),
 * so it arrives with the phone/OTP module rather than as an unverified text
 * field.
 */
export default function ProfileSetup() {
  const router = useRouter();
  const user = useAuthStore(selectAuthUser);
  const profile = useAuthStore(selectProfile);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<ProfileSetupValues>({
    resolver: profileSetupResolver,
    values: { fullName: profile?.fullName ?? '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    if (user === null) return;
    setSaveError(null);
    setIsSaving(true);
    try {
      const updated = await saveProfile(user.id, { fullName: values.fullName });
      useAuthStore.getState().applyProfile(updated);
      // Re-run the cold-start decision so routing stays in one place.
      router.replace('/');
    } catch (error: unknown) {
      setSaveError(profileErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  });

  const onSignOut = async () => {
    setIsSigningOut(true);
    await logout('local');
    setIsSigningOut(false);
    router.replace('/(auth)/welcome');
  };

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ headerShown: true, headerTitle: 'Your details' }} />
      <ScrollView keyboardShouldPersistTaps="handled">
        <View className="gap-4 p-lg">
          <View className="gap-1">
            <Text variant="headlineSmall">Tell us your name</Text>
            <Text variant="bodyMedium" color="onSurfaceVariant">
              This is how committee members see you in the member list and on receipts.
            </Text>
          </View>

          <Controller
            control={control}
            name="fullName"
            render={({ field, fieldState }) => (
              <TextInput
                label="Full name"
                autoCapitalize="words"
                autoComplete="name"
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                error={fieldState.error !== undefined}
                helperText={fieldState.error?.message}
              />
            )}
          />

          {user?.email !== null && user?.email !== undefined ? (
            <Text variant="bodySmall" color="onSurfaceVariant">
              Signed in as {user.email}
            </Text>
          ) : null}

          {saveError !== null ? (
            <Text variant="bodySmall" color="error">
              {saveError}
            </Text>
          ) : null}

          {errors.root?.message !== undefined ? (
            <Text variant="bodySmall" color="error">
              {errors.root.message}
            </Text>
          ) : null}

          <Button variant="filled" loading={isSaving} onPress={() => void onSubmit()}>
            Save and continue
          </Button>
          <Button variant="text" loading={isSigningOut} onPress={() => void onSignOut()}>
            Sign out
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}
