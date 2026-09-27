import { err, invitationError, ok } from "@ses/domain";
import type {
  Invitation,
  InvitationError,
  InvitationId,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import {
  invitationFailure,
  loadInvitationContext,
  requireInviteCapability,
  type InvitationDeps,
} from "./support";

/**
 * One invitation — the details screen's read, and the row a revoke confirmation is about.
 *
 * `not_found` for an id that is absent **and** for one that belongs to another society: both arrive
 * as "no row", and the repository scopes the query by `society_id` rather than filtering afterwards,
 * so a caller cannot map another tenant's invitations by probing ids. Same answer, same code, one
 * lookup — which is the property PRD T041 asks for and the reason the check is not `403`.
 *
 * Returns the stored status, not the derived one: the detail screen shows the funnel (when it was
 * sent, opened, accepted or revoked) and the deadline beside it, and collapsing those into one word
 * would lose the half of the story the manager opened the screen to read.
 */
export async function getInvitation(
  deps: InvitationDeps,
  actor: UserId,
  societyId: SocietyId,
  invitationId: InvitationId,
): Promise<Result<Invitation, InvitationError>> {
  const loaded = await loadInvitationContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  const gate = requireInviteCapability(
    loaded.value.capabilities,
    "Only a society Admin or Treasurer can view invitations.",
  );
  if (!gate.ok) return gate;

  try {
    const invitation = await deps.invitations.findById(
      invitationId,
      societyId,
      actor,
    );
    if (invitation === null) {
      return err(
        invitationError(
          "not_found",
          "That invitation is not available to you.",
        ),
      );
    }
    return ok(invitation);
  } catch (error: unknown) {
    return err(invitationFailure(error));
  }
}
