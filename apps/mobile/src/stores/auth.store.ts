import type { Profile } from '@ses/contracts';
import { create } from 'zustand';

/**
 * Auth session state consumed by routing (SAD §5.1–§5.5).
 *
 * Fed exclusively by the Supabase bridge (`src/lib/supabase/session-sync.ts`)
 * and the profile bootstrap (`useSessionRestore`). Holds no SDK objects and no
 * tokens — the session itself persists inside the Supabase client's SecureStore
 * storage, keeping credentials out of zustand/MMKV (SAD §13.5).
 */
export type SessionStatus = 'restoring' | 'unauthenticated' | 'authenticated';

/**
 * `profileStatus` is separate from `status` on purpose: the session can be
 * perfectly valid while the profile row is still loading. Routing waits for
 * `ready` (or `error`) before reading `isComplete`, otherwise a slow profile
 * fetch would bounce the user into profile setup on every cold start.
 */
export type ProfileStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface AuthUser {
  readonly id: string;
  readonly email: string | null;
}

interface AuthState {
  readonly status: SessionStatus;
  readonly user: AuthUser | null;
  /** Mirrors `auth.users.email_confirmed_at` (PRD §3.1 verification gate). */
  readonly emailVerified: boolean;
  readonly profile: Profile | null;
  readonly profileStatus: ProfileStatus;

  /** Single write path from the session bridge. */
  applySession: (user: AuthUser | null, emailVerified?: boolean) => void;
  applyEmailVerified: (emailVerified: boolean) => void;
  applyProfile: (profile: Profile | null, status?: ProfileStatus) => void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  status: 'restoring',
  user: null,
  emailVerified: false,
  profile: null,
  profileStatus: 'idle',

  applySession: (user, emailVerified = false) =>
    set((state) => {
      if (user === null) {
        return {
          status: 'unauthenticated',
          user: null,
          emailVerified: false,
          profile: null,
          profileStatus: 'idle',
        };
      }
      // A different account signing in must not inherit the previous profile.
      const sameUser = state.user?.id === user.id;
      return {
        status: 'authenticated',
        user,
        emailVerified,
        profile: sameUser ? state.profile : null,
        profileStatus: sameUser ? state.profileStatus : 'loading',
      };
    }),

  applyEmailVerified: (emailVerified) => set({ emailVerified }),

  applyProfile: (profile, status = 'ready') => set({ profile, profileStatus: status }),
}));

export const selectSessionStatus = (state: AuthState): SessionStatus => state.status;
export const selectAuthUser = (state: AuthState): AuthUser | null => state.user;
export const selectEmailVerified = (state: AuthState): boolean => state.emailVerified;
export const selectProfile = (state: AuthState): Profile | null => state.profile;
export const selectProfileStatus = (state: AuthState): ProfileStatus => state.profileStatus;

/** The SAD §5.2 `profileComplete` flag, as computed by the database. */
export const selectIsProfileComplete = (state: AuthState): boolean =>
  state.profile?.isComplete === true;
