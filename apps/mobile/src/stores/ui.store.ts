import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { zustandStorage } from '@/lib/storage/mmkv';

/**
 * UI/session store — the first persisted zustand store; it establishes the
 * pattern every other store copies (SAD §4.2 stores/, PRD §3.1).
 *
 * `activeSocietyId` is the multi-society session selector: it will be
 * injected into every API call as a header and into every query key once the
 * API client lands. Persisted so the app reopens into the last-used society.
 *
 * State + actions in one store; selectors exported separately so components
 * subscribe to the narrowest slice possible.
 */
interface UiState {
  activeSocietyId: string | null;
  lastOpenedAt: number | null;
  setActiveSociety: (societyId: string | null) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      activeSocietyId: null,
      lastOpenedAt: null,
      setActiveSociety: (societyId) =>
        set({ activeSocietyId: societyId, lastOpenedAt: Date.now() }),
    }),
    {
      name: 'ses/ui-store',
      storage: createJSONStorage(() => zustandStorage),
      // Only session identity persists; anything transient is excluded.
      partialize: (state) => ({ activeSocietyId: state.activeSocietyId }),
    },
  ),
);

export const selectActiveSocietyId = (state: UiState): string | null => state.activeSocietyId;
