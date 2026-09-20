import { Redirect } from 'expo-router';

import { SplashScreen } from '@/components/feedback/SplashScreen';
import { selectSessionStatus, useAuthStore } from '@/stores/auth.store';
import { selectMemberships, selectSocietiesStatus, useSocietyStore } from '@/stores/society.store';

/**
 * Route resolver — runs once per cold start and is the only place routing
 * decisions are made (SAD §5.2).
 *
 * Four states map to four route groups:
 *   restoring              → Splash
 *   no session             → (auth)
 *   no membership          → (setup)/society-choice
 *   only pending requests  → (setup)/join-pending
 *   otherwise              → (app)
 *
 * Memberships arrive from the bootstrap query in the provider tree, so this
 * component only reads state — it never fetches. A failed memberships fetch
 * deliberately falls through to `(setup)` rather than holding the splash
 * forever: the setup screens can retry, the splash cannot.
 */
export default function Index() {
  const status = useAuthStore(selectSessionStatus);
  const societiesStatus = useSocietyStore(selectSocietiesStatus);
  const memberships = useSocietyStore(selectMemberships);

  const waitingForSession = status === 'restoring';
  const waitingForSocieties =
    status === 'authenticated' && societiesStatus !== 'ready' && societiesStatus !== 'error';

  if (waitingForSession || waitingForSocieties) {
    return <SplashScreen />;
  }

  if (status === 'unauthenticated') {
    return <Redirect href="/(auth)/welcome" />;
  }

  if (memberships.length === 0) {
    return <Redirect href="/(setup)/society-choice" />;
  }

  if (memberships.every((membership) => membership.status === 'pending')) {
    return <Redirect href="/(setup)/join-pending" />;
  }

  return <Redirect href="/(app)/home" />;
}
