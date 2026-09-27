import type { SocietyId, UserId } from "../shared/ids";

import type {
  CreateSocietyInput,
  JoinSocietyInput,
  Society,
  SocietyJoinOptions,
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

  /**
   * Every membership of one society, as seen by `actor`.
   *
   * Needed by the rules that are about the *society*, not about the caller:
   * "a society can never be left without an active admin" requires knowing who
   * else holds the admin role. A non-member receives `not_found` (never an empty
   * array, which would confirm the society exists).
   */
  listSocietyMemberships(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly SocietyMembership[]>;

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

  /**
   * The flats a join code's society offers the join screen, narrowed by a search term
   * (T049; PRD §3.2's "select building/wing/flat from the actual apartment list").
   *
   * Keyed by the **code**, not by the society id, and that is the authorisation rather
   * than a convenience: the requester is not a member yet, so no policy can serve the read
   * — the code is what grants the ability to join at all, and an id-addressed variant would
   * be an enumeration endpoint for anyone who guessed one.
   *
   * An unknown or dead code is `join_code_invalid` — the same answer `findJoinPreview`
   * gives, so the join screen has one string for "no such society". Expiry is *not* judged
   * here, exactly as in the preview: the domain evaluates it against the injected clock so
   * a code that expires between two requests does not produce two different answers.
   */
  joinOptions(
    rawCode: string,
    query: {
      readonly query?: string | undefined;
      readonly limit?: number | undefined;
    },
    actor: UserId,
  ): Promise<SocietyJoinOptions>;

  /**
   * Ask to join with a code (PRD §3.2: "never auto-approve").
   *
   * The row it writes is this module's and the member module's at once — a pending
   * membership is the join request (see `@ses/domain`'s `join-requests.ts`) — which is why
   * the write lives here: the join code is the credential, and the code is a society.
   */
  join(input: JoinSocietyInput, actor: UserId): Promise<SocietyMembership>;

  leave(id: SocietyId, actor: UserId): Promise<void>;
}
