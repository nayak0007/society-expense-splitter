import { create } from 'zustand';

/**
 * Auth session state consumed by routing (SAD §5.1–§5.5).
 *
 * Fed exclusively by `src/lib/supabase/session-sync.ts` (the Supabase→store
 * bridge). Holds no SDK objects and no tokens — the session itself persists
 * inside the Supabase client's SecureStore storage, keeping credentials out
 * of zustand/MMKV (SAD §13.5).
 */
export type SessionStatus = 'restoring' | 'unauthenticated' | 'authenticated';

export interface AuthUser {
  readonly id: string;
  readonly email: string | null;
}

interface AuthState {
  readonly status: SessionStatus;
  readonly user: AuthUser | null;
  /** Single write path from the session bridge. */
  applySession: (user: AuthUser | null) => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  status: 'restoring',
  user: null,
  applySession: (user) =>
    set(
      user === null ? { status: 'unauthenticated', user: null } : { status: 'authenticated', user },
    ),
}));

export const selectSessionStatus = (state: AuthState): SessionStatus => state.status;
export const selectAuthUser = (state: AuthState): AuthUser | null => state.user;
