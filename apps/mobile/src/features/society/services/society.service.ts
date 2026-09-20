import {
  createSociety as createSocietyUseCase,
  deleteSociety as deleteSocietyUseCase,
  joinSociety as joinSocietyUseCase,
  leaveSociety as leaveSocietyUseCase,
  listSocietySummaries as listSocietySummariesUseCase,
  regenerateJoinCode as regenerateJoinCodeUseCase,
  updateSociety as updateSocietyUseCase,
} from '@ses/application';
import type { SocietyDeps } from '@ses/application';
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
  systemClock,
} from '@ses/domain';
import type {
  Result,
  Society,
  SocietyJoinPreview,
  SocietyMembership,
  SocietySummary,
} from '@ses/domain';
import type { ZodError } from 'zod';

import { useSocietyStore } from '@/stores/society.store';

import { getSocietyRepository } from '../repository/society.repository';

/**
 * Society service — the app's adapter over the application layer.
 *
 * Screens and hooks talk to this file; this file talks to `@ses/application`;
 * `@ses/application` talks to the repository port. Three things belong here and
 * nowhere else:
 *
 *  1. **Wire-shape validation.** Every payload is parsed against the shared
 *     contract (`packages/contracts`) before a use case sees it — the same schema
 *     the API will apply, so a rule cannot drift between the two.
 *  2. **`Result` → throw.** Use cases return `Result`, because a library must not
 *     decide how a caller reports failure. The app's hooks are written against
 *     thrown `SocietyError`s, so the conversion happens once, here.
 *  3. **Session side effects.** Which society is active, and whether a pending
 *     join code is still outstanding, are facts about *this device's session* —
 *     not business rules, so they live above the application layer.
 *
 * Everything else — the capability checks, the sole-admin invariant, the join
 * code's expiry, value-object validation — is deliberately NOT re-implemented
 * here. It lives in the use cases, which the API will call too (see
 * `packages/application/src/index.ts`).
 *
 * Failures surface as `SocietyError` with a stable `code` and a user-readable
 * message, so hooks render them directly and the API can later map codes onto
 * HTTP status.
 */

/**
 * The application layer's dependencies, resolved per call.
 *
 * `getSocietyRepository()` is a lazily-built composition root (importing this
 * module must not construct a Supabase client) and `systemClock` is the app's
 * real clock. Both are *injected* rather than imported by the use cases — which
 * is what keeps `@ses/application` free of any dependency on this app, and lets
 * the API supply its own clock and repositories.
 */
function societyDeps(): SocietyDeps {
  return { repository: getSocietyRepository(), clock: systemClock };
}

/**
 * `Result` → value, or throw. One place, so every caller of this service gets a
 * `SocietyError` and no screen ever inspects `.ok`.
 */
function unwrap<TValue>(result: Result<TValue, SocietyError>): TValue {
  if (!result.ok) throw result.error;
  return result.value;
}

/** Memberships of the signed-in user — the resolver routes on this list. */
export async function loadMemberships(actorId: string): Promise<readonly SocietyMembership[]> {
  return getSocietyRepository().listMemberships(asUserId(actorId));
}

export async function loadSociety(societyId: string, actorId: string): Promise<Society | null> {
  return getSocietyRepository().findById(asSocietyId(societyId), asUserId(actorId));
}

/**
 * The signed-in user's societies as presentation rows — name, city, type, the
 * caller's role and membership status, member count (PRD §3.1: the switcher).
 *
 * This runs the application layer's `listSocietySummaries` use case rather than
 * reading the repository, because a summary is a *view*: it joins a membership row
 * with the society it points at, and a society that cannot be read is skipped
 * instead of failing the whole list (a removed society must not break the list).
 *
 * Distinct from `loadMemberships`, which returns the raw membership rows the
 * router needs — see the note in the read hooks.
 */
export async function loadSocietySummaries(actorId: string): Promise<readonly SocietySummary[]> {
  return unwrap(await listSocietySummariesUseCase(societyDeps(), asUserId(actorId)));
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

  const created = unwrap(await createSocietyUseCase(societyDeps(), asUserId(actorId), parsed.data));
  addLocalMembership(created.membership);
  return created.society;
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

  return unwrap(
    await updateSocietyUseCase(
      societyDeps(),
      asUserId(actorId),
      asSocietyId(societyId),
      parsed.data,
    ),
  );
}

export async function regenerateJoinCode(actorId: string, societyId: string): Promise<Society> {
  return unwrap(
    await regenerateJoinCodeUseCase(societyDeps(), asUserId(actorId), asSocietyId(societyId)),
  );
}

/** Destroys the tenant. Admin-only; the use case enforces it. */
export async function deleteSociety(actorId: string, societyId: string): Promise<void> {
  unwrap(await deleteSocietyUseCase(societyDeps(), asUserId(actorId), asSocietyId(societyId)));
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

  const membership = unwrap(
    await joinSocietyUseCase(societyDeps(), asUserId(actorId), parsed.data),
  );

  const store = useSocietyStore.getState();
  store.setPendingJoinCode(null);
  // A pending request must not hijack the session; only an approved join does.
  if (membership.status === 'active') {
    store.setActiveSocietyId(membership.societyId);
  }
  return membership;
}

/** Leaves a society, or withdraws a pending request. */
export async function leaveSociety(actorId: string, societyId: string): Promise<void> {
  unwrap(await leaveSocietyUseCase(societyDeps(), asUserId(actorId), asSocietyId(societyId)));
  dropLocalMembership(societyId);
}

/**
 * Records a membership in the in-memory session immediately. The routing guard
 * (`(app)/_layout.tsx`) reads this list synchronously, so without it a screen that
 * navigates straight after a write is bounced back to onboarding: the redirect
 * happens on the next frame, while the memberships query is still refetching.
 *
 * Symmetric with `dropLocalMembership` below, and the same argument applies — the
 * store is the routing snapshot, and a write we just performed is a fact we do not
 * need the network to confirm. The refetch then reconciles with the server.
 */
function addLocalMembership(membership: SocietyMembership): void {
  const store = useSocietyStore.getState();
  const others = store.memberships.filter((row) => row.societyId !== membership.societyId);
  // Active society first: `applyMemberships` preserves a still-valid active id
  // instead of falling back, so the society just created stays selected.
  store.setActiveSocietyId(membership.societyId);
  store.applyMemberships([...others, membership]);
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
