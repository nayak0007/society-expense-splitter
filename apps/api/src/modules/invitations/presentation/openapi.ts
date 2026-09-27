import { ApiErrorResponses } from "../../../common/swagger/zod-openapi";

/**
 * The error responses every invitation route can return.
 *
 * ## The 404 description is the security property, stated where a client author reads it
 *
 * A missing invitation, one belonging to another society, and one whose token is simply wrong all
 * answer the same thing. The *preview* route is deliberately included in that: a caller who could
 * tell "no such token" from "malformed token" could probe for valid ones, which is the whole reason
 * the API hashes at the edge and answers `INVITATION_NOT_FOUND` for both.
 *
 * ## The 403 and 409 descriptions name the codes, because the screens branch on them
 *
 * An expired link and an already-accepted one are both `409`, and the copy that fixes them is
 * different ("ask for a new one" against "you are already in"). Both carry a `DETAIL_CODES` value
 * (`INVITATION_EXPIRED`, `INVITATION_NOT_ACCEPTABLE`) so a client branches on a code rather than on
 * prose — and the recipient of a link, who may have no account at all, is exactly the user least able
 * to cope with a generic message.
 */
export function ApiInvitationErrors(): ClassDecorator & MethodDecorator {
  return ApiErrorResponses({
    notFound:
      "No such society, no such invitation, or an invitation whose token resolves to nothing. Malformed tokens and unknown ones answer identically, because telling them apart would let a caller probe for valid ones.",
    forbidden:
      "An active member whose role does not hold `member.invite` (Admin or Treasurer), an invitation at a role the inviter cannot hand out (`INVITATION_ROLE_NOT_ASSIGNABLE`), a shareable link above the Resident role (`INVITATION_OPEN_LINK_ROLE`), an acceptance by the wrong account (`INVITATION_RECIPIENT_MISMATCH`), or a membership that was removed rather than invited back (`INVITATION_MEMBERSHIP_REMOVED`).",
    conflict:
      "The link is dead — expired (`INVITATION_EXPIRED`), already accepted, or revoked (`INVITATION_NOT_ACCEPTABLE`) — the recipient already has an account in the society (`INVITATION_RECIPIENT_ALREADY_MEMBER`), a live invitation for that address or number already exists, or the acceptor is already a member.",
  });
}
