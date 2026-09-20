/**
 * React Query key factory for the society feature.
 *
 * Every key is scoped by the signed-in user (and detail keys by society), so
 * a cached reply can never be served to the wrong tenant — the client-side
 * mirror of `SocietyGuard` on the server (SAD §1.1).
 */
export const societyKeys = {
  all: ['society'] as const,
  /** Presentation rows for the user's societies — what `useSocieties` reads. */
  list: (userId: string | null) => ['society', 'list', userId] as const,
  memberships: (userId: string | null) => ['society', 'memberships', userId] as const,
  detail: (societyId: string | null, userId: string | null) =>
    ['society', 'detail', societyId, userId] as const,
  joinPreview: (code: string) => ['society', 'join-preview', code] as const,
};
