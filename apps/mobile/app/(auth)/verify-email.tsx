import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Text } from '@/components/ui/Text';
import { logout, refreshCurrentUser, resendVerificationEmail } from '@/features/auth/api/auth.api';
import { selectAuthUser, selectEmailVerified, useAuthStore } from '@/stores/auth.store';

/** Supabase rate-limits resends server-side; this keeps users from finding out. */
const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Email verification (PRD §3.1: "send a verification email with a 24h token").
 *
 * Three states live on one screen because they are the same task from the user's
 * point of view:
 *  - just signed up → "check your inbox" with a resend;
 *  - returned through the confirmation link (`?status=verified`) → success;
 *  - signed in but not yet verified → the same screen, reached from More.
 *
 * "I've verified" re-reads the user from Supabase rather than trusting local
 * state: the confirmation may have happened in a mail client on another device.
 */
export default function VerifyEmail() {
  const router = useRouter();
  const params = useLocalSearchParams<{ email?: string; status?: string }>();
  const user = useAuthStore(selectAuthUser);
  const emailVerified = useAuthStore(selectEmailVerified);

  const email = params.email ?? user?.email ?? '';
  const justVerified = params.status === 'verified';

  const [cooldown, setCooldown] = useState(0);
  const [isChecking, setIsChecking] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [notice, setNotice] = useState<{ readonly ok: boolean; readonly text: string } | null>(
    null,
  );

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const verified = emailVerified || justVerified;

  const onResend = async () => {
    setNotice(null);
    const result = await resendVerificationEmail(email);
    if (!result.ok) {
      setNotice({ ok: false, text: result.error ?? 'Could not send the email.' });
      return;
    }
    setCooldown(RESEND_COOLDOWN_SECONDS);
    setNotice({ ok: true, text: `Verification email sent to ${email}.` });
  };

  const onCheck = async () => {
    setNotice(null);
    setIsChecking(true);
    const result = await refreshCurrentUser();
    setIsChecking(false);

    if (!result.ok) {
      setNotice({
        ok: false,
        text: result.error ?? 'Could not check your email status. Try again.',
      });
      return;
    }
    if (result.emailVerified === true) {
      useAuthStore.getState().applyEmailVerified(true);
      router.replace('/');
      return;
    }
    setNotice({ ok: false, text: 'Still unverified. Open the link in your inbox first.' });
  };

  const onSignOut = async () => {
    setIsSigningOut(true);
    await logout('local');
    setIsSigningOut(false);
    router.replace('/(auth)/welcome');
  };

  return (
    <View className="flex-1 bg-surface">
      <Stack.Screen options={{ headerShown: true, headerTitle: 'Verify email' }} />
      <View className="grow gap-4 p-lg">
        {verified ? (
          <>
            <Card variant="filled">
              <View className="gap-1">
                <Text variant="titleMedium">Email verified</Text>
                <Text variant="bodyMedium" color="onSurfaceVariant">
                  {email.length > 0 ? email : 'Your email address'} is confirmed.
                </Text>
              </View>
            </Card>
            <Button variant="filled" onPress={() => router.replace('/')}>
              Continue
            </Button>
          </>
        ) : (
          <>
            <Text variant="headlineSmall">Confirm your email</Text>
            <Text variant="bodyMedium" color="onSurfaceVariant">
              We sent a verification link to {email.length > 0 ? email : 'your email address'}. Open
              it on this device to finish setting up your account.
            </Text>
            <Text variant="bodySmall" color="onSurfaceVariant">
              You can already sign in, but an unverified account cannot hold an Admin or Treasurer
              role until the address is confirmed.
            </Text>

            {notice !== null ? (
              <Text variant="bodySmall" color={notice.ok ? 'success' : 'error'}>
                {notice.text}
              </Text>
            ) : null}

            <Button
              variant="filled"
              loading={isChecking}
              disabled={cooldown > 0 && notice === null}
              onPress={() => void onCheck()}
            >
              I have verified my email
            </Button>
            <Button variant="tonal" disabled={cooldown > 0} onPress={() => void onResend()}>
              {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend verification email'}
            </Button>
            <Button variant="text" onPress={() => router.replace('/(auth)/register')}>
              Use a different email
            </Button>
            <Button variant="text" loading={isSigningOut} onPress={() => void onSignOut()}>
              Sign out
            </Button>
          </>
        )}
      </View>
    </View>
  );
}
