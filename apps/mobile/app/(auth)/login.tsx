import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { View } from 'react-native';

import { PasswordField } from '@/components/forms/PasswordField';
import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';
import { signInWithGoogle, signInWithPassword } from '@/features/auth/api/auth.api';
import { loginResolver, type LoginCredentials } from '@/features/auth/schemas/auth.schemas';

/**
 * Login — email/password + Google (SAD §5.2).
 *
 * Two PRD §3.1 rules are visible here:
 *  - failures read "Email or password is incorrect", never revealing whether the
 *    email exists (the mapping is in `auth.api.ts`, applied to every failure);
 *  - an unconfirmed email is not a dead end: the user is routed to the verify
 *    screen with a resend, because that is the only thing they can actually do.
 *
 * Deep-link failures (expired confirmation or recovery link) arrive as
 * `?linkError=` and render inline.
 */
export default function Login() {
  const params = useLocalSearchParams<{ linkError?: string; email?: string }>();
  const {
    control,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<LoginCredentials>({
    resolver: loginResolver,
    defaultValues: { email: params.email ?? '', password: '' },
  });
  const [googleLoading, setGoogleLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(params.linkError ?? null);

  const onSubmit = handleSubmit(async (values) => {
    setAuthError(null);
    const result = await signInWithPassword(values.email, values.password);
    if (result.ok) return;

    if (result.code === 'email_not_confirmed') {
      router.push({ pathname: '/(auth)/verify-email', params: { email: values.email } });
      return;
    }
    setAuthError(result.error ?? 'Could not sign in. Please try again.');
  });

  const onGoogle = async () => {
    setAuthError(null);
    setGoogleLoading(true);
    const result = await signInWithGoogle();
    setGoogleLoading(false);
    if (!result.ok) {
      setAuthError(result.error ?? 'Could not sign in with Google.');
    }
  };

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ headerShown: true, headerTitle: 'Log in' }} />
      <View className="grow gap-4 p-lg">
        <Controller
          control={control}
          name="email"
          render={({ field }) => (
            <TextInput
              label="Email"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              keyboardType="email-address"
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
            />
          )}
        />
        <Controller
          control={control}
          name="password"
          render={({ field }) => (
            <PasswordField
              label="Password"
              value={field.value}
              onChangeText={field.onChange}
              onBlur={field.onBlur}
            />
          )}
        />

        {authError !== null ? (
          <Text variant="bodySmall" color="error">
            {authError}
          </Text>
        ) : null}

        <Button variant="filled" loading={isSubmitting} onPress={() => void onSubmit()}>
          Log in
        </Button>

        <Button variant="outlined" loading={googleLoading} onPress={() => void onGoogle()}>
          Continue with Google
        </Button>

        <Button variant="text" onPress={() => router.push('/(auth)/forgot-password')}>
          Forgot password?
        </Button>
        <Button variant="text" onPress={() => router.replace('/(auth)/register')}>
          Create an account
        </Button>
      </View>
    </View>
  );
}
