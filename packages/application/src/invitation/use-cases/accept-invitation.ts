import { err, ok } from "@ses/domain";
import type {
  InvitationAcceptance,
  InvitationError,
  Result,
  UserId,
} from "@ses/domain";

import { invitationFailure, type InvitationDeps } from "./support";

/**
 * Accept an invitation (T047's `AcceptInvitation`) — the one operation in this module with **no
 * capability check**, and the reason is the whole shape of the feature.
 *
 * ## Why there is no gate here, and why that is not a hole
 *
 * Every other route in this module asks "may this caller invite?" — a question about a membership
 * that already exists. Acceptance asks the opposite question: *this caller is not a member yet, and
 * the invitation is the authority that makes them one.* The credential is the token; the capability
 * being exercised is the inviter's, already checked when they created it; and the checks that
 * remain are about **this** person and **this** link, which the database performs while holding the
 * row lock:
 *
 *  - the actor must match the invitation's recipient where one was named
 *    (`invitation_recipient_mismatch`);
 *  - the status must still be live and within the fourteen days (`invitation_not_acceptable`,
 *    `invitation_expired`);
 *  - the actor must not already be a member (`invitation_already_member`), and a *removed* one is
 *    refused rather than resurrected (`invitation_membership_removed`) — re-joining is the join
 *    queue's or an Admin's act (T049);
 *  - the system clears its own identity before writing the membership, because
 *    `chk_member_self_change()` correctly refuses a self-service role or status change on every
 *    other path — here the invitation is the authority, and the function has already validated it.
 *
 * ## Atomic, single-use, and no second way to join
 *
 * One transaction with `SELECT … FOR UPDATE`: two simultaneous accepts cannot both win, and the
 * membership is created, linked or activated exactly once. The membership write goes through the
 * *members* table's own triggers, so an invitation cannot become a way around a rule the member
 * module enforces — a fourth admin is still refused by `chk_role_caps()`, and a duplicate shadow
 * number is still refused by `uq_members_shadow_phone`.
 *
 * ## What the caller gets back
 *
 * The membership, its role and its flat — plus `linkedShadow`, which says whether an occupant an
 * Admin had already recorded was **linked** instead of a second row being created (PRD §3.3). That
 * is the single fact a matching flow can get wrong in a way nobody notices for months, so it travels
 * rather than being inferred.
 */
export async function acceptInvitation(
  deps: InvitationDeps,
  actor: UserId,
  token: string,
): Promise<Result<InvitationAcceptance, InvitationError>> {
  try {
    const acceptance = await deps.invitations.accept(
      deps.tokens.hash(token),
      actor,
    );
    return ok(acceptance);
  } catch (error: unknown) {
    return err(invitationFailure(error));
  }
}
