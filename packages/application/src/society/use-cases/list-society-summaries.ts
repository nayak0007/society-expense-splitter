import { asSocietyError, err, ok } from "@ses/domain";
import type { Result, SocietySummary, UserId } from "@ses/domain";

import type { SocietyDeps } from "./support";

/**
 * The society switcher's data (PRD §3.1: "Multiple → Society Switcher").
 *
 * One `listMemberships` call, then a detail read per membership. That is an N+1
 * by construction and it is acceptable here for a specific reason: the list is
 * bounded by how many societies *one person* belongs to — a handful, never a
 * page — and the alternative (a repository method returning memberships joined
 * with society columns) would push a read model into the port that the API will
 * express as a single SQL join anyway. If a user ever belongs to dozens of
 * societies, the right change is a batched `findManyByIds` on the port, and this
 * is the one call site to update.
 *
 * A membership whose society cannot be read is skipped rather than failing the
 * whole list: a removed or deleted society must not make the switcher unusable.
 */
export async function listSocietySummaries(
  deps: SocietyDeps,
  actor: UserId,
): Promise<
  Result<readonly SocietySummary[], ReturnType<typeof asSocietyError>>
> {
  try {
    const memberships = await deps.repository.listMemberships(actor);
    const summaries: SocietySummary[] = [];

    for (const membership of memberships) {
      const society = await deps.repository.findById(
        membership.societyId,
        actor,
      );
      if (society === null) continue;

      summaries.push({
        id: society.id,
        name: society.name,
        city: society.city,
        type: society.type,
        role: membership.role,
        status: membership.status,
        memberCount: society.memberCount,
      });
    }

    return ok(summaries);
  } catch (error: unknown) {
    return err(asSocietyError(error));
  }
}
