import type { ErrorCode, ErrorDetail } from "@ses/contracts";
import type { InvitationError, InvitationErrorCode } from "@ses/domain";

import { AppError } from "../../../common/errors/app-error";

/**
 * The invitations module's error vocabulary → the API's catalogue (SAD §7.10).
 *
 * `Record<InvitationErrorCode, ErrorCode>` rather than a `switch`, for the reason the member mapper
 * records in full: adding a domain code **fails the build here** until somebody decides what it means
 * over HTTP. A `switch` with a `default: "INTERNAL"` would quietly answer 500 for a rule that
 * deserved a 409 — which is exactly the bug the society module's classifier carried until a live
 * database found it.
 *
 * ## Why so many codes map to 409 or 410 rather than 400
 *
 * The request is well formed in every one of these cases; it is the *state of the world* that refuses
 * it. `invitation_expired` and `invitation_not_acceptable` are `CONFLICT` (the row is not in a state
 * that accepts the operation) and the recipient's screen explains them from the detail code, because
 * the answer they need is "ask for a new link", not "correct a field".
 */
export const ERROR_CODE_BY_INVITATION_CODE: Readonly<
  Record<InvitationErrorCode, ErrorCode>
> = {
  validation: "VALIDATION_ERROR",
  not_found: "NOT_FOUND",
  forbidden: "FORBIDDEN",
  conflict: "CONFLICT",
  // The link itself resolves to nothing. `NOT_FOUND` on purpose rather than a 400: the request is
  // fine, and a caller that could tell "malformed" from "no such token" could probe for tokens.
  invitation_not_found: "NOT_FOUND",
  invitation_not_acceptable: "CONFLICT",
  invitation_expired: "CONFLICT",
  invitation_role_not_assignable: "FORBIDDEN",
  // The role is not forbidden to the inviter — it is *full* (PRD §2.2). CONFLICT, matching how
  // the members module answers the same database refusal on a role change.
  invitation_role_unavailable: "CONFLICT",
  invitation_open_link_role: "FORBIDDEN",
  // The *recipient* is the conflict — an address or a number that already belongs to somebody here.
  invitation_recipient_already_member: "CONFLICT",
  // The signed-in account is not the invitee: a permission answer, not a "not found" one, because
  // the invitation plainly exists and this caller is not its recipient.
  invitation_recipient_mismatch: "FORBIDDEN",
  invitation_already_member: "CONFLICT",
  invitation_membership_removed: "FORBIDDEN",
  invitation_inviter_required: "FORBIDDEN",
  invitation_transition_forbidden: "CONFLICT",
  invitation_apartment_invalid: "VALIDATION_ERROR",
  // The caller is not the actor they claimed: refused the same way an unauthenticated attempt is.
  invitation_accept_denied: "FORBIDDEN",
  unknown: "INTERNAL",
};

/**
 * Codes worth preserving verbatim on the wire.
 *
 * `ErrorDetail.code` is a free-form string by design (the validation pipe puts Zod's issue codes
 * there), so a client can branch on `INVITATION_EXPIRED` — the screen that explains "ask an Admin for
 * a new one" needs to know it, and the alternative would be for every client to match on prose.
 */
const DETAIL_CODES: Readonly<Partial<Record<InvitationErrorCode, string>>> = {
  invitation_not_found: "INVITATION_NOT_FOUND",
  invitation_not_acceptable: "INVITATION_NOT_ACCEPTABLE",
  invitation_expired: "INVITATION_EXPIRED",
  invitation_role_not_assignable: "INVITATION_ROLE_NOT_ASSIGNABLE",
  // The members module's own detail code, reused rather than respelled: "that role is at its
  // cap" is one situation, and a client should not need two strings for it.
  invitation_role_unavailable: "ROLE_CAP_EXCEEDED",
  invitation_open_link_role: "INVITATION_OPEN_LINK_ROLE",
  invitation_recipient_already_member: "INVITATION_RECIPIENT_ALREADY_MEMBER",
  invitation_recipient_mismatch: "INVITATION_RECIPIENT_MISMATCH",
  invitation_already_member: "INVITATION_ALREADY_MEMBER",
  invitation_membership_removed: "INVITATION_MEMBERSHIP_REMOVED",
};

/**
 * Translates a domain failure into the exception the filter renders.
 *
 * The field travels only when the domain attached one, and that is not an oversight: this module has
 * several field-less failures (an expired link, a wrong account, an already-accepted invitation) and
 * they belong to no input at all. A default would attach an expired link to a form field and make
 * the user edit something that is not wrong.
 */
export function toAppError(error: InvitationError): AppError {
  const code = ERROR_CODE_BY_INVITATION_CODE[error.code];
  const field = fieldOf(error);
  const detailCode = DETAIL_CODES[error.code];

  const details: readonly ErrorDetail[] | undefined =
    detailCode === undefined
      ? undefined
      : [
          {
            field: field ?? "code",
            code: detailCode,
            message: error.message,
          },
        ];

  return new AppError(code, error.message, {
    ...(field === undefined ? {} : { field }),
    ...(details === undefined ? {} : { details }),
  });
}

function fieldOf(error: InvitationError): string | undefined {
  const candidate: unknown = error.details?.field;
  return typeof candidate === "string" && candidate !== ""
    ? candidate
    : undefined;
}
