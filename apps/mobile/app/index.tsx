import { Redirect } from 'expo-router';

import { SplashScreen } from '@/components/feedback/SplashScreen';
import {
  selectIsProfileComplete,
  selectProfileStatus,
  selectSessionStatus,
  useAuthStore,
} from '@/stores/auth.store';
import { selectMemberships, selectSocietiesStatus, useSocietyStore } from '@/stores/society.store';

/**
 * Route resolver — runs once per cold start and is the only place routing
 * decisions are made (SAD §5.2).
 *
 * The six outcomes, in the order they are decided:
 *   restoring                       → Splash
 *   no session                      → (auth)
 *   session, profile still loading  → Splash
 *   session, profile incomplete     → (setup)/profile-setup
 *   no usable membership            → (setup)/society-choice
 *   only pending requests           → (setup)/join-pending
 *   otherwise                       → (app)
 *
 * Memberships and the profile arrive from the bootstrap hooks in the provider
 * tree, so this component only reads state — it never fetches.
 *
 * IMPORTANT: a *failed* profile or memberships fetch deliberately falls through
 * rather than holding the splash forever (a user offline with a valid session
 * must still reach the app). Both are retried on foreground by their hooks.
 */
export default function Index() {
  const status = useAuthStore(selectSessionStatus);
  const profileStatus = useAuthStore(selectProfileStatus);
  const profileComplete = useAuthStore(selectIsProfileComplete);
  const societiesStatus = useSocietyStore(selectSocietiesStatus);
  const memberships = useSocietyStore(selectMemberships);

  const restoringSession = status === 'restoring';
  const loadingProfile =
    status === 'authenticated' && profileStatus !== 'ready' && profileStatus !== 'error';
  const loadingSocieties =
    status === 'authenticated' &&
    profileStatus === 'ready' &&
    societiesStatus !== 'ready' &&
    societiesStatus !== 'error';

  if (restoringSession || loadingProfile || loadingSocieties) {
    return <SplashScreen />;
  }

  if (status === 'unauthenticated') {
    return <Redirect href="/(auth)/welcome" />;
  }

  // Only a *known* incomplete profile gates: an error must not trap the user in
  // onboarding they cannot complete offline.
  if (profileStatus === 'ready' && !profileComplete) {
    return <Redirect href="/(setup)/profile-setup" />;
  }

  if (memberships.length === 0) {
    return <Redirect href="/(setup)/society-choice" />;
  }

  if (memberships.every((membership) => membership.status === 'pending')) {
    return <Redirect href="/(setup)/join-pending" />;
  }

  return <Redirect href="/(app)/home" />;
}
