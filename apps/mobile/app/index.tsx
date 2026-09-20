import { Redirect } from 'expo-router';

import { SplashScreen } from '@/components/feedback/SplashScreen';
import { selectSessionStatus, useAuthStore } from '@/stores/auth.store';

/**
 * Route resolver — runs once per cold start and is the only place routing
 * decisions are made (SAD §5.2). The session store is fed by the Supabase
 * bridge (src/lib/supabase/session-sync.ts): restore happens from the
 * SecureStore-backed client, so a persisted session lands straight in the
 * app group and a fresh install lands on Welcome.
 */
export default function Index() {
  const status = useAuthStore(selectSessionStatus);

  if (status === 'restoring') {
    // Session restore (SecureStore → Supabase) is in flight; the watchdog
    // in session-sync bounds it at 8 s so splash never locks permanently.
    return <SplashScreen />;
  }

  if (status === 'unauthenticated') {
    return <Redirect href="/(auth)/welcome" />;
  }

  // No memberships/profile state exists yet — authenticated lands on home.
  return <Redirect href="/(app)/home" />;
}
