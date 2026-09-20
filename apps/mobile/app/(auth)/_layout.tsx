/**
 * Auth group — welcome, login, register, forgot-password, verify-email,
 * reset-password (SAD §5.1).
 *
 * GROUP-LEVEL GUARD, inverse side (SAD §5.5): once the session becomes
 * authenticated, nothing in this group may stay on screen — including the
 * moment a sign-in succeeds while the user is looking at the login form.
 * During 'restoring' we do nothing, so a persisted session never flashes
 * the login screen on cold start.
 *
 * Two routes are deliberately exempt, because both are reached *with* a live
 * session and would otherwise be unreachable:
 *  - `reset-password` runs on the recovery session the email link installs;
 *  - `verify-email` is where the confirmation link lands, which also carries a
 *    session.
 * Redirecting those would create a loop the user cannot escape.
 */
import { Redirect, Stack, usePathname } from 'expo-router';

import { selectSessionStatus, useAuthStore } from '@/stores/auth.store';

/** Path fragments that must remain reachable while a session exists. */
const AUTHENTICATED_ROUTES = ['/reset-password', '/verify-email'];

export default function AuthLayout() {
  const status = useAuthStore(selectSessionStatus);
  const pathname = usePathname();
  const staysPut = AUTHENTICATED_ROUTES.some((route) => pathname.includes(route));

  if (status === 'authenticated' && !staysPut) {
    // The resolver owns the decision (profile → memberships → app).
    return <Redirect href="/" />;
  }

  return <Stack screenOptions={{ headerBackTitle: 'Back' }} />;
}
