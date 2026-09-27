import {
  INVITATION_EXPIRY_DAYS,
  INVITATION_LINK_PREFIX,
  acceptInvitationResponseSchema,
  createInvitationResponseSchema,
  invitationListResponseSchema,
  invitationPreviewResponseSchema,
  invitationSummarySchema,
} from "@ses/contracts";
import type {
  AcceptInvitationResponseDto,
  CreateInvitationResponseDto,
  InvitationListResponseDto,
  InvitationPreviewResponseDto,
  InvitationSummaryDto,
} from "@ses/contracts";
import { invitationStatusAt, maskInvitee } from "@ses/domain";
import type {
  Invitation,
  InvitationAcceptance,
  InvitationPreview,
} from "@ses/domain";
import type { CreatedInvitation } from "@ses/application";

/**
 * Domain → wire, **parsed against the client's own schema**.
 *
 * The parse is the point, exactly as `member.mapper.ts` records: a domain rename fails here, as a
 * `500` that names the field, rather than shipping a payload the client cannot read. It matters more
 * than usual in this module for one field — `expired`, which has no column behind it. A refactor that
 * dropped it would otherwise leave every client believing a fourteen-day-old link is still live.
 *
 * ## Two derived fields, computed once, on purpose
 *
 *  - `expired` is `invitationStatusAt(invitation, now)` — the **server's** clock. A client that
 *    computed it would hide a live invitation (or offer a dead one) whenever its clock was wrong, and
 *    on a shared link that is not a cosmetic difference.
 *  - `inviteeHint` is `maskInvitee(...)`, the same function the database's `invitation_preview()`
 *    masks with — one implementation, read twice, so the manager's list and the recipient's preview
 *    cannot show different halves of an address.
 */
export function invitationToDto(
  invitation: Invitation,
  now: Date = new Date(),
): InvitationSummaryDto {
  return invitationSummarySchema.parse({
    id: invitation.id,
    channel: invitation.channel,
    email: invitation.email,
    phone: invitation.phone,
    inviteeHint: maskFromDomain(invitation),
    role: invitation.role,
    status: invitation.status,
    expired: invitationStatusAt(invitation, now) === "expired",
    apartmentId: invitation.apartmentId,
    apartmentNumber: invitation.apartmentNumber,
    invitedBy: invitation.invitedBy,
    invitedByName: invitation.invitedByName,
    expiresAt: invitation.expiresAt,
    openedAt: invitation.openedAt,
    acceptedAt: invitation.acceptedAt,
    revokedAt: invitation.revokedAt,
    createdAt: invitation.createdAt,
  });
}

export function invitationListToDto(
  page: { readonly invitations: readonly Invitation[]; readonly total: number },
  now: Date = new Date(),
): InvitationListResponseDto {
  return invitationListResponseSchema.parse({
    invitations: page.invitations.map((row) => invitationToDto(row, now)),
    total: page.total,
  });
}

/**
 * The create response — the one place a token travels.
 *
 * `path` is composed here rather than by each client, so the mobile app and a browser cannot disagree
 * about where an invitation link points, and `expiresInDays` travels so the confirmation can say
 * "this link works for 14 days" without hard-coding a number the domain owns.
 */
export function createdInvitationToDto(
  created: CreatedInvitation,
): CreateInvitationResponseDto {
  return createInvitationResponseSchema.parse({
    invitation: invitationToDto(created.invitation),
    token: created.token,
    path: `${INVITATION_LINK_PREFIX}${created.token}`,
    expiresInDays: INVITATION_EXPIRY_DAYS,
  });
}

export function invitationPreviewToDto(
  preview: InvitationPreview,
): InvitationPreviewResponseDto {
  return invitationPreviewResponseSchema.parse({
    id: preview.id,
    societyId: preview.societyId,
    societyName: preview.societyName,
    role: preview.role,
    apartmentId: preview.apartmentId,
    apartmentNumber: preview.apartmentNumber,
    channel: preview.channel,
    inviteeHint: preview.inviteeHint,
    requiresAccountMatch: preview.requiresAccountMatch,
    status: preview.status,
    expired: preview.expired,
    expiresAt: preview.expiresAt,
  });
}

export function invitationAcceptanceToDto(
  acceptance: InvitationAcceptance,
): AcceptInvitationResponseDto {
  return acceptInvitationResponseSchema.parse({
    societyId: acceptance.societyId,
    memberId: acceptance.memberId,
    role: acceptance.role,
    apartmentId: acceptance.apartmentId,
    linkedShadow: acceptance.linkedShadow,
  });
} /** The mask, read from the domain rather than reimplemented — see the file comment. */
function maskFromDomain(invitation: Invitation): string {
  return maskInvitee({ email: invitation.email, phone: invitation.phone });
}
