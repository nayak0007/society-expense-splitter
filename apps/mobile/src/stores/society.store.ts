import { asSocietyId } from '@ses/domain';
import type { SocietyId, SocietyMembership } from '@ses/domain';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { zustandStorage } from '@/lib/storage/mmkv';

/**
 * Society session store (SAD §5.2: `useSocietyStore` with `memberships` and
 * the last-used society; PRD §3.1: "`activeSocietyId` is held in a persisted
 * Zustand store and injected into every API call as a header and into every
 * query key").
 *
 * Split of concerns:
 *  - `memberships` is **server state** — it is fetched by React Query
 *    (`useSocietyBootstrap`) and mirrored here so the resolver can route
 *    synchronously on the first frame (SAD §5.2 "synchronous-first");
 *  - `activeSocietyId` and `pendingJoinCode` are **client state** and are
 *    persisted to MMKV.
 *
 * This store replaces `stores/ui.store.ts`, whose `activeSocietyId` was a
 * placeholder for exactly this state and had no consumers.
 */
export type SocietyLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface SocietyState {
  readonly memberships: readonly SocietyMembership[];
  readonly status: SocietyLoadStatus;
  readonly activeSocietyId: SocietyId | null;
  /** Set by the `societyexpense://join?code=…` deep link (PRD §3.2). */
  readonly pendingJoinCode: string | null;
  /** Single write path from the memberships query. */
  applyMemberships: (memberships: readonly SocietyMembership[]) => void;
  setStatus: (status: SocietyLoadStatus) => void;
  setActiveSocietyId: (societyId: SocietyId | null) => void;
  setPendingJoinCode: (code: string | null) => void;
}

export const useSocietyStore = create<SocietyState>()(
  persist(
    (set, get) => ({
      memberships: [],
      status: 'idle',
      activeSocietyId: null,
      pendingJoinCode: null,

      applyMemberships: (memberships) => {
        // Keep the active society valid: it must be one of the memberships we
        // can actually open, otherwise fall back to the first active one.
        const current = get().activeSocietyId;
        const stillValid =
          current !== null && memberships.some((membership) => membership.societyId === current);
        const fallback =
          memberships.find((membership) => membership.status === 'active')?.societyId ?? null;
        set({
          memberships,
          status: 'ready',
          activeSocietyId: stillValid ? current : fallback,
          pendingJoinCode: get().pendingJoinCode,
        });
      },

      setStatus: (status) => set({ status }),
      setActiveSocietyId: (societyId) => set({ activeSocietyId: societyId }),
      setPendingJoinCode: (code) => set({ pendingJoinCode: code }),
    }),
    {
      name: 'ses/society-store',
      storage: createJSONStorage(() => zustandStorage),
      // Only client-owned session identity persists; memberships are re-fetched.
      partialize: (state) => ({
        activeSocietyId: state.activeSocietyId,
        pendingJoinCode: state.pendingJoinCode,
      }),
    },
  ),
);

export const selectMemberships = (state: SocietyState): readonly SocietyMembership[] =>
  state.memberships;
export const selectSocietiesStatus = (state: SocietyState): SocietyLoadStatus => state.status;
export const selectActiveSocietyId = (state: SocietyState): SocietyId | null =>
  state.activeSocietyId;
export const selectPendingJoinCode = (state: SocietyState): string | null => state.pendingJoinCode;
export const selectActiveMembership = (state: SocietyState): SocietyMembership | null =>
  state.memberships.find((membership) => membership.societyId === state.activeSocietyId) ?? null;

/** Imperative read for non-React callers (deep-link handler, services). */
export function readSocietyState(): {
  readonly memberships: readonly SocietyMembership[];
  readonly activeSocietyId: SocietyId | null;
} {
  const { memberships, activeSocietyId } = useSocietyStore.getState();
  return { memberships, activeSocietyId };
}

export const toSocietyId = (value: string | null | undefined): SocietyId | null =>
  value === null || value === undefined || value.length === 0 ? null : asSocietyId(value);
