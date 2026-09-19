import { createMMKV } from 'react-native-mmkv';
import type { StateStorage } from 'zustand/middleware';

/**
 * App-wide MMKV instance (SAD §4.2: src/lib/storage/mmkv.ts).
 *
 * MMKV v4 (Nitro) is a synchronous key-value store backed by mmap — used for
 * UI state, drafts, and the persisted zustand stores. Auth tokens NEVER go
 * here; they belong in expo-secure-store (src/lib/storage/secure.ts, lands
 * with auth in Phase 2) because MMKV is unencrypted and readable on a rooted
 * device.
 */
export const mmkvStorage = createMMKV({ id: 'ses-app-storage' });

/**
 * Zustand's `StateStorage` (string values) bridged onto MMKV.
 * Used as `storage: createJSONStorage(() => zustandStorage)` inside any
 * persisted store — one implementation, every store reuses it.
 */
export const zustandStorage: StateStorage = {
  setItem: (key, value) => {
    mmkvStorage.set(key, value);
  },
  getItem: (key) => {
    const value = mmkvStorage.getString(key);
    return value ?? null;
  },
  removeItem: (key) => {
    mmkvStorage.remove(key);
  },
};
