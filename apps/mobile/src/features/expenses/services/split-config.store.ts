/**
 * The split editor's route-safe workspace — T075 §2.
 *
 * ## Why a store rather than navigation parameters
 *
 * The configurator and the participant selector are **separate routes**, so returning
 * from one to the parent form has to carry an edited configuration back without an
 * expense being created or updated on the server, and without a large participant
 * snapshot travelling through a deep-link URL. A module-level store keyed by the same
 * scope the draft uses (`user`/`society`/`expense`) is the mechanism: the parent form
 * writes the live context (amount, category, the category's default strategy), the
 * child routes read and mutate the configuration, and neither passes anything by value.
 *
 * ## Framework-free on purpose
 *
 * Like `expense-draft.store.ts`, this module holds no React and no storage: it is the
 * in-session channel, keyed to the same isolation boundary (the draft key) so one
 * member's half-configured split can never surface in another member's form. Its
 * durability comes from the draft: the form's autosave persists the configuration to
 * MMKV beside every other field, and `useExpenseForm` seeds this store from the draft
 * on mount. A remount therefore reads the store (still warm) or the draft (after a
 * cold start), and either way nothing is lost — which is the acceptance test
 * "draft restoration after remount".
 */

import type { SplitStrategy } from '@ses/domain';

import { emptySplitState, defaultSelector } from '../schemas/split.schemas';
import type { SplitFormState } from '../schemas/split.schemas';

/** The facts the parent form publishes to the editor, refreshed on every render. */
export interface SplitContext {
  readonly amountPaise: number | null;
  readonly categoryId: string | null;
  /** The selected category's default strategy, or `null` when none is known. */
  readonly defaultStrategy: SplitStrategy | null;
}

export interface SplitWorkspace {
  readonly state: SplitFormState;
  readonly context: SplitContext;
}

type Listener = () => void;

interface Entry {
  workspace: SplitWorkspace;
  readonly listeners: Set<Listener>;
}

const entries = new Map<string, Entry>();

const EMPTY_CONTEXT: SplitContext = {
  amountPaise: null,
  categoryId: null,
  defaultStrategy: null,
};

function freshWorkspace(): SplitWorkspace {
  return { state: emptySplitState(), context: EMPTY_CONTEXT };
}

/**
 * The workspace for a key, or `null` when there is none.
 *
 * A key of `null` means the scope cannot address a workspace (no session or no
 * society) — the same refusal `expenseDraftKey` makes, and for the same reason: a
 * configuration nobody can name must not be shared between users.
 */
export function readSplitWorkspace(key: string | null): SplitWorkspace | null {
  if (key === null) return null;
  return entries.get(key)?.workspace ?? null;
}

/**
 * Seed a workspace for a key, creating it on first use.
 *
 * `initial` is applied **only** when no entry exists: an existing workspace is returned
 * unchanged. That is what lets the form seed from the draft once — and lets a screen seed a
 * cold deep-link entry — without a later call stomping a configuration the configurator has
 * since written. Changing a live workspace is `updateSplitState`/`updateSplitContext`'s job,
 * which say so explicitly at the call site.
 */
export function ensureSplitWorkspace(
  key: string,
  initial: Partial<SplitWorkspace> = {},
): SplitWorkspace {
  const existing = entries.get(key);
  if (existing !== undefined) return existing.workspace;

  const entry: Entry = {
    workspace: {
      state: initial.state ?? freshWorkspace().state,
      context: initial.context ?? EMPTY_CONTEXT,
    },
    listeners: new Set(),
  };
  entries.set(key, entry);
  return entry.workspace;
}

/** Replace the configuration, leaving the context untouched. */
export function updateSplitState(key: string, patch: Partial<SplitFormState>): void {
  const entry = ensureEntry(key);
  entry.workspace = { ...entry.workspace, state: { ...entry.workspace.state, ...patch } };
  notify(entry);
}

/** Replace the context the parent form publishes, leaving the configuration untouched. */
export function updateSplitContext(key: string, patch: Partial<SplitContext>): void {
  const entry = ensureEntry(key);
  entry.workspace = {
    ...entry.workspace,
    context: { ...entry.workspace.context, ...patch },
  };
  notify(entry);
}

/** Reset the configuration, keeping the current context. Used on an explicit discard. */
export function resetSplitState(key: string, state: SplitFormState = emptySplitState()): void {
  const entry = ensureEntry(key);
  entry.workspace = { ...entry.workspace, state };
  notify(entry);
}

/** Drop a workspace entirely — on a confirmed save or an explicit discard. */
export function clearSplitWorkspace(key: string | null): void {
  if (key === null) return;
  const entry = entries.get(key);
  if (entry === undefined) return;
  notify(entry);
  entries.delete(key);
}

/** Subscribe to changes for a key; returns the unsubscribe. */
export function subscribeSplitWorkspace(key: string | null, listener: Listener): () => void {
  if (key === null) return () => undefined;
  const entry = ensureEntry(key);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

/** Fan a change out to every subscriber of one key. */
function notify(entry: Entry): void {
  for (const listener of entry.listeners) listener();
}

function ensureEntry(key: string): Entry {
  let entry = entries.get(key);
  if (entry === undefined) {
    entry = { workspace: freshWorkspace(), listeners: new Set() };
    entries.set(key, entry);
  }
  return entry;
}

/** Test seam: forget every workspace. */
export function resetAllSplitWorkspaces(): void {
  entries.clear();
}

export { defaultSelector };
