import { router } from 'expo-router';

import { handleAuthRedirectUrl, type AuthLinkResult } from '../api/auth.api';

/**
 * Turn an incoming auth deep link into navigation.
 *
 * Splitting "parse and verify the link" (`auth.api.ts`, no navigation) from
 * "where does the user go" (here) keeps the API slice unit-testable and gives
 * every email link one landing place — signup confirmations, recovery links and
 * email changes all arrive as `societyexpense://auth/callback`.
 */
export async function handleAuthDeepLink(url: string): Promise<AuthLinkResult> {
  const result = await handleAuthRedirectUrl(url);

  try {
    switch (result.kind) {
      case 'signup':
        router.replace({ pathname: '/(auth)/verify-email', params: { status: 'verified' } });
        break;
      case 'recovery':
        // The session from the link is already installed; this screen can now
        // call updateUser() for it.
        router.replace('/(auth)/reset-password');
        break;
      case 'email_change':
        router.replace('/(app)/more');
        break;
      case 'error':
        router.replace({ pathname: '/(auth)/login', params: { linkError: result.error } });
        break;
      case 'oauth':
      case 'ignored':
        // OAuth flips the session and the route guards take over; a URL that is
        // not ours is somebody else's deep link.
        break;
    }
  } catch {
    // Cold start: the router may not be mounted yet. The session state is
    // already correct, so the guards place the user on the next render.
  }

  return result;
}
