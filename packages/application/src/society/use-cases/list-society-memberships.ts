import { asSocietyError, err, ok } from "@ses/domain";
import type { Result, SocietyId, SocietyMembership, UserId } from "@ses/domain";

import type { SocietyDeps } from "./support";

/**
 * Every membership of one society, as `actor` may see it.
 *
 * The authority check is deliberately **not** repeated here: the port's contract
 * is that a non-member receives `not_found` — never an empty array, which would
 * confirm the society exists (PRD T041) — and the repository derives that from
 * the read itself, because a roster an active member can see always contains the
 * caller. Re-deciding it in this layer would be a second implementation of a rule
 * that already holds in the SQL, and the two would eventually disagree about
 * pending members, who are shown the roster they applied to.
 *
 * `loadSocietyContext` is the heavier alternative and is wrong for this route: it
 * also reads the whole society and computes capabilities, which a roster does not
 * need.
 */
export async function listSocietyMemberships(
  deps: SocietyDeps,
  actor: UserId,
  societyId: SocietyId,
): Promise<
  Result<readonly SocietyMembership[], ReturnType<typeof asSocietyError>>
> {
  try {
    return ok(await deps.repository.listSocietyMemberships(societyId, actor));
  } catch (error: unknown) {
    return err(asSocietyError(error));
  }
}
