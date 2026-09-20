import { router } from 'expo-router';

import { clearSessionSnapshot, writeSessionSnapshot } from '@/lib/storage/session-snapshot';
import { useAuthStore, type AuthUser } from '@/stores/auth.store';

import { getSupabaseClient } from './supabase.client';

/**
 * One-way bridge: Supabase auth events → zustand auth store.
 *
 * The rest of the app (resolver SAD §5.2, group guard §5.5) consumes only the
 * store's `status`/`user`, so the SDK never leaks past the adapter boundary
 * (§1.2 principle 3) and the store stays testable without a Supabase project.
 *
 * Side effects, both deliberate:
 *  - the MMKV session snapshot is written here, so a cold start can paint the
 *    right group on the first frame (SAD §5.2);
 *  - `PASSWORD_RECOVERY` routes straight to the reset screen. Supabase emits it
 *    when a recovery link is handled by the SDK; recovery links our own deep-link
 *    handler processes are routed by `features/auth/services/auth-deep-link.ts`
 *    instead, so both paths land in the same place.
 */

type MinimalUser = {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
};
type MinimalSession = { user: MinimalUser } | null;

function toAuthUser(session: MinimalSession): AuthUser | null {
  if (session === null) return null;
  return { id: session.user.id, email: session.user.email ?? null };
}

function isEmailVerified(session: MinimalSession): boolean {
  if (session === null) return false;
  return session.user.email_confirmed_at !== null && session.user.email_confirmed_at !== undefined;
}

let teardown: (() => void) | null = null;
let watchdog: ReturnType<typeof setTimeout> | null = null;

/** Idempotent; call once from AppProviders. Returns a cleanup function. */
export function startSessionSync(): () => void {
  if (teardown !== null) return teardown;

  // If the persisted session cannot be resolved within 8s (cold start
  // offline can be slow), fall back to unauthenticated rather than splash-
  // locking the user. A late INITIAL_SESSION still flips the store.
  watchdog = setTimeout(() => {
    if (useAuthStore.getState().status === 'restoring') {
      useAuthStore.getState().applySession(null);
    }
  }, 8000);

  const {
    data: { subscription },
  } = getSupabaseClient().auth.onAuthStateChange((event, session) => {
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }

    const user = toAuthUser(session);
    const emailVerified = isEmailVerified(session);
    useAuthStore.getState().applySession(user, emailVerified);

    if (user === null) {
      clearSessionSnapshot();
    } else {
      writeSessionSnapshot({ userId: user.id, email: user.email, emailVerified });
    }

    // Password-recovery deep links land here with a session attached;
    // route the user to choose a new password.
    if (event === 'PASSWORD_RECOVERY') {
      router.replace('/(auth)/reset-password');
    }
  });

  teardown = () => {
    subscription.unsubscribe();
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    teardown = null;
  };
  return teardown;
}
