import { useSyncExternalStore } from 'react';

import { readSplitWorkspace, subscribeSplitWorkspace } from '../services/split-config.store';
import type { SplitWorkspace } from '../services/split-config.store';

/**
 * Subscribe to the split workspace for a scope key (T075 §2).
 *
 * `useSyncExternalStore` rather than a `useState` + effect: the store is module-level
 * and shared across routes, so the form and a pushed configurator must observe the
 * *same* value, and a torn read between two state copies is exactly the bug a shared
 * store exists to prevent. `readSplitWorkspace` returns a stable reference until a
 * write replaces it, so the snapshot never churns.
 *
 * `null` for a key of `null` (no session or no society) — the caller renders the
 * unavailable state rather than a workspace nobody can address.
 */
export function useSplitWorkspace(key: string | null): SplitWorkspace | null {
  const subscribe = (listener: () => void): (() => void) => subscribeSplitWorkspace(key, listener);
  const getSnapshot = (): SplitWorkspace | null => readSplitWorkspace(key);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
