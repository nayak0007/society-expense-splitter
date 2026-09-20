import type { SignUpPayload } from '@ses/contracts';
import type { EmailOtpType, Provider } from '@supabase/supabase-js';
import * as WebBrowser from 'expo-web-browser';

import { getSupabaseClient } from '@/lib/supabase/supabase.client';

/**
 * Auth API slice (SAD §4.2: features/auth/api). One function per use case; each
 * delegates identity work to the Supabase adapter. Returns plain data — callers
 * own mapping errors into UI.
 *
 * Supabase Auth is the identity provider of record (SAD §2.2). Where a PRD rule
 * is stricter than Supabase's default (password policy, neutral login errors,
 * verification gating) the rule is applied here or in `packages/contracts`, and
 * the dashboard setting is treated as a floor rather than the policy.
 */

/** Deep-link target for OAuth, email-confirmation and recovery links (PRD §3.2). */
export const AUTH_REDIRECT_PREFIX = 'societyexpense://auth/callback';

/**
 * Error codes the UI branches on. Anything unrecognised falls through to a
 * generic message, so a new Supabase code never leaks a raw string to a user.
 */
export type AuthErrorCode =
  | 'invalid_credentials'
  | 'email_not_confirmed'
  | 'user_already_exists'
  | 'rate_limited'
  | 'weak_password'
  | 'link_expired'
  | 'network'
  | 'unknown';

export interface AuthResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly code?: AuthErrorCode;
}

export interface SignUpResult {
  readonly ok: boolean;
  /**
   * True when Supabase created the user but withheld a session because email
   * confirmation is required — the PRD's "verification email with a 24h token".
   */
  readonly needsEmailVerification?: boolean;
  readonly error?: string;
  readonly code?: AuthErrorCode;
}

/** Human copy per code. Kept beside the mapping so they cannot drift apart. */
const ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  // PRD §3.1: never reveal whether the email exists.
  invalid_credentials: 'Email or password is incorrect.',
  email_not_confirmed: 'Confirm your email address before signing in.',
  user_already_exists: 'An account with that email already exists. Try signing in instead.',
  rate_limited: 'Too many attempts. Please wait a minute and try again.',
  weak_password: 'Choose a stronger password.',
  link_expired: 'That link has expired or has already been used. Request a new one.',
  network: 'Check your internet connection and try again.',
  unknown: 'Something went wrong. Please try again.',
};

const SUPABASE_CODE_MAP: Record<string, AuthErrorCode> = {
  invalid_credentials: 'invalid_credentials',
  email_not_confirmed: 'email_not_confirmed',
  user_already_exists: 'user_already_exists',
  email_exists: 'user_already_exists',
  over_email_send_rate_limit: 'rate_limited',
  over_request_rate_limit: 'rate_limited',
  over_sms_send_rate_limit: 'rate_limited',
  weak_password: 'weak_password',
  same_password: 'weak_password',
  otp_expired: 'link_expired',
  otp_disabled: 'link_expired',
  flow_state_expired: 'link_expired',
  flow_state_not_found: 'link_expired',
};

interface SupabaseLikeError {
  readonly message?: string;
  readonly code?: string;
  readonly status?: number;
  readonly name?: string;
}

function toFailure(error: unknown): AuthResult {
  const code = classify(error);
  return { ok: false, code, error: ERROR_MESSAGES[code] };
}

