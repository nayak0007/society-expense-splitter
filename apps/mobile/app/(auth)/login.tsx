import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';
import { signInWithGoogle, signInWithPassword } from '@/features/auth/api/auth.api';
import { loginResolver, type LoginCredentials } from '@/features/auth/schemas/auth.schemas';

/**
 * Login — email/password + Google (SAD §5.2). API errors map to inline MD3
 * supporting text; successful sign-in flips the session store, and the
 * (auth) group redirect (SAD §5.5) moves the user into the app.
 */
export default function Login() {
  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<LoginCredentials>({
    resolver: loginResolver,
    defaultValues: { email: '', password: '' },
  });
  const [googleLoading, setGoogleLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const onSubmit = handleSubmit(async (values) => {
    setAuthError(null);
    const result = await signInWithPassword(values.email, values.password);
    if (!result.ok && result.error !== undefined) {
      setAuthError(result.error);
    }
  });

  const onGoogle = async () => {
    setAuthError(null);
    setGoogleLoading(true);
    const result = await signInWithGoogle();
    setGoogleLoading(false);
    if (!result.ok && result.error !== undefined) {
      setAuthError(result.error);
    }
  };

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ headerShown: true, headerTitle: 'Log in' }} />
      <View className="grow gap-4 p-lg">
        <Controller
          control={control}
          name="email"
          render={({ field: { onChange, onBlur, value } }) => (
            <TextInput
              label="Email"
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              value={value}
              onChangeText={onChange}
              onBlur={onBlur}
            />
          )}
        />
        <Controller
          control={control}
          name="password"
          render={({ field: { onChange, onBlur, value } }) => (
            <TextInput
              label="Password"
              secureTextEntry
              autoComplete="password"
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
          Log in
        </Button>

        <Button variant="outlined" onPress={onGoogle} loading={googleLoading}>
          Continue with Google
        </Button>

        <Button variant="text" onPress={() => router.push('/(auth)/forgot-password')}>
          Forgot password?
        </Button>
      </View>
    </View>
  );
}
