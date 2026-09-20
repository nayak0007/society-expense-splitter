import {
  profileBootstrapSchema,
  profileFromRow,
  profileRowSchema,
  profileUpdateSchema,
} from '@ses/contracts';
import type { Profile, ProfileUpdatePayload } from '@ses/contracts';

import { getSupabaseClient } from '@/lib/supabase/supabase.client';

/**
 * `public.profiles` integration (the app-facing half of Supabase Auth identity;
 * see `supabase/migrations/20260920120000_auth_profiles.sql`).
 *
 * Two rules shape every function here:
 *
 *  1. **Rows are validated, not trusted.** Without generated database types,
 *     PostgREST data is untyped; parsing it through `profileRowSchema` keeps a
 *     column rename or a nullable surprise from reaching the UI as `undefined`.
 *  2. **RLS is the boundary, not this layer.** Every query is scoped to the
 *     signed-in user and the policies enforce it independently — a bug here
 *     cannot read another user's profile.
 */

const TABLE = 'profiles';

const PROFILE_COLUMNS =
  'id, email, phone, full_name, avatar_url, locale, status, email_verified_at, phone_verified_at, is_profile_complete, created_at, updated_at, deleted_at';

/** Current profile row, or `null` when it does not exist yet. */
export async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await getSupabaseClient()
    .from(TABLE)
    .select(PROFILE_COLUMNS)
    .eq('id', userId)
    .maybeSingle();

  if (error !== null) throw new Error(profileErrorMessage(error));
  if (data === null || data === undefined) return null;

  const parsed = profileRowSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error('Unexpected profile shape returned by Supabase.');
  }
  return profileFromRow(parsed.data);
}

/**
 * Load the profile, creating it if the `on_auth_user_created` trigger has not
 * (a user created by an admin before the migration ran, or a restore from a
 * partial backup). The insert is pinned to `auth.uid()` by RLS, so this can only
 * ever create the caller's own row — it is a self-healing path, not a backdoor.
 */
export async function ensureProfile(input: {
  readonly id: string;
  readonly email: string | null;
  readonly fullName?: string | null;
}): Promise<Profile> {
  const existing = await fetchProfile(input.id);
  if (existing !== null) return existing;

  const payload = profileBootstrapSchema.safeParse({
    id: input.id,
    email: input.email,
    fullName: input.fullName ?? null,
  });
  if (!payload.success) {
    throw new Error('Could not build a profile for this account.');
  }

  const { error } = await getSupabaseClient()
    .from(TABLE)
    .insert({
      id: payload.data.id,
      email: payload.data.email,
      full_name: payload.data.fullName ?? null,
    });

  // A concurrent writer (the trigger, or a previous attempt) may have won the
  // race; that is not an error, so re-read before giving up.
  if (error !== null) {
    const retry = await fetchProfile(input.id);
    if (retry !== null) return retry;
    throw new Error(profileErrorMessage(error));
  }

  const created = await fetchProfile(input.id);
  if (created === null) throw new Error('Profile was created but could not be read back.');
  return created;
}

/**
 * Update the fields a client is allowed to write. Deliberately cannot touch
 * `email`, `phone`, `status` or the verification timestamps: those follow
 * Supabase Auth's own verified state (contract `profileUpdateSchema` and the
 * column grants in the RLS migration both enforce it).
 */
export async function saveProfile(userId: string, patch: ProfileUpdatePayload): Promise<Profile> {
  const parsed = profileUpdateSchema.safeParse(patch);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'Those details are not valid.');
  }

  const update: Record<string, unknown> = {};
  if (parsed.data.fullName !== undefined) update.full_name = parsed.data.fullName;
  if (parsed.data.locale !== undefined) update.locale = parsed.data.locale;
  if (parsed.data.avatarUrl !== undefined) update.avatar_url = parsed.data.avatarUrl;

  if (Object.keys(update).length === 0) {
    throw new Error('Nothing to update.');
  }

  const { data, error } = await getSupabaseClient()
    .from(TABLE)
    .update(update)
    .eq('id', userId)
    .select(PROFILE_COLUMNS)
    .single();

  if (error !== null) throw new Error(profileErrorMessage(error));

  const row = profileRowSchema.safeParse(data);
  if (!row.success) throw new Error('Unexpected profile shape returned by Supabase.');
  return profileFromRow(row.data);
}

/** PostgREST/Postgres error → copy the UI can render. */
export function profileErrorMessage(error: unknown): string {
  const candidate = error as { code?: string; message?: string } | null;
  const code = candidate?.code ?? '';
  if (code === '42501' || /permission denied|row-level security/i.test(candidate?.message ?? '')) {
    return 'Your account is not allowed to change that.';
  }
  if (code === 'PGRST301' || /JWT|token/i.test(candidate?.message ?? '')) {
    return 'Your session expired. Please sign in again.';
  }
  return 'Could not save your profile. Check your connection and try again.';
}