function classify(error: unknown): AuthErrorCode {
  if (error === null || typeof error !== 'object') return 'unknown';
  const candidate = error as SupabaseLikeError;
  const supabaseCode = candidate.code ?? '';
  const mapped = SUPABASE_CODE_MAP[supabaseCode];
  if (mapped !== undefined) return mapped;
  // Transport failures surface as a fetch TypeError on both platforms.
  if (/network request failed|fetch failed|failed to fetch/i.test(candidate.message ?? '')) {
    return 'network';
  }
  if (candidate.status === 429) return 'rate_limited';
  return 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Email + password
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create an account. `full_name` rides along in `raw_user_meta_data`, which the
 * `handle_new_user` trigger reads when it creates the `profiles` row — so the
 * profile exists before the client's first query, with no second round trip.
 *
 * When Supabase requires confirmation (the configured default), no session is
 * returned and the caller routes to the verify screen instead of the app.
 */
export async function signUpWithPassword(input: SignUpPayload): Promise<SignUpResult> {
  try {
    const { data, error } = await getSupabaseClient().auth.signUp({
      email: input.email,
      password: input.password,
      options: {
        data: { full_name: input.fullName },
        emailRedirectTo: AUTH_REDIRECT_PREFIX,
      },
    });
    if (error !== null) return { ...toFailure(error) };

    return { ok: true, needsEmailVerification: data.session === null };
  } catch (error: unknown) {
    return { ...toFailure(error) };
  }
}

/** Email + password sign-in. */
export async function signInWithPassword(email: string, password: string): Promise<AuthResult> {
  try {
    const { error } = await getSupabaseClient().auth.signInWithPassword({ email, password });
    // Session state flips via onAuthStateChange in session-sync.ts.
    return error === null ? { ok: true } : toFailure(error);
  } catch (error: unknown) {
    return toFailure(error);
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
    if (error !== null) return toFailure(error);
    if (data.url === undefined || data.url === null) {
      return { ok: false, code: 'unknown', error: 'Could not start Google sign-in.' };
    }

    const result = await WebBrowser.openAuthSessionAsync(data.url, AUTH_REDIRECT_PREFIX);
    if (result.type !== 'success') {
      return { ok: false, code: 'unknown', error: 'Google sign-in was cancelled.' };
    }
    // iOS hands back the final URL here; Android via the Linking listener.
    await handleAuthRedirectUrl(result.url);
    return { ok: true };
  } catch (error: unknown) {
    return toFailure(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Email verification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-send the signup confirmation email (PRD §3.1). Supabase rate-limits this
 * server-side; the UI additionally holds a 60 s cooldown so the limit is not
 * discovered by hitting it.
 */
export async function resendVerificationEmail(email: string): Promise<AuthResult> {
  try {
    const { error } = await getSupabaseClient().auth.resend({
      type: 'signup',
      email,
      options: { emailRedirectTo: AUTH_REDIRECT_PREFIX },
    });
    return error === null ? { ok: true } : toFailure(error);
  } catch (error: unknown) {
    return toFailure(error);
  }
}

/**
 * Re-read the current user from Supabase — the authoritative answer to "has the
 * email been confirmed yet?" (the confirmation may have happened in a mail
 * client on another device). Returns `ok: false` without touching the session
 * when the network is unavailable, so "still unverified" and "could not check"
 * stay distinguishable in the UI.
 */
export async function refreshCurrentUser(): Promise<AuthResult & { emailVerified?: boolean }> {
  try {
    const { data, error } = await getSupabaseClient().auth.getUser();
    if (error !== null) return toFailure(error);
    const confirmedAt = data.user?.email_confirmed_at ?? null;
    return { ok: true, emailVerified: confirmedAt !== null };
  } catch (error: unknown) {
    return toFailure(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Password reset
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send the password-recovery email. Calls the hosted reset flow, which
 * deep-links back with `type=recovery` (PRD §3.1: always the same generic
 * confirmation, regardless of whether the account exists).
 */
export async function sendPasswordReset(email: string): Promise<AuthResult> {
  try {
    const { error } = await getSupabaseClient().auth.resetPasswordForEmail(email, {
      redirectTo: AUTH_REDIRECT_PREFIX,
    });
    return error === null ? { ok: true } : toFailure(error);
  } catch (error: unknown) {
    return toFailure(error);
  }
}

/** Set a new password after the recovery flow (recovery session active). */
export async function updatePassword(newPassword: string): Promise<AuthResult> {
  try {
    const { error } = await getSupabaseClient().auth.updateUser({ password: newPassword });
    return error === null ? { ok: true } : toFailure(error);
  } catch (error: unknown) {
    return toFailure(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session termination
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Logout. `scope` maps onto the PRD's two different intents:
 *  - `local` (default) — this device only, for the ordinary "Log out" tap;
 *  - `global` — every session everywhere, which is what PRD §3.1 requires after
 *    a password reset ("invalidate all existing refresh tokens").
 */
export async function logout(scope: 'local' | 'global' = 'local'): Promise<AuthResult> {
  try {
    const { error } = await getSupabaseClient().auth.signOut({ scope });
    return error === null ? { ok: true } : toFailure(error);
  } catch (error: unknown) {
    return toFailure(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Incoming links
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What an incoming `societyexpense://auth/callback` URL turned out to be. The
 * caller routes on it; a URL that is not ours returns `ignored`.
 */
export type AuthLinkResult =
  | { readonly kind: 'oauth' | 'signup' | 'recovery' | 'email_change' }
  | { readonly kind: 'ignored' }
  | { readonly kind: 'error'; readonly error: string };

const LINK_KIND_BY_TYPE: Record<string, 'signup' | 'recovery' | 'email_change'> = {
  signup: 'signup',
  recovery: 'recovery',
  email_change: 'email_change',
};

/**
 * Handle an incoming auth deep link. Two shapes are supported, because email
 * templates can be configured either way:
 *
 *  1. `…?token_hash=…&type=signup` — the recommended template. Verified with
 *     `verifyOtp`, which is what actually establishes the session.
 *  2. `…#access_token=…&refresh_token=…&type=recovery` — Supabase's default
 *     fragment hand-off, restored with `setSession`.
 *
 * Both are idempotent: replaying a used link returns `error` with the
 * "expired or already used" copy rather than throwing.
 */
export async function handleAuthRedirectUrl(url: string): Promise<AuthLinkResult> {
  if (!url.startsWith(AUTH_REDIRECT_PREFIX)) return { kind: 'ignored' };

  const failure = readLinkError(url);
  if (failure !== null) return { kind: 'error', error: failure };

  const client = getSupabaseClient();
  const query = new URLSearchParams(url.slice(url.indexOf('?') + 1).split('#')[0] ?? '');
  const tokenHash = query.get('token_hash');
  const type = query.get('type') ?? readFragmentParam(url, 'type') ?? '';

  if (tokenHash !== null && tokenHash.length > 0) {
    const { error } = await client.auth.verifyOtp({
      token_hash: tokenHash,
      type: (isEmailOtpType(type) ? type : 'signup') satisfies EmailOtpType,
    });
    if (error !== null) return { kind: 'error', error: toFailure(error).error ?? '' };
    return { kind: LINK_KIND_BY_TYPE[type] ?? 'signup' };
  }

  const tokens = parseOAuthRedirect(url);
  if (tokens !== null) {
    await client.auth.setSession(tokens);
    return { kind: LINK_KIND_BY_TYPE[type] ?? 'oauth' };
  }

  // Reached when the link carried no credentials at all — treat the session
  // state as the answer rather than reporting a failure the user cannot act on.
  return { kind: 'ignored' };
}

function isEmailOtpType(value: string): value is EmailOtpType {
  return (
    value === 'signup' ||
    value === 'recovery' ||
    value === 'invite' ||
    value === 'magiclink' ||
    value === 'email_change' ||
    value === 'email'
  );
}

/** Expired/used links arrive as `error_code` + `error_description`. */
function readLinkError(url: string): string | null {
  const fragment = url.includes('#') ? url.slice(url.indexOf('#') + 1) : '';
  const query = url.includes('?') ? (url.slice(url.indexOf('?') + 1).split('#')[0] ?? '') : '';
  const params = new URLSearchParams(fragment.length > 0 ? fragment : query);
  const errorCode = params.get('error_code') ?? params.get('error');
  if (errorCode === null || errorCode.length === 0) return null;
  const mapped = SUPABASE_CODE_MAP[errorCode];
  return ERROR_MESSAGES[mapped ?? 'link_expired'];
}

function readFragmentParam(url: string, key: string): string | null {
  if (!url.includes('#')) return null;
  return new URLSearchParams(url.slice(url.indexOf('#') + 1)).get(key);
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
