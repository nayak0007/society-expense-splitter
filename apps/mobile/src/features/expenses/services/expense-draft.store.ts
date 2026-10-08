/**
 * The expense form's local draft (Roadmap T074, SAD §6.4's `useAutosaveDraft`).
 *
 * ## Why MMKV and not the outbox
 *
 * SAD §6.4 names `draftStore` written to MMKV every three seconds, and the SQLite outbox of
 * §6.6/§12 belongs to Roadmap Phase 9 — `src/lib/db` and `src/lib/sync` are still README-only.
 * A draft is *not* a queued mutation: it is unsent text with no server-side existence, so it
 * belongs in the key-value store the app already uses for UI state, and the write is synchronous
 * (which is what makes "kill the app between keystrokes" survivable).
 *
 * ## The key is the isolation boundary
 *
 * A draft is scoped by the **signed-in user**, the **active society** and the **expense** (or
 * `new`). All three are in the key, so one member's half-typed bill can never surface in another
 * member's form, and two societies cannot see each other's — the client-side mirror of the rule
 * every query key already carries. With no session or no society there is no key at all, and the
 * store refuses rather than writing a draft nobody can address.
 *
 * ## A stored draft is *read*, never trusted
 *
 * The record is re-validated on the way out, against the draft's **shape** rather than the form's
 * rules: a draft written by an older build (a field since renamed, a type since changed) is dropped
 * rather than loaded into a form that cannot render it, while a half-typed draft — which is not a
 * valid *submission* and never will be — is restored, because that is the whole point of keeping it.
 * JSON here crosses a version boundary (the app's own), so it gets the same treatment a wire
 * payload gets.
 *
 * ## Staleness in edit mode
 *
 * A draft of an existing expense records the **server version it was based on**. If the expense
 * has moved on since — someone else recalculated it, or the same user saved it on another device
 * — the draft is stale, and the screen says so and offers the server's row instead of silently
 * re-applying an edit against a version that no longer exists.
 */

import { mmkvStorage } from '@/lib/storage/mmkv';

import { expenseDraftValuesSchema } from '../schemas/expense-form.schemas';
import type { ExpenseFormValues } from '../schemas/expense-form.schemas';

/** Which draft this is. `expenseId: null` means the create form. */
export interface ExpenseDraftScope {
  readonly userId: string | null;
  readonly societyId: string | null;
  readonly expenseId: string | null;
}

/** One stored draft. */
export interface ExpenseDraftRecord {
  readonly values: ExpenseFormValues;
  /** The server version the values were based on; `null` for a create draft. */
  readonly basedOnVersion: number | null;
  readonly savedAt: string;
}

/**
 * The key for a scope, or `null` when the scope cannot address a draft.
 *
 * The `ses/` prefix is this app's persisted-key convention (`src/lib/storage`), and the segments
 * are ordered from the widest scope to the narrowest so a future cleanup pass can walk one
 * society or one expense. The expense segment is `new` rather than an empty string, so a create
 * draft is visible as such in the store.
 */
export function expenseDraftKey(scope: ExpenseDraftScope): string | null {
  if (scope.userId === null || scope.societyId === null) return null;
  return `ses/expense-draft/${scope.societyId}/${scope.expenseId ?? 'new'}/${scope.userId}`;
}

/**
 * Read the draft for a scope, or `null`.
 *
 * A malformed or obsolete record is deleted as it is refused, so a build that changed the form's
 * shape does not pay to re-parse a dead record on every mount.
 */
export function readExpenseDraft(scope: ExpenseDraftScope): ExpenseDraftRecord | null {
  const key = expenseDraftKey(scope);
  if (key === null) return null;

  const stored = mmkvStorage.getString(key);
  if (stored === undefined || stored.length === 0) return null;

  try {
    const parsed = JSON.parse(stored) as {
      readonly values?: unknown;
      readonly basedOnVersion?: unknown;
      readonly savedAt?: unknown;
    };
    const values = expenseDraftValuesSchema.safeParse(parsed.values);
    if (!values.success) {
      clearExpenseDraft(scope);
      return null;
    }
    return {
      values: values.data,
      basedOnVersion:
        typeof parsed.basedOnVersion === 'number' && Number.isInteger(parsed.basedOnVersion)
          ? parsed.basedOnVersion
          : null,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
    };
  } catch {
    // Not JSON at all — nothing here can be recovered, and leaving it would fail forever.
    clearExpenseDraft(scope);
    return null;
  }
}

/** Persist a draft. `basedOnVersion` is the loaded expense's version, or `null` on create. */
export function writeExpenseDraft(
  scope: ExpenseDraftScope,
  values: ExpenseFormValues,
  basedOnVersion: number | null,
  now: Date = new Date(),
): ExpenseDraftRecord | null {
  const key = expenseDraftKey(scope);
  if (key === null) return null;

  const record: ExpenseDraftRecord = {
    values,
    basedOnVersion,
    savedAt: now.toISOString(),
  };
  mmkvStorage.set(key, JSON.stringify(record));
  return record;
}

/**
 * Delete a draft.
 *
 * Called on a **confirmed** successful submission and on an explicit discard — never on unmount.
 * Navigating away from a half-filled form must leave the draft in place; that is the feature, and
 * a cleanup-on-unmount would silently destroy the one thing autosave exists for.
 */
export function clearExpenseDraft(scope: ExpenseDraftScope): void {
  const key = expenseDraftKey(scope);
  if (key === null) return;
  mmkvStorage.remove(key);
}

/**
 * True when a stored draft no longer matches the expense it was based on.
 *
 * `null` means "not applicable" rather than "stale": a create draft has no server version to be
 * behind, and an unknown one (a draft written before versions were recorded) is treated as
 * applicable so the user's text is not thrown away by a fact the app never stored.
 */
export function isDraftStale(draft: ExpenseDraftRecord, currentVersion: number | null): boolean {
  if (draft.basedOnVersion === null || currentVersion === null) return false;
  return draft.basedOnVersion !== currentVersion;
}
