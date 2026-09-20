import type { SocietyId, UserId } from "../shared/ids";

import type {
  CreateSocietyInput,
  JoinSocietyInput,
  Society,
  SocietyJoinPreview,
  SocietyMembership,
  UpdateSocietyInput,
} from "./society";

/**
 * Society repository port (Clean Architecture: the domain declares what it
 * needs, infrastructure implements it — package description: "entities, value
 * objects, ports").
 *
 * Two deliberate properties:
 *  - every method takes `actor` explicitly, so tenant scope can never be
 *    inferred from ambient state (SAD §1.1: scope comes from token +
 *    membership, never from the request body);
 *  - everything is async, so the in-memory mock used until the API exists
 *    (Phase 3 is API-coupled) can be swapped for the HTTP implementation
 *    without touching a single caller.
 *
 * Implementations MUST return `null`/throw `SocietyError('not_found')` for a
 * society the actor is not a member of — never `forbidden`, which would leak
 * the existence of another tenant's data (PRD T041).
 */
export interface SocietyRepository {
  /** Memberships of `actor`, newest first — drives the switcher. */
  listMemberships(actor: UserId): Promise<readonly SocietyMembership[]>;

  /** Full society for a member of it, `null` otherwise. */
  findById(id: SocietyId, actor: UserId): Promise<Society | null>;

  /** Public preview for a join code (PRD §3.2: name, city, member count). */
  findJoinPreview(code: string): Promise<SocietyJoinPreview | null>;

  create(
    input: CreateSocietyInput,
    actor: UserId,
  ): Promise<{
    readonly society: Society;
    readonly membership: SocietyMembership;
  }>;

  update(
    id: SocietyId,
    input: UpdateSocietyInput,
    actor: UserId,
  ): Promise<Society>;

  /** Admin-only regeneration of the join code (PRD §3.2). */
  regenerateJoinCode(id: SocietyId, actor: UserId): Promise<Society>;

  remove(id: SocietyId, actor: UserId): Promise<void>;

  join(input: JoinSocietyInput, actor: UserId): Promise<SocietyMembership>;

  leave(id: SocietyId, actor: UserId): Promise<void>;
}
