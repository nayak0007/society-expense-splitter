/**
 * React Query key factory for the structure feature.
 *
 * Every key carries **both** the society and the signed-in user. The society is
 * what the data belongs to and the user is who may read it, so a cached reply can
 * never be served to the wrong tenant or the wrong session — the client-side
 * mirror of `SocietyGuard` and RLS (SAD §1.1). Leaving the user out is the usual
 * mistake: it looks harmless while there is one session per install, and serves a
 * previous user's structure the first time the app is switched accounts without a
 * reload.
 */
export const buildingKeys = {
  all: ['building'] as const,
  /** Presentation rows for one society — what `useBuildings` reads. */
  list: (societyId: string | null, userId: string | null) =>
    ['building', 'list', societyId, userId] as const,
  detail: (buildingId: string | null, societyId: string | null, userId: string | null) =>
    ['building', 'detail', societyId, buildingId, userId] as const,
};
