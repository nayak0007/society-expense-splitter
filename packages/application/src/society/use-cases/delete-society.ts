import { asSocietyError, err, ok } from "@ses/domain";
import type { Result, SocietyId, UserId } from "@ses/domain";

import { loadSocietyContext, requireCapability } from "./support";
import type { SocietyDeps } from "./support";

/**
 * Delete a society (PRD §3.2 "Delete Society").
 *
 * Deleting removes a whole tenant, so it is Admin-only and the repository is
 * expected to soft-delete (`deleted_at`), never to destroy financial history —
 * PRD §3.1 keeps anonymised financial rows even when an account is deleted, and
 * §3.3 refuses to delete a member's history. The use case therefore returns
 * nothing and makes no claim about physical deletion: that is the adapter's
 * contract, and the `roles`/`removed_at` semantics stay consistent with it.
 */
export async function deleteSociety(
  deps: SocietyDeps,
  actor: UserId,
  societyId: SocietyId,
): Promise<Result<void, ReturnType<typeof asSocietyError>>> {
  const loaded = await loadSocietyContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  const guard = requireCapability(
    loaded.value.capabilities,
    "canDelete",
    "Only a society Admin can delete a society.",
  );
  if (!guard.ok) return guard;

  try {
    await deps.repository.remove(societyId, actor);
    return ok(undefined);
  } catch (error: unknown) {
    return err(asSocietyError(error));
  }
}
