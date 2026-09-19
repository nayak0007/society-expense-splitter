import { create } from 'zustand';

/**
 * NAVIGATION-PHASE SESSION STUB — deliberately NOT authentication.
 *
 * This store only carries the routing state the resolver (SAD §5.2) and the
 * (app) group guard (§5.5) read. There are no tokens, no API calls and no
 * credential handling here. Phase 2 (auth) replaces `signIn`/`signOut` with
 * `useSessionRestore` (SecureStore → refresh → /auth/me); the rest of the
 * app never notices because it only consumes `status`.
 *
 * Not persisted: a fake session must not survive an app restart.
 */
export type SessionStatus = 'restoring' | 'unauthenticated' | 'authenticated';

interface AuthState {
  readonly status: SessionStatus;
  /** Ends the cold-start restore; no session source exists yet, so the only
   *  outcome is `unauthenticated`. Phase 2 makes this async and real. */
  restore: () => void;
  /** Navigation demo only — the login placeholder calls this. */
  signIn: () => void;
  /** Navigation demo only — the More tab calls this. */
  signOut: () => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  status: 'restoring',
  restore: () =>
    set((state) => (state.status === 'restoring' ? { status: 'unauthenticated' } : state)),
  signIn: () => set({ status: 'authenticated' }),
  signOut: () => set({ status: 'unauthenticated' }),
}));

export const selectSessionStatus = (state: AuthState): SessionStatus => state.status;
