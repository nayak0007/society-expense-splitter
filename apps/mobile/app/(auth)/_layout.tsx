/**
 * Auth group — welcome, login, register, forgot-password (SAD §5.1).
 *
 * GROUP-LEVEL GUARD, inverse side (SAD §5.5): once the session becomes
 * authenticated, nothing in this group may stay on screen — including the
 * moment a sign-in succeeds while the user is looking at the login form.
 * During 'restoring' we do nothing, so a persisted session never flashes
 * the login screen on cold start.
 */
import { Redirect, Stack } from 'expo-router';

import { selectSessionStatus, useAuthStore } from '@/stores/auth.store';

export default function AuthLayout() {
  const status = useAuthStore(selectSessionStatus);

  if (status === 'authenticated') {
    // No memberships/profile state exists yet — authenticated lands on home.
    return <Redirect href="/(app)/home" />;
  }

  return <Stack screenOptions={{ headerBackTitle: 'Back' }} />;
}
