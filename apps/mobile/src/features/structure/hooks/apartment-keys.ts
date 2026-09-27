/**
 * React Query key factory for the flat feature.
 *
 * Every key carries **both** the society and the signed-in user, for the reason
 * `building-keys.ts` records in full: the society is what the data belongs to and
 * the user is who may read it, so a cached reply can never be served to the wrong
 * tenant or the wrong session — the client-side mirror of `SocietyGuard` and RLS
 * (SAD §1.1).
 *
 * Every key also carries the **parent building**, which the building keys have no
 * equivalent of: a flat is only meaningful inside its building, so a list of
 * `"A-101"` cached without the building it belongs to would be served to whichever
 * building the user navigated to next. It is a separate namespace from
 * `buildingKeys` rather than a child key of it, because the two are invalidated for
 * different reasons and a shared prefix would make every flat write refetch the
 * building list.
 */
export const apartmentKeys = {
  all: ['apartment'] as const,
  /** Presentation rows for one building — what `useApartments` reads. */
  list: (buildingId: string | null, societyId: string | null, userId: string | null) =>
    ['apartment', 'list', societyId, buildingId, userId] as const,
  detail: (apartmentId: string | null, societyId: string | null, userId: string | null) =>
    ['apartment', 'detail', societyId, apartmentId, userId] as const,
};
