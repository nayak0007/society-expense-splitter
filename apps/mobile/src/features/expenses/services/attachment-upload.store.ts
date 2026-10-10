/**
 * The in-flight upload register — Roadmap T076 (audit §7/§8).
 *
 * ## Why a store, and why framework-free
 *
 * An upload outlives the screen that started it: the scanner navigates back, the form
 * is replaced by the detail screen, and the PUT keeps running. React state cannot
 * survive that, and a `useState` in the scanner would strand a half-uploaded file the
 * moment the user taps Back. So the register is a module-level value — the same shape
 * `split-config.store.ts` uses — and screens *read* it through
 * `useSyncExternalStore`.
 *
 * ## Explicit states, not a boolean
 *
 * The audit asked for the upload to be modelled as `Selected → Preparing → Ready →
 * Reserving → Uploading → Confirming → Completed | Failed`, and the reason is
 * recovery rather than tidiness: **a retry must resume at the step that failed.**
 * A reservation (which created a server row) is not resendable — replaying it forges a
 * second reservation and a second bill — while a PUT is, and a completion is a designed
 * no-op. The `step` field is what makes that distinction possible; a single `isFailed`
 * flag would force the retry to start from the beginning and duplicate the reservation.
 *
 * ## Scope isolation
 *
 * Every item carries `scope = "{societyId}:{userId}"`. Switching society or signing out
 * abandons that scope's items (`clearScope`), so a half-finished bill from one tenant can
 * never be completed into another — the client-side mirror of `X-Society-Id` and RLS.
 *
 * ## Staged files: the unsaved-expense path
 *
 * A new expense has no id until it is saved, and the presign route needs a persisted
 * parent. So a file picked from the create form is **staged** (`expenseId === null`): it
 * is prepared and held locally, and `bindStagedToExpense` adopts it once the expense is
 * created. Nothing is reserved before then — which is what keeps a cancelled new expense
 * from leaving reservations behind.
 */

/** The seven-step lifecycle the audit asks for, plus `completed`. */
export type AttachmentUploadState =
  | 'selected'
  | 'preparing'
  | 'ready'
  | 'reserving'
  | 'uploading'
  | 'confirming'
  | 'completed'
  | 'failed';

/** The step a retry resumes from. `prepare` re-runs compression; `reserve` re-mints. */
export type AttachmentUploadStep = 'prepare' | 'reserve' | 'upload' | 'confirm';

export interface AttachmentUpload {
  /** Session-unique local key — the identity a screen and a retry both address. */
  readonly key: string;
  /** `"{societyId}:{userId}"` — the tenant/session this item belongs to. */
  readonly scope: string;
  /** The parent expense, or `null` while the file is staged for an unsaved one. */
  readonly expenseId: string | null;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksum: string | null;
  /** The local `file://` URI of the exact bytes to upload. Never sent anywhere else. */
  readonly uri: string;
  readonly isImage: boolean;
  readonly width: number | null;
  readonly height: number | null;
  readonly state: AttachmentUploadState;
  readonly step: AttachmentUploadStep;
  /** 0–1, from the native uploader's own byte count. */
  readonly progress: number;
  readonly attachmentId: string | null;
  readonly error: string | null;
  /**
   * The outstanding reservation, kept so a failed PUT can be retried against the **same**
   * URL instead of minting a second one.
   *
   * These three fields are a live credential: the upload URL, its expiry and the signature's
   * headers. They are held **in memory only** — never written to MMKV, never logged, never
   * rendered — and they are cleared by the next reservation. Re-reserving is the fallback
   * when the URL has expired; reusing it is the default, because a second reservation is a
   * second server row and a second bill.
   */
  readonly reservation: AttachmentReservation | null;
}

