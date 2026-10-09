/**
 * The device's held resolved-participant snapshot — the input the offline preview runs
 * over (T075 §5).
 *
 * ## What this is, and the gap it records
 *
 * An offline split may only run over an **exact** T063 resolution: the participating
 * flats, the member each is addressed to, and the apartment facts a basis weighs. The
 * API's `POST /expenses/preview-split` returns allocations and warnings but **not** the
 * resolution's facts (areas, BHK, floor, share units), so no existing endpoint lets the
 * client capture the snapshot offline preview needs. Until one does, nothing populates
 * this holder, and {@link import('./../split/offline-preview').offlineUnavailableReason}
 * returns its "no resolved participant snapshot" reason — the explicit "Offline preview
 * unavailable" state, never a fabricated bill.
 *
 * ## Why it is a store and not a fetch
 *
 * The moment a snapshot *is* obtained (a future read route, or a cached preview
 * response that carries the facts), it must be the **exact** resolution for the active
 * society and selector, held for a bounded time. This holder is that seam: a producer
 * sets it, the preview hook reads it, and the availability gate decides whether it is
 * usable. A test fabricates one directly to exercise the engine path.
 */

import type { OfflineParticipantSnapshot } from '../split/offline-preview';

let snapshot: OfflineParticipantSnapshot | null = null;

/** The snapshot currently held on the device, or `null`. */
export function readOfflineSnapshot(): OfflineParticipantSnapshot | null {
  return snapshot;
}

/**
 * Record a resolved snapshot.
 *
 * Deliberately the only writer, and deliberately not wired to anything yet: the honest
 * state of the product is that no client path can produce one, so the offline fallback
 * shows its unavailable reason rather than guessing (T075 §5). A future producer — a
 * resolution read route — calls this after a successful resolution.
 */
export function setOfflineSnapshot(next: OfflineParticipantSnapshot | null): void {
  snapshot = next;
}

/** Test seam. */
export function resetOfflineSnapshot(): void {
  snapshot = null;
}
