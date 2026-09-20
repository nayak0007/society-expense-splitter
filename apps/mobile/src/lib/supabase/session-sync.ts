import { router } from 'expo-router';

import { useAuthStore, type AuthUser } from '@/stores/auth.store';

import { getSupabaseClient } from './supabase.client';

/**
 * One-way bridge: Supabase auth events → zustand auth store.
 *
 * The rest of the app (resolver SAD §5.2, group guard §5.5) consumes only the
 * store's `status`/`user`, so the SDK never leaks past the adapter boundary
 * (§1.2 principle 3) and the store stays testable without a Supabase project.
 */

type MinimalSession = { user: { id: string; email?: string | null } } | null;

function toAuthUser(session: MinimalSession): AuthUser | null {
  if (session === null) return null;
  return { id: session.user.id, email: session.user.email ?? null };
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
    useAuthStore.getState().applySession(toAuthUser(session));

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
