import { asSocietyError, err, ok } from "@ses/domain";
import type { Result, SocietyMembership, UserId } from "@ses/domain";

import type { SocietyDeps } from "./support";

/**
 * The caller's own memberships, newest first.
 *
 * Distinct from `listSocietySummaries`, which is the switcher's *rendering* shape
 * and pays one extra read per society to join in the name, city and member count.
 * This is the raw membership — `{ id, societyId, userId, role, status,
 * occupancyType, joinedAt }` — for callers that need the relationship itself
 * rather than a row to draw. `GET /societies` used to be the only way to answer
 * "which societies am I in?" and its summary lacks the membership's own id and
 * the caller's occupancy, so a client could not reconstruct the port's
 * `SocietyMembership` from it without inventing fields.
 *
 * No rule of its own: scope comes from `actor` into the query, and RLS enforces
 * the same boundary again underneath, so a wrong `actor` yields an empty list
 * rather than someone else's rows.
 */
export async function listMemberships(
  deps: SocietyDeps,
  actor: UserId,
): Promise<
  Result<readonly SocietyMembership[], ReturnType<typeof asSocietyError>>
> {
  try {
    return ok(await deps.repository.listMemberships(actor));
  } catch (error: unknown) {
    return err(asSocietyError(error));
  }
}
