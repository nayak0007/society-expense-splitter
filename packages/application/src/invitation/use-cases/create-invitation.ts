import {
  checkInviteRole,
  checkOpenLinkInvite,
  DEFAULT_INVITATION_ROLE,
  err,
  invitationExpiry,
  ok,
} from "@ses/domain";
import type {
  ApartmentId,
  InvitationChannel,
  InvitationError,
  MemberRole,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import {
  invitationFailure,
  loadInvitationContext,
  requireInviteCapability,
  type CreatedInvitation,
  type InvitationDeps,
} from "./support";

/**
 * Create an invitation (T047's `CreateInvitation`) — PRD §3.3 "Invite Members".
 *
 * ## The order of the checks, and why it is this order
 *
 * 1. **Who is asking** — the caller's own membership (`not_found` when there is none) and
 *    `member.invite` (Admin and Treasurer). Cheapest first, and it is the answer that decides
 *    whether the rest is even a question.
 * 2. **Which role** — `checkInviteRole`, which reads `member.role_change` through
 *    `rolesInvitableBy`: a Treasurer may create an invitation, and may create it only at
 *    `resident`.
 * 3. **Whether the invite is addressed** — `checkOpenLinkInvite`: a shareable link is a bearer
 *    credential, so it may carry `resident` and nothing above it.
 * 4. **The expiry**, from the injected clock (`now + 14 days`, PRD §3.3) and the token, issued
 *    once.
 * 5. **The row**, which the database checks again underneath: the inviter is resolved from the
 *    caller's own membership (never from this input), the recipient must not already have an
 *    account here, and a duplicate *live* invitation for the same address or number is refused by
 *    a partial unique index.
 *
 * Every refusal above is reported in the caller's terms; the SQLSTATE behind it is the lock, not
 * the door.
 *
 * ## What is *not* checked here, and where it is instead
 *
 * "Is this person already a member?" is deliberately **left to the database**, which is the only
 * layer that can answer it without a race: a use case that read the roster first would pass, and a
 * second request arriving in between would still create the invitation. The trigger refuses
 * atomically and the classifier turns `INVITATION_RECIPIENT_ALREADY_MEMBER` into the same sentence
 * this file would have written.
 *
 * ## Delivery is somebody else's job, on purpose
 *
 * The result carries the token, and this module does nothing with it. Sending is the notifications
 * phase (SAD §6); what T047 owes is a link the manager can send themselves, which is exactly what
 * PRD §3.3 describes. Nothing here logs it, and the row stores only its digest.
 */
export async function createInvitation(
  deps: InvitationDeps,
  actor: UserId,
  societyId: SocietyId,
  input: {
    readonly channel: InvitationChannel;
    readonly role?: MemberRole | undefined;
    readonly email?: string | undefined;
    readonly phone?: string | undefined;
    readonly apartmentId?: ApartmentId | undefined;
  },
): Promise<Result<CreatedInvitation, InvitationError>> {
  const loaded = await loadInvitationContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  const gate = requireInviteCapability(
    loaded.value.capabilities,
    "Only a society Admin or Treasurer can invite members.",
  );
  if (!gate.ok) return gate;

  const role = (input.role ?? DEFAULT_INVITATION_ROLE) as MemberRole;
  const email = input.email ?? null;
  const phone = input.phone ?? null;
  const hasRecipient = email !== null || phone !== null;

  const roleAllowed = checkInviteRole(loaded.value.viewer.role, role);
  if (!roleAllowed.ok) return roleAllowed;

  const linkAllowed = checkOpenLinkInvite(input.channel, hasRecipient, role);
  if (!linkAllowed.ok) return linkAllowed;

  const issued = deps.tokens.issue();
  const expiresAt = invitationExpiry(deps.clock.now());

  try {
    const invitation = await deps.invitations.create(
      societyId,
      {
        channel: input.channel,
        role,
        email,
        phone,
        apartmentId: input.apartmentId ?? null,
        // The digest, never the token: the row must not contain anything that can redeem itself.
        tokenHash: issued.tokenHash,
        expiresAt,
      },
      actor,
    );

    return ok({ invitation, token: issued.token });
  } catch (error: unknown) {
    return err(invitationFailure(error));
  }
}
