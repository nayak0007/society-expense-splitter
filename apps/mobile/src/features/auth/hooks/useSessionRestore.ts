import { useEffect } from 'react';
import { AppState } from 'react-native';

import { getSupabaseClient } from '@/lib/supabase/supabase.client';
import { clearSessionSnapshot, readSessionSnapshot } from '@/lib/storage/session-snapshot';
import { selectAuthUser, useAuthStore } from '@/stores/auth.store';

import { refreshCurrentUser } from '../api/auth.api';
import { ensureProfile } from '../api/profile.api';

/**
 * Session restoration and profile bootstrap (SAD §5.2, §9.2; Roadmap T029).
 *
 * Four jobs, in the order they must happen:
 *
 *  1. **First frame from the snapshot.** MMKV holds a non-sensitive snapshot
 *     (no tokens), read synchronously, so a returning user sees the app group
 *     rather than a splash flash. Supabase then confirms or refutes it.
 *  2. **Background validation.** `getSession()` + `getUser()` against Supabase.
 *     Only a *rejected* token (401/403) signs the user out — a network failure
 *     must never log someone out, which is why the two are distinguished.
 *  3. **Profile bootstrap.** Load the `profiles` row (creating it if the auth
 *     trigger missed this account) and mirror it into the store, which is what
 *     the resolver reads for `profileComplete`.
 *  4. **Foreground revalidation** (PRD §3.1 "silent refresh on app foreground",
 *     SAD §9.2). Refreshing is paused in the background, resumed on foreground,
 *     and the verification flag is re-read so a link confirmed on another device
 *     is picked up without a restart.
 */
export function useSessionRestore(): void {
  const userId = useAuthStore(selectAuthUser)?.id ?? null;
  const email = useAuthStore(selectAuthUser)?.email ?? null;

  // 1 — synchronous-first: paint the right group before the network answers.
  useEffect(() => {
    if (useAuthStore.getState().status !== 'restoring') return;
    const snapshot = readSessionSnapshot();
    if (snapshot === null) return;
    useAuthStore
      .getState()
      .applySession({ id: snapshot.userId, email: snapshot.email }, snapshot.emailVerified);
  }, []);

  // 2 — validate the real session, and only then trust it.
  useEffect(() => {
    let cancelled = false;

    const validate = async () => {
      const client = getSupabaseClient();
      const { data } = await client.auth.getSession();
      if (cancelled) return;

      if (data.session === null) {
        clearSessionSnapshot();
        useAuthStore.getState().applySession(null);
        return;
      }

      const { data: userData, error } = await client.auth.getUser();
      if (cancelled) return;

      if (error === null && userData.user !== null) {
        useAuthStore.getState().applyEmailVerified(userData.user.email_confirmed_at !== null);
        return;
      }

      // Rejected token (revoked, expired, family revoked elsewhere) → sign out.
      // Anything else (offline, 5xx) keeps the session: a flaky network is not
      // grounds to log someone out.
      const rejected = error?.status === 401 || error?.status === 403;
      if (!rejected) return;

      await client.auth.signOut({ scope: 'local' });
      clearSessionSnapshot();
      useAuthStore.getState().applySession(null);
    };

    void validate();
    return () => {
      cancelled = true;
    };
  }, []);

  // 3 — profile bootstrap on every session change.
  useEffect(() => {
    if (userId === null) return;
    let cancelled = false;

    useAuthStore.getState().applyProfile(null, 'loading');

    const load = async () => {
      try {
        const profile = await ensureProfile({ id: userId, email });
        if (cancelled) return;
        useAuthStore.getState().applyProfile(profile);
        // The profile mirrors auth.users confirmation state, so this is also
        // the cheapest way to keep the verification flag fresh.
        useAuthStore.getState().applyEmailVerified(profile.emailVerified);
      } catch {
        if (cancelled) return;
        useAuthStore.getState().applyProfile(null, 'error');
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [userId, email]);

  // 4 — foreground: resume refresh timers and re-read verification state.
  useEffect(() => {
    const client = getSupabaseClient();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void client.auth.startAutoRefresh();
        void refreshCurrentUser().then((result) => {
          if (result.ok && result.emailVerified !== undefined) {
            useAuthStore.getState().applyEmailVerified(result.emailVerified);
          }
        });
        return;
      }
      void client.auth.stopAutoRefresh();
    });
    return () => {
      subscription.remove();
    };
  }, []);
}
