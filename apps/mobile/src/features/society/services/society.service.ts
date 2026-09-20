import { createSocietySchema, joinSocietySchema, updateSocietySchema } from '@ses/contracts';
import type {
  CreateSocietyPayload,
  JoinSocietyPayload,
  UpdateSocietyPayload,
} from '@ses/contracts';
import {
  SocietyError,
  asSocietyId,
  asUserId,
  isSocietyError,
  normalizeJoinCode,
} from '@ses/domain';
import type { Society, SocietyJoinPreview, SocietyMembership } from '@ses/domain';
import type { ZodError } from 'zod';

import { useSocietyStore } from '@/stores/society.store';

import { getSocietyRepository } from '../repository/society.repository';

/**
 * Society service = use cases (Clean Architecture: screens and hooks talk to
 * this layer only; only this layer talks to the repository and the store).
 *
 * Every function:
 *  1. validates its input against the shared contract (`packages/contracts`)
 *     — the same schema the API will apply, so a rule cannot drift;
 *  2. calls the repository through the port;
 *  3. applies the session side effects (active society, pending invite).
 *
 * Failures are thrown as `SocietyError` with a stable `code` and a
 * user-readable message, so hooks surface them directly and the API can later
 * map codes onto HTTP status.
 */

/** Memberships of the signed-in user — the resolver routes on this list. */
export async function loadMemberships(actorId: string): Promise<readonly SocietyMembership[]> {
  return getSocietyRepository().listMemberships(asUserId(actorId));
}

export async function loadSociety(societyId: string, actorId: string): Promise<Society | null> {
  return getSocietyRepository().findById(asSocietyId(societyId), asUserId(actorId));
}

/**
 * Create a society. The creator becomes its Admin (PRD §3.2) and it becomes
 * the active society — there is nothing sensible to look at otherwise.
 */
export async function createSociety(
  actorId: string,
  payload: CreateSocietyPayload,
): Promise<Society> {
  const parsed = createSocietySchema.safeParse(payload);
  if (!parsed.success) {
    throw new SocietyError('validation', firstIssueMessage(parsed.error));
  }
  const { society } = await getSocietyRepository().create(parsed.data, asUserId(actorId));
  useSocietyStore.getState().setActiveSocietyId(society.id);
  return society;
}

export async function updateSociety(
  actorId: string,
  societyId: string,
  patch: UpdateSocietyPayload,
): Promise<Society> {
  const parsed = updateSocietySchema.safeParse(patch);
  if (!parsed.success) {
    throw new SocietyError('validation', firstIssueMessage(parsed.error));
  }
  return getSocietyRepository().update(asSocietyId(societyId), parsed.data, asUserId(actorId));
}

export async function regenerateJoinCode(actorId: string, societyId: string): Promise<Society> {
  return getSocietyRepository().regenerateJoinCode(asSocietyId(societyId), asUserId(actorId));
}

/** Destroys the tenant. Admin-only; the repository enforces it. */
export async function deleteSociety(actorId: string, societyId: string): Promise<void> {
  await getSocietyRepository().remove(asSocietyId(societyId), asUserId(actorId));
  dropLocalMembership(societyId);
}

/** Public preview for a join code — no write, safe to call while typing. */
export async function previewJoin(rawCode: string): Promise<SocietyJoinPreview | null> {
  const code = normalizeJoinCode(rawCode);
  if (code.length === 0) return null;
  return getSocietyRepository().findJoinPreview(code);
}

export async function joinSociety(
  actorId: string,
  payload: JoinSocietyPayload,
): Promise<SocietyMembership> {
  const parsed = joinSocietySchema.safeParse(payload);
  if (!parsed.success) {
    throw new SocietyError('validation', firstIssueMessage(parsed.error));
  }
  const membership = await getSocietyRepository().join(
    { code: parsed.data.code, occupancyType: parsed.data.occupancyType },
    asUserId(actorId),
  );

  const store = useSocietyStore.getState();
  store.setPendingJoinCode(null);
  // A pending request must not hijack the session; only an approved join does.
  if (membership.status === 'active') {
    store.setActiveSocietyId(membership.societyId);
  }
  return membership;
}

export async function leaveSociety(actorId: string, societyId: string): Promise<void> {
  await getSocietyRepository().leave(asSocietyId(societyId), asUserId(actorId));
  dropLocalMembership(societyId);
}

/**
 * Drops a membership from the in-memory session immediately, so leaving or
 * deleting routes correctly on the next frame instead of waiting for the
 * memberships query to refetch. The refetch then reconciles with the server.
 */
function dropLocalMembership(societyId: string): void {
  const store = useSocietyStore.getState();
  const remaining = store.memberships.filter((membership) => membership.societyId !== societyId);
  if (store.activeSocietyId === societyId) {
    store.setActiveSocietyId(null);
  }
  store.applyMemberships(remaining);
}

function firstIssueMessage(error: ZodError): string {
  return error.issues[0]?.message ?? 'Please check the details and try again.';
}

/**
 * Error → copy the UI can render. `SocietyError` messages are written for
 * users; anything else is an unexpected failure and gets a safe generic line.
 */
export function societyErrorMessage(error: unknown): string {
  if (isSocietyError(error)) return error.message;
  return 'Something went wrong. Please try again.';
}
