import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { View } from 'react-native';

import { PasswordField } from '@/components/forms/PasswordField';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Text } from '@/components/ui/Text';
import { logout, updatePassword } from '@/features/auth/api/auth.api';
import {
  resetPasswordResolver,
  type ResetPasswordValues,
} from '@/features/auth/schemas/auth.schemas';
import { selectSessionStatus, useAuthStore } from '@/stores/auth.store';

/**
 * Reset password (PRD §3.1, Roadmap T022).
 *
 * The screen is only reachable with a *recovery session*: the email link either
 * arrived as `?token_hash=…&type=recovery` (verified by `auth.api`) or as a URL
 * fragment, and both are exchanged for a session before this renders
 * (`session-sync` routes on `PASSWORD_RECOVERY`, `auth-deep-link` on the parsed
 * kind). Without a session the link is expired, already used, or was opened in
 * another browser — the honest answer is to say so and offer a fresh email,
 * rather than letting the user fill in a form that cannot be submitted.
 *
 * On success the PRD asks for every existing refresh token to be invalidated, so
 * the update is followed by a **global** sign-out: every device is logged out
 * and the user signs in again with the new password.
 */
export default function ResetPassword() {
  const router = useRouter();
  const sessionStatus = useAuthStore(selectSessionStatus);
  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<ResetPasswordValues>({
    resolver: resetPasswordResolver,
    defaultValues: { password: '', confirmPassword: '' },
  });
  const [authError, setAuthError] = useState<string | null>(null);
  const [isDone, setIsDone] = useState(false);

  const onSubmit = handleSubmit(async (values) => {
    setAuthError(null);
    const result = await updatePassword(values.password);
    if (!result.ok) {
      setAuthError(result.error ?? 'Could not update your password.');
      return;
    }
    await logout('global');
    setIsDone(true);
  });

  if (isDone) {
    return (
      <View className="flex-1 bg-surface">
        <Stack.Screen options={{ headerShown: true, headerTitle: 'Password updated' }} />
        <View className="grow gap-4 p-lg">
          <Card variant="filled">
            <View className="gap-1">
              <Text variant="titleMedium">Password updated</Text>
              <Text variant="bodyMedium" color="onSurfaceVariant">
                Every signed-in device has been logged out. Sign in again with your new password.
              </Text>
            </View>
          </Card>
          <Button variant="filled" onPress={() => router.replace('/(auth)/login')}>
            Go to log in
          </Button>
        </View>
      </View>
    );
  }

  if (sessionStatus !== 'authenticated') {
    return (
      <View className="flex-1 bg-surface">
        <Stack.Screen options={{ headerShown: true, headerTitle: 'Reset password' }} />
        <View className="grow gap-4 p-lg">
          <Card variant="outlined">
            <View className="gap-1">
              <Text variant="titleMedium">This link is no longer valid</Text>
              <Text variant="bodyMedium" color="onSurfaceVariant">
                Reset links are single-use and expire after 60 minutes. Request a new one to
                continue.
              </Text>
            </View>
          </Card>
          <Button variant="filled" onPress={() => router.replace('/(auth)/forgot-password')}>
            Send a new reset link
          </Button>
          <Button variant="text" onPress={() => router.replace('/(auth)/login')}>
            Back to log in
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ headerShown: true, headerTitle: 'Choose a new password' }} />
      <View className="grow gap-4 p-lg">
        <Text variant="bodyMedium" color="onSurfaceVariant">
          Choose a password you have not used before. At least 8 characters, with a letter and a
          number.
        </Text>
        <Controller
          control={control}
          name="password"
          render={({ field, fieldState }) => (
            <PasswordField
              label="New password"
              autoComplete="new-password"
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              error={fieldState.error !== undefined}
              helperText={fieldState.error?.message}
            />
          )}
        />
        <Controller
          control={control}
          name="confirmPassword"
          render={({ field, fieldState }) => (
            <PasswordField
              label="Confirm new password"
              autoComplete="new-password"
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
              error={fieldState.error !== undefined}
              helperText={fieldState.error?.message}
            />
          )}
        />
        {authError !== null ? (
          <Text variant="bodySmall" color="error">
            {authError}
          </Text>
        ) : null}
        <Button variant="filled" loading={isSubmitting} onPress={() => void onSubmit()}>
          Update password
        </Button>
      </View>
    </View>
  );
}
