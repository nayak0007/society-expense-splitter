import { Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Pressable, ScrollView, View } from 'react-native';

import { PasswordField } from '@/components/forms/PasswordField';
import { Button } from '@/components/ui/Button';
import { Text } from '@/components/ui/Text';
import { TextInput } from '@/components/ui/TextInput';
import { signUpWithPassword } from '@/features/auth/api/auth.api';
import {
  signUpResolver,
  toSignUpPayload,
  type SignUpFormValues,
} from '@/features/auth/schemas/auth.schemas';

/**
 * Sign up with email + password (PRD §3.1, Roadmap T030).
 *
 * Validation is the shared contract's policy, so the client rejects exactly what
 * the server would. On success Supabase creates the `auth.users` row, the
 * `handle_new_user` trigger creates the `profiles` row from the forwarded
 * `full_name`, and:
 *  - if email confirmation is required (the default, and the PRD's "verification
 *    email with a 24h token") no session is returned → the verify screen;
 *  - if it is disabled, the session flips immediately and the `(auth)` group
 *    redirect takes the user into the app.
 */
export default function Register() {
  const router = useRouter();
  const [authError, setAuthError] = useState<string | null>(null);
  const {
    control,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignUpFormValues>({
    resolver: signUpResolver,
    defaultValues: {
      fullName: '',
      email: '',
      password: '',
      confirmPassword: '',
      acceptedTerms: false,
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    setAuthError(null);
    const result = await signUpWithPassword(toSignUpPayload(values));
    if (!result.ok) {
      setAuthError(result.error ?? 'Sign-up failed. Please try again.');
      return;
    }
    if (result.needsEmailVerification === true) {
      router.replace({ pathname: '/(auth)/verify-email', params: { email: values.email } });
    }
    // Otherwise the session is live and the (auth) group guard moves the user on.
  });

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ headerShown: true, headerTitle: 'Create account' }} />
      <ScrollView keyboardShouldPersistTaps="handled">
        <View className="gap-4 p-lg">
          <View className="gap-1">
            <Text variant="headlineSmall">Create your account</Text>
            <Text variant="bodyMedium" color="onSurfaceVariant">
              Your society membership is separate — you can join or create one after this step.
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

          <Controller
            control={control}
            name="email"
            render={({ field, fieldState }) => (
              <TextInput
                label="Email"
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                keyboardType="email-address"
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
            name="password"
            render={({ field, fieldState }) => (
              <PasswordField
                label="Password"
                autoComplete="new-password"
                value={field.value}
                onChangeText={field.onChange}
                onBlur={field.onBlur}
                error={fieldState.error !== undefined}
                helperText={
                  fieldState.error?.message ?? 'At least 8 characters, with a letter and a number.'
                }
              />
            )}
          />

          <Controller
            control={control}
            name="confirmPassword"
            render={({ field, fieldState }) => (
              <PasswordField
                label="Confirm password"
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
            name="acceptedTerms"
            render={({ field, fieldState }) => (
              <View className="gap-1">
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: field.value }}
                  accessibilityLabel="Accept the terms and privacy policy"
                  onPress={() => field.onChange(!field.value)}
                  className="min-h-11 flex-row items-center gap-3"
                >
                  <View
                    className={
                      field.value
                        ? 'h-5 w-5 items-center justify-center rounded-sm bg-primary'
                        : 'h-5 w-5 rounded-sm border border-outline'
                    }
                  >
                    {field.value ? (
                      <Text variant="labelSmall" color="onPrimary">
                        ✓
                      </Text>
                    ) : null}
                  </View>
                  <View className="flex-1">
                    <Text variant="bodySmall" color="onSurfaceVariant">
                      I accept the terms of service and the privacy policy, including that financial
                      records are retained after account deletion.
                    </Text>
                  </View>
                </Pressable>
                {fieldState.error !== undefined ? (
                  <Text variant="bodySmall" color="error">
                    {fieldState.error.message}
                  </Text>
                ) : null}
              </View>
            )}
          />

          {authError !== null ? (
            <Text variant="bodySmall" color="error">
              {authError}
            </Text>
          ) : null}

          {errors.root?.message !== undefined ? (
            <Text variant="bodySmall" color="error">
              {errors.root.message}
            </Text>
          ) : null}

          <Button variant="filled" loading={isSubmitting} onPress={() => void onSubmit()}>
            Create account
          </Button>
          <Button variant="text" onPress={() => router.replace('/(auth)/login')}>
            I already have an account
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}
