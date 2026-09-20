import type { Provider } from '@supabase/supabase-js';
import * as WebBrowser from 'expo-web-browser';

import { getSupabaseClient } from '@/lib/supabase/supabase.client';

/**
 * Auth API slice (SAD §4.2: features/auth/api). One function per use case;
 * each delegates identity work to the Supabase adapter. Returns plain data —
 * callers own mapping errors into UI.
 */

export interface AuthResult {
  readonly ok: boolean;
  readonly error?: string;
}

/** Deep-link target for OAuth + password-recovery callbacks (SAD §3.2). */
export const AUTH_REDIRECT_PREFIX = 'societyexpense://auth/callback';

function toResult(error: unknown): AuthResult {
  if (error !== null && typeof error === 'object' && 'message' in error) {
    return { ok: false, error: String(error.message) };
  }
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

/** Email + password sign-in. */
export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  try {
    const { error } = await getSupabaseClient().auth.signInWithPassword({
      email,
      password,
    });
    // Session state flips via onAuthStateChange in session-sync.ts.
    return error === null ? { ok: true } : toResult(error);
  } catch (error: unknown) {
    return toResult(error);
  }
}

/**
 * Google sign-in via the system browser (expo-web-browser).
 *
 * Implicit OAuth flow: `skipBrowserRedirect: true` returns the authorize URL,
 * which we open in an auth session; Supabase redirects back to
 * `societyexpense://auth/callback` with tokens in the URL fragment. iOS
 * resolves them from the openAuthSessionAsync result; Android and cold-start
 * returns are captured by the Linking listener in AppProviders — both paths
 * call handleAuthRedirectUrl, which is idempotent.
 *
 * Requires the Google provider + the redirect URL to be configured in the
 * Supabase dashboard (Dashboard → Auth → Providers → Google, Redirect URLs).
 */
export async function signInWithGoogle(): Promise<AuthResult> {
  try {
    const { data, error } = await getSupabaseClient().auth.signInWithOAuth({
      provider: 'google' satisfies Provider,
      options: {
        skipBrowserRedirect: true,
        redirectTo: AUTH_REDIRECT_PREFIX,
      },
    });
    if (error !== null) return toResult(error);
    if (data.url === undefined || data.url === null) {
      return { ok: false, error: 'Could not start Google sign-in.' };
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, AUTH_REDIRECT_PREFIX);
    if (result.type !== 'success') {
      return { ok: false, error: 'Google sign-in was cancelled.' };
    }
    // iOS hands back the final URL here; Android via the Linking listener.
    await handleAuthRedirectUrl(result.url);
    return { ok: true };
  } catch (error: unknown) {
    return toResult(error);
  }
}

/** Send the password-recovery email (hosted reset page deep-links back). */
export async function sendPasswordReset(email: string): Promise<AuthResult> {
  try {
    const { error } = await getSupabaseClient().auth.resetPasswordForEmail(email, {
      redirectTo: AUTH_REDIRECT_PREFIX,
    });
    return error === null ? { ok: true } : toResult(error);
  } catch (error: unknown) {
    return toResult(error);
  }
}

/** Set a new password after the recovery flow (session already active). */
export async function updatePassword(newPassword: string): Promise<AuthResult> {
  try {
    const { error } = await getSupabaseClient().auth.updateUser({ password: newPassword });
    return error === null ? { ok: true } : toResult(error);
  } catch (error: unknown) {
    return toResult(error);
  }
}

/** Logout — revokes the session and wipes tokens from SecureStore. */
export async function logout(): Promise<AuthResult> {
  try {
    const { error } = await getSupabaseClient().auth.signOut();
    return error === null ? { ok: true } : toResult(error);
  } catch (error: unknown) {
    return toResult(error);
  }
}

/**
 * Handle an incoming societyexpense://auth/callback URL (OAuth fragment or
 * recovery link). Returns true if this URL belongs to the auth flow — callers
 * keep their own Linking listeners simple.
 */
export async function handleAuthRedirectUrl(url: string): Promise<boolean> {
  if (!url.startsWith(AUTH_REDIRECT_PREFIX)) return false;
  const tokens = parseOAuthRedirect(url);
  if (tokens !== null) {
    await getSupabaseClient().auth.setSession(tokens);
  }
  // Provider errors (error=…) and code flows are intentionally ignored:
  // the session bridge resolves to whatever Supabase decides.
  return true;
}

interface ParsedTokens {
  access_token: string;
  refresh_token: string;
}

/** Tokens arrive in the URL fragment for the implicit OAuth flow. */
function parseOAuthRedirect(url: string): ParsedTokens | null {
  const fragmentStart = url.indexOf('#');
  if (fragmentStart === -1) return null;
  const params = new URLSearchParams(url.slice(fragmentStart + 1));
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (accessToken === null || refreshToken === null) return null;
  return { access_token: accessToken, refresh_token: refreshToken };
}
