import { DomainError } from "../shared/errors";
import type { DomainErrorInit } from "../shared/errors";

/**
 * Invitation-module error codes — Roadmap T047.
 *
 * The shared four (`validation`, `not_found`, `forbidden`, `conflict`) come first because the
 * invitations module answers the same questions every module does — a malformed request, a row
 * that is not there, a caller who may not act — and a second spelling of "not found" would give
 * the API two branches to map and the mobile client two strings to translate.
 *
 * The rest are the database's own refusals
 * (`supabase/migrations/20260926120000_invitations.sql`), named here **in its words**. That is
 * deliberate: the SQL raises `INVITATION_RECIPIENT_MISMATCH` and the classifier turns it into
 * `invitation_recipient_mismatch`, so a rule the database enforces and a rule the UI explains
 * are provably the same rule rather than two that happen to agree today.
 *
 * A union per module rather than one global list, exactly as `MemberErrorCode` records: the
 * API's `Record<InvitationErrorCode, ErrorCode>` mapper then *fails the build* when a code gains
 * no HTTP meaning — the property that keeps a refusal from silently becoming a `500`.
 */
export const INVITATION_ERROR_CODES = [
  "validation",
  "not_found",
  "forbidden",
  "conflict",
  /**
   * The link itself resolved to nothing: a malformed token, or a hash no row carries. One code
   * for both, because distinguishing them would tell a guesser whether a well-formed token
   * exists — which is the whole point of hashing at the edge.
   */
  "invitation_not_found",
  /** A decision has already been made: `accepted` or `revoked`. Terminal, and never reversed. */
  "invitation_not_acceptable",
  /** Live, but past `expires_at` (PRD §3.3: fourteen days). */
  "invitation_expired",
  /** The inviter may not hand out that role — `member.invite` without `member.role_change`. */
  "invitation_role_not_assignable",
  /** A shareable link at a role above `resident`: whoever holds it would hold the role. */
  "invitation_open_link_role",
  /** Somebody who already has an account in the society. A *shadow* member is not this. */
  "invitation_recipient_already_member",
  /** The signed-in account is not the person the invitation was addressed to. */
  "invitation_recipient_mismatch",
  /** The acceptor is already an active member of the society. */
  "invitation_already_member",
  /**
   * The membership was removed. Re-joining is the join queue's or an Admin's act (T049): an
   * invitation must not resurrect a removal behind the back of whoever performed it.
   */
  "invitation_membership_removed",
  /** No active membership to attribute the invitation to (the trigger's own refusal). */
  "invitation_inviter_required",
  /** A status move the machine does not have (`accepted`/`revoked` are terminal). */
  "invitation_transition_forbidden",
  /** A flat that is not a live flat of this society. */
  "invitation_apartment_invalid",
  /** The caller is not the actor they claimed to be — acceptance is never performed for you. */
  "invitation_accept_denied",
  "unknown",
] as const;

export type InvitationErrorCode = (typeof INVITATION_ERROR_CODES)[number];

/**
 * Extends the shared `DomainError` so generic middleware recognises every domain failure by one
 * `instanceof`, while this module keeps its narrower `code` union.
 */
export class InvitationError extends DomainError<InvitationErrorCode> {
  constructor(
    code: InvitationErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>> | undefined,
  ) {
    const init: DomainErrorInit<InvitationErrorCode> = {
      code,
      message,
      details,
    };
    super(init);
    this.name = "InvitationError";
  }
}

export function isInvitationError(error: unknown): error is InvitationError {
  return error instanceof InvitationError;
}

/** Narrowing helper for `switch` exhaustiveness in services and screens. */
export function invitationErrorCode(error: unknown): InvitationErrorCode {
  return isInvitationError(error) ? error.code : "unknown";
}

/** Adapter throws → the error type every invitation use case promises. */
export function asInvitationError(error: unknown): InvitationError {
  if (isInvitationError(error)) return error;
  return new InvitationError(
    "unknown",
    "The invitation operation failed unexpectedly.",
  );
}

/** Shorthand used by the rules and use cases. */
export function invitationError(
  code: InvitationErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>> | undefined,
): InvitationError {
  return new InvitationError(code, message, details);
}
