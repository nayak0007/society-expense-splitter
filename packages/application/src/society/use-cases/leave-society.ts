import {
  asSocietyError,
  canLeaveSociety,
  err,
  ok,
  societyError,
} from "@ses/domain";
import type { Result, SocietyId, UserId } from "@ses/domain";

import { loadSocietyContext } from "./support";
import type { SocietyDeps } from "./support";

/**
 * Leave a society (PRD §3.2 "Leave Society").
 *
 * The invariant this exists for is the Phase 3 definition of done: *a society
 * can never be left without an active admin*. So the rule is evaluated against
 * **every** membership of that society, not just the caller's — which is why the
 * repository port has to expose the society's membership list.
 *
 * The refusal carries the rule's own reason (promote someone first), and the
 * specific `sole_admin` code, so the API can return a 409 with an actionable
 * message instead of a generic 403.
 */
export async function leaveSociety(
  deps: SocietyDeps,
  actor: UserId,
  societyId: SocietyId,
): Promise<Result<void, ReturnType<typeof asSocietyError>>> {
  const loaded = await loadSocietyContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  const decision = canLeaveSociety(
    loaded.value.membership,
    loaded.value.memberships,
  );
  if (!decision.allowed) {
    return err(societyError("sole_admin", decision.reason));
  }

  try {
    await deps.repository.leave(societyId, actor);
    return ok(undefined);
  } catch (error: unknown) {
    return err(asSocietyError(error));
  }
}
