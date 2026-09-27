import { err, invitationError, isInvitationLive, ok } from "@ses/domain";
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
 * Revoke an invitation (T047's `RevokeInvitation`).
 *
 * ## Revoking reads the row first, and that is not a redundant check
 *
 * The transition rule — `sent`/`opened` may become `revoked`, and nothing else may — is enforced by
 * the trigger underneath. This reads the row anyway, for two reasons that are both about the
 * caller rather than about safety: the refusal can name *which* state the invitation is already in
 * ("already accepted" is not the same sentence as "already revoked"), and a revoke of something
 * that has already been revoked is an ordinary mistake worth answering with `409` rather than with
 * the trigger's `INVITATION_TRANSITION_FORBIDDEN`.
 *
 * ## Why an *expired* invitation may still be revoked
 *
 * Expiry is derived from `expires_at`; it is not a decision anybody made. Tidying a list that
 * contains a fortnight-old invitation is precisely what a manager does, so the rule here is about
 * *decisions* (`accepted`, `revoked`) and not about the clock. The database agrees: its transition
 * trigger checks the two statuses and never the date.
 *
 * ## Nobody is notified, and nothing is deleted
 *
 * The row keeps its history (`revoked_at`, `revoked_by`), and the recipient finds out when they open
 * the link — the preview says "revoked", which is a better experience than a message that arrives
 * after they have already tried. Notification infrastructure is deferred to the notifications phase
 * (SAD §6) and recorded as such; the row is the integration seam an audit entry (T050) will read.
 */
export async function revokeInvitation(
  deps: InvitationDeps,
  actor: UserId,
  societyId: SocietyId,
  invitationId: InvitationId,
): Promise<Result<Invitation, InvitationError>> {
  const loaded = await loadInvitationContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  const gate = requireInviteCapability(
    loaded.value.capabilities,
    "Only a society Admin or Treasurer can revoke an invitation.",
  );
  if (!gate.ok) return gate;

  try {
    const current = await deps.invitations.findById(
      invitationId,
      societyId,
      actor,
    );
    if (current === null) {
      return err(
        invitationError(
          "not_found",
          "That invitation is not available to you.",
        ),
      );
    }

    if (!isInvitationLive(current.status)) {
      return err(
        invitationError(
          "invitation_not_acceptable",
          current.status === "accepted"
            ? "That invitation has already been accepted, so there is nothing to revoke."
            : "That invitation has already been revoked.",
          { field: "status", status: current.status },
        ),
      );
    }

    const revoked = await deps.invitations.revoke(
      invitationId,
      societyId,
      actor,
    );
    return ok(revoked);
  } catch (error: unknown) {
    return err(invitationFailure(error));
  }
}
