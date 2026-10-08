import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

/**
 * Periodic local autosave for a form (SAD §6.4: `useAutosaveDraft(form, 'expense', 3000)`).
 *
 * ## What it does, and what it deliberately does not
 *
 * It writes the **current values** through the caller's `write` every `intervalMs`, and flushes
 * once when the app goes to the background, because a phone is killed from the app switcher and
 * the last three seconds of typing are exactly what would be lost. It does **not** hydrate: the
 * caller reads its draft *before* the first render and uses it as the form's default values, which
 * is the only ordering that cannot overwrite a restored draft with empty defaults.
 *
 * ## Why the write is conditional
 *
 * A tick with nothing changed is a synchronous disk write for no reason — on a form the user has
 * not touched, every three seconds, forever. The hook keeps the last serialised snapshot and skips
 * an unchanged one, so a resumed-but-untouched draft is never rewritten and a keystroke burst
 * produces one write per interval rather than per character.
 *
 * ## Why the interval is a real interval and not a debounce
 *
 * "Draft autosaved every 3 s" is a bound on how much typing can be lost, not a delay after the
 * last keystroke — a treasurer who types continuously for a minute must still have a draft on disk
 * at every three-second mark. (`mode: 'onBlur'` stays the *validation* mode; the two are separate
 * concerns.)
 */
export interface UseAutosaveDraftOptions<TValue> {
  /**
   * Reads the current values.
   *
   * A getter rather than a value, and deliberately so: taking the values as a prop would force
   * the caller to re-render on every keystroke (RHF's `watch()`), which is exactly the cost SAD
   * §6.4 chose uncontrolled inputs to avoid. The caller subscribes imperatively and this hook
   * polls that subscription every interval — one write per interval, no render per character.
   */
  readonly read: () => TValue;
  /** Persists the snapshot. The caller owns the key, the scope and the storage. */
  write: (values: TValue) => void;
  /** Interval in ms. Defaults to SAD §6.4's 3000. */
  readonly intervalMs?: number;
  /** `false` suspends writing — while submitting, or before a session exists. */
  readonly enabled?: boolean;
}

export interface AutosaveDraftResult {
  /** ISO instant of the last successful write this session, or `null`. */
  readonly lastSavedAt: string | null;
  /** Write immediately, whatever the interval says. */
  save: () => void;
}

export function useAutosaveDraft<TValue>({
  read,
  write,
  intervalMs = 3000,
  enabled = true,
}: UseAutosaveDraftOptions<TValue>): AutosaveDraftResult {
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  // Refs, not dependencies: the interval must be installed once per enabled period. Re-creating
  // it on every keystroke would reset the timer, which is precisely the debounce this is not.
  const readRef = useRef(read);
  readRef.current = read;
  const writeRef = useRef(write);
  writeRef.current = write;

  const written = useRef<string | null>(null);
  const save = (): void => {
    const values = readRef.current();
    let snapshot: string;
    try {
      snapshot = JSON.stringify(values);
    } catch {
      return;
    }
    if (snapshot === written.current) return;
    written.current = snapshot;
    writeRef.current(values);
    setLastSavedAt(new Date().toISOString());
  };

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(save, intervalMs);
    return () => clearInterval(timer);
    // `save` is stable enough: it reads refs, and the interval is intentionally not re-created
    // for a new value.
  }, [enabled, intervalMs]);

  useEffect(() => {
    if (!enabled) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') save();
    });
    return () => subscription.remove();
  }, [enabled]);

  return { lastSavedAt, save };
}
