import type { SocietyId, SocietyMembership, StructureMembershipReader, UserId } from '@ses/domain';

import { readSocietyState } from '@/stores/society.store';

/**
 * `StructureMembershipReader` over the session's membership snapshot.
 *
 * ## Why the store, and not a request
 *
 * The structure use cases ask exactly one question of this port: *what is the
 * caller's role in this society?* — and the answer is already in memory.
 * `useSocietyStore.memberships` is fed by `useSocietyBootstrap` from
 * `GET /v1/societies/memberships`, which the API scopes to the JWT, and it is the
 * same snapshot the router and `RequirePermission` already gate on. A network
 * round trip here would be a second read of a value the app is holding, on every
 * building request, to answer a question the local copy answers first.
 *
 * ## What this reader is not
 *
 * It is **not** an authorisation boundary, and its staleness cannot widen access.
 * The API's `SocietyGuard` resolves the membership from the database in the same
 * request that acts on it, `PermissionGuard` evaluates the permission against
 * that row, and RLS re-checks membership underneath — three layers that never read
 * this store. A snapshot that is out of date can therefore only do one of two
 * things: hide an affordance the server would have allowed (the user retries after
 * the memberships refetch), or offer one the server refuses with the honest
 * `403`/`404` this module maps. It cannot grant anything.
 *
 * ## Why the port is implemented here rather than by importing the society slice
 *
 * `StructureMembershipReader`'s own docstring records this for the API: the
 * adapter belongs to the module that owns the data, because a second copy of the
 * membership translation is a second place for a role to be read wrongly. On the
 * mobile side the equivalent of "the module that owns the data" is this store —
 * shared infrastructure, not a feature — so the reader stays inside the structure
 * slice without a cross-feature import (`eslint` bans those, and correctly: a
 * feature reaching into a sibling's `hooks/` is how two slices become one).
 *
 * ## `actor` is ignored, and why that is safe
 *
 * The snapshot holds only the signed-in user's memberships — the endpoint behind
 * it is actor-scoped by the token, and no other user's rows are ever written into
 * it. Filtering by `actor` again would be checking that the store is what it says
 * it is, on every call.
 */
export class SessionStructureMembershipReader implements StructureMembershipReader {
  async findMembership(societyId: SocietyId, _actor: UserId): Promise<SocietyMembership | null> {
    const { memberships } = readSocietyState();
    return memberships.find((membership) => membership.societyId === societyId) ?? null;
  }
}
