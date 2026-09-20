import { Stack } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';
import { updatePassword } from '@/features/auth/api/auth.api';
import {
  resetPasswordResolver,
  type ResetPasswordValues,
} from '@/features/auth/schemas/auth.schemas';

/**
 * Reset password — the PASSWORD_RECOVERY deep link (session-sync.ts) routes
 * here with a recovery session attached, so updateUser() is authorised.
 */
export default function ResetPassword() {
  const {
    control,
    handleSubmit,
    formState: { isSubmitting, isSubmitSuccessful },
  } = useForm<ResetPasswordValues>({
    resolver: resetPasswordResolver,
    defaultValues: { password: '', confirmPassword: '' },
  });
  const [authError, setAuthError] = useState<string | null>(null);

  const onSubmit = handleSubmit(async (values) => {
    setAuthError(null);
    const result = await updatePassword(values.password);
    if (!result.ok && result.error !== undefined) {
      setAuthError(result.error);
    }
  });

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ headerShown: true, headerTitle: 'Choose a new password' }} />
      <View className="grow gap-4 p-lg">
        {isSubmitSuccessful && authError === null ? (
          <Text variant="bodyMedium">Password updated. You can now use your new password.</Text>
        ) : (
          <>
            <Controller
              control={control}
              name="password"
              render={({ field: { onChange, onBlur, value } }) => (
                <TextInput
                  label="New password"
                  secureTextEntry
                  autoComplete="new-password"
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                />
              )}
            />
            <Controller
              control={control}
              name="confirmPassword"
              render={({ field: { onChange, onBlur, value } }) => (
                <TextInput
                  label="Confirm new password"
                  secureTextEntry
                  autoComplete="new-password"
                  value={value}
                  onChangeText={onChange}
                  onBlur={onBlur}
                />
              )}
            />
            {authError !== null && (
              <Text variant="bodySmall" color="error">
                {authError}
              </Text>
            )}
            <Button variant="filled" onPress={onSubmit} loading={isSubmitting}>
              Update password
            </Button>
          </>
        )}
      </View>
    </View>
  );
}