/** The outstanding presigned PUT, as the store remembers it. A secret; see above. */
export interface AttachmentReservation {
  readonly uploadUrl: string;
  readonly expiresAt: string;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

/** The fields a new item is created with (the mutable ones default to their start). */
export interface NewAttachmentUpload {
  readonly scope: string;
  readonly expenseId: string | null;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly checksum: string | null;
  readonly uri: string;
  readonly isImage: boolean;
  readonly width: number | null;
  readonly height: number | null;
  readonly state: AttachmentUploadState;
  readonly step: AttachmentUploadStep;
}

type Listener = () => void;

const items = new Map<string, AttachmentUpload>();
const listeners = new Set<Listener>();
const aborters = new Map<string, AbortController>();

let sequence = 0;
/** Rebuilt on every mutation so React sees one stable reference between changes. */
let snapshot: readonly AttachmentUpload[] = [];

function rebuild(): void {
  snapshot = Object.freeze([...items.values()]);
}

function notify(): void {
  rebuild();
  for (const listener of listeners) listener();
}

/** Every item, in insertion order. The reference changes only on a mutation. */
export function uploadsSnapshot(): readonly AttachmentUpload[] {
  return snapshot;
}

export function subscribeUploads(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The items of one scope and expense (or its staged items when `expenseId` is null). */
export function listUploads(
  scope: string | null,
  expenseId: string | null,
): readonly AttachmentUpload[] {
  if (scope === null) return [];
  return snapshot.filter((item) => item.scope === scope && item.expenseId === expenseId);
}

/** One item by key, or `null`. */
export function readUpload(key: string): AttachmentUpload | null {
  return items.get(key) ?? null;
}

/**
 * Add an item and return its key.
 *
 * The generator is a monotonic counter rather than the file name: two bills really can
 * both be `bill.jpg`, and a key derived from the name would make the second one
 * address the first one's progress.
 */
export function createUpload(input: NewAttachmentUpload): string {
  sequence += 1;
  const key = `upload-${String(sequence)}`;
  items.set(key, {
    key,
    ...input,
    progress: 0,
    attachmentId: null,
    error: null,
    reservation: null,
  });
  notify();
  return key;
}

/** Merge a patch into an item. Unknown keys are ignored rather than throwing. */
export function patchUpload(key: string, patch: Partial<AttachmentUpload>): void {
  const current = items.get(key);
  if (current === undefined) return;
  items.set(key, { ...current, ...patch, key });
  notify();
}

/** Move an item to `failed`, remembering the step a retry resumes from. */
export function failUpload(key: string, step: AttachmentUploadStep, error: string): void {
  const current = items.get(key);
  if (current === undefined) return;
  items.set(key, { ...current, state: 'failed', step, error, progress: 0 });
  notify();
}

/** Drop one item, aborting any transport still attached to it. */
export function removeUpload(key: string): void {
  aborters.get(key)?.abort();
  aborters.delete(key);
  if (items.delete(key)) notify();
}

/** Abort and drop every item of a scope — the society/user switch path. */
export function clearScope(scope: string): void {
  let changed = false;
  for (const [key, item] of items) {
    if (item.scope !== scope) continue;
    aborters.get(key)?.abort();
    aborters.delete(key);
    items.delete(key);
    changed = true;
  }
  if (changed) notify();
}

/** Abort and drop every item of every scope except the one given. */
export function abandonOtherScopes(scope: string): void {
  let changed = false;
  for (const [key, item] of items) {
    if (item.scope === scope) continue;
    aborters.get(key)?.abort();
    aborters.delete(key);
    items.delete(key);
    changed = true;
  }
  if (changed) notify();
}

/**
 * Adopt every staged item of a scope onto a freshly created expense.
 *
 * Called once the create form has a persisted id. It returns the adopted items so the
 * caller can upload exactly those, and it never touches items already bound to another
 * expense — a staged file belongs to one draft and cannot be double-attached.
 */
export function bindStagedToExpense(scope: string, expenseId: string): readonly AttachmentUpload[] {
  const adopted: AttachmentUpload[] = [];
  for (const [key, item] of items) {
    if (item.scope !== scope || item.expenseId !== null) continue;
    const next: AttachmentUpload = { ...item, expenseId, state: 'ready', progress: 0, error: null };
    items.set(key, next);
    adopted.push(next);
  }
  if (adopted.length > 0) notify();
  return adopted;
}

/** The staged items of a scope, oldest first. */
export function listStaged(scope: string | null): readonly AttachmentUpload[] {
  return listUploads(scope, null);
}

/**
 * True when an equivalent file is already being handled for this expense.
 *
 * The duplicate-tap guard: the fingerprint is the checksum when there is one (the same
 * bytes under a different name is the same upload) and the URI otherwise. A `completed`
 * item is not "in flight", so re-attaching the same bill after a success is allowed.
 */
export function hasActiveUpload(
  scope: string,
  expenseId: string | null,
  fingerprint: { readonly uri: string; readonly checksum: string | null },
): boolean {
  return snapshot.some(
    (item) =>
      item.scope === scope &&
      item.expenseId === expenseId &&
      item.state !== 'completed' &&
      item.state !== 'failed' &&
      (fingerprint.checksum !== null
        ? item.checksum === fingerprint.checksum
        : item.uri === fingerprint.uri),
  );
}

/** Attach an `AbortController` to an item, so a cancel or a scope switch can stop it. */
export function registerUploadAbort(key: string, controller: AbortController): void {
  aborters.get(key)?.abort();
  aborters.set(key, controller);
}

/** Stop an in-flight upload for one item without dropping the item. */
export function abortUpload(key: string): void {
  aborters.get(key)?.abort();
}

/** Release the controller once a run has settled. */
export function releaseUploadAbort(key: string): void {
  aborters.delete(key);
}

/** Test seam: forget every item and every listener. */
export function resetAllUploads(): void {
  for (const controller of aborters.values()) controller.abort();
  aborters.clear();
  items.clear();
  sequence = 0;
  snapshot = [];
  listeners.clear();
}
