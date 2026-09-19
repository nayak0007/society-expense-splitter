import { Redirect } from 'expo-router';

import { SplashScreen } from '@/components/feedback/SplashScreen';
import { selectSessionStatus, useAuthStore } from '@/stores/auth.store';

/**
 * Route resolver — runs once per cold start and is the only place routing
 * decisions are made (SAD §5.2). Navigation-phase stub: the session store
 * has no backend, so restore() immediately resolves to unauthenticated and
 * every cold start lands on Welcome. Phase 2 swaps the store internals for
 * SecureStore → refresh → /auth/me; this file stays unchanged.
 */
export default function Index() {
  const status = useAuthStore(selectSessionStatus);

  if (status === 'restoring') {
    // Restore is synchronous-stub for now; SplashScreen still renders on
    // the first frame before the store settles.
    return <SplashScreen />;
  }

  if (status === 'unauthenticated') {
    return <Redirect href="/(auth)/welcome" />;
  }

  // No memberships/profile state exists yet — authenticated lands on home.
  return <Redirect href="/(app)/home" />;
}
