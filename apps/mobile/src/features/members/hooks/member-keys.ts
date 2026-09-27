import type { MemberDirectoryFilters } from '../services/member.service';

/**
 * React Query key factory for the member directory.
 *
 * Every key carries **both** the society and the signed-in user, for the reason
 * `building-keys.ts` records in full: the society is what the data belongs to and the user is
 * who may read it, so a cached reply can never be served to the wrong tenant or the wrong
 * session — the client-side mirror of `SocietyGuard` and RLS (SAD §1.1).
 *
 * ## The filters are part of the key, and are canonicalised first
 *
 * A directory is a *filtered* list, so two pages of it are two different answers: a cache
 * keyed on the society alone would serve "all members" to a screen that asked for the pending
 * ones. The filters go through `serializeMemberFilters` rather than being dropped into the
 * key as an object, so a screen that rebuilds an identical filter object on every render
 * still hits the same entry — React Query hashes an object key by its contents, and a
 * canonical string makes that explicit rather than incidental.
 */
export function serializeMemberFilters(filters: MemberDirectoryFilters): string {
  const parts: string[] = [];
  const push = (key: string, value: string | number | undefined): void => {
    if (value === undefined || value === '') return;
    parts.push(`${key}=${String(value)}`);
  };

  push('q', filters.q);
  push('role', filters.role);
  push('status', filters.status);
  push('occupancy', filters.occupancy);
  push('buildingId', filters.buildingId ?? undefined);
  push('apartmentId', filters.apartmentId ?? undefined);
  push('sort', filters.sort);
  push('limit', filters.limit);
  push('offset', filters.offset);

  return parts.join('&');
}

export const memberKeys = {
  all: ['member'] as const,
  /** One page of the directory, for one set of filters — what `useMembers` reads. */
  list: (societyId: string | null, userId: string | null, filters: MemberDirectoryFilters) =>
    ['member', 'list', societyId, userId, serializeMemberFilters(filters)] as const,
  detail: (memberId: string | null, societyId: string | null, userId: string | null) =>
    ['member', 'detail', societyId, memberId, userId] as const,
  /**
   * The caller's own membership.
   *
   * Not a child of the detail key: it is not addressed by a member id, and a screen that
   * edited its own row would wrongly invalidate it if the two shared a prefix.
   */
  viewer: (societyId: string | null, userId: string | null) =>
    ['member', 'viewer', societyId, userId] as const,
  /**
   * One page of the join queue (T049).
   *
   * A child of the `member` namespace on purpose: a decision admits somebody, which changes
   * what the directory and the viewer's own counts return, so one invalidation has to reach
   * all of them. The page is part of the key because the queue is paginated.
   */
  joinQueue: (societyId: string | null, userId: string | null, page: number) =>
    ['member', 'join-queue', societyId, userId, page] as const,
};

/**
 * React Query keys for roles and permissions (T046).
 *
 * A sibling of `memberKeys` rather than children of it, and that is not cosmetic: they belong to
 * the same namespace deliberately — a role change invalidates both — while their *shapes* differ.
 * A permissions answer is not a member row and a catalogue is not a page of the directory, so
 * giving them `['member', …]` prefixes lets one `invalidateQueries({ queryKey: memberKeys.all })`
 * refresh all three, which is exactly what a role write owes the screens around it.
 *
 * Both the society and the signed-in user travel in every key, for the reason `member-keys.ts`
 * records: a cached permissions answer served to another session or another tenant would be a
 * client-side hole in a rule the server enforces per request.
 */
export const permissionKeys = {
  /** The role catalogue — `GET /v1/permissions`, one answer per society. */
  catalogue: (societyId: string | null, userId: string | null) =>
    ['member', 'permissions', 'catalogue', societyId, userId] as const,
  /** The caller's own effective permissions. */
  mine: (societyId: string | null, userId: string | null) =>
    ['member', 'permissions', 'me', societyId, userId] as const,
  /** One member's effective permissions, keyed by the membership id. */
  forMember: (memberId: string | null, societyId: string | null, userId: string | null) =>
    ['member', 'permissions', 'member', societyId, memberId, userId] as const,
};
