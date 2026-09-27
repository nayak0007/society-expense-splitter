import type {
  ApartmentId,
  InvitationId,
  SocietyId,
  UserId,
} from "../shared/ids";
import type { MemberRole } from "../society/society";
import type {
  Invitation,
  InvitationAcceptance,
  InvitationChannel,
  InvitationPreview,
  InvitationStatus,
} from "./invitation";

/**
 * The invitations module's storage port — declared here, implemented in
 * `apps/api/src/modules/invitations/infrastructure/`, faked in tests.
 *
 * ## Why the token is not a parameter anywhere
 *
 * Every method here takes a **hash**, and the raw token exists in exactly two places: the response
 * that created it and the link the recipient opened. The hashing is a port (`InvitationTokenPort`)
 * rather than something this package does, because `node:crypto` cannot be imported into a package
 * that has to compile for Hermes — and because a port is what lets a test make tokens
 * deterministic.
 *
 * ## What the adapter decides, and what it must not
 *
 * The adapter decides **nothing about invitations**. It writes the row, reads the projection and
 * calls the two functions the migration defines; whether an invitation may exist at all, who may
 * issue it, which role it may carry and whether acceptance is allowed are all decided above it —
 * by the use cases (in the caller's own voice) and by the database (as the lock behind them). An
 * adapter that re-decided one of them would be a third copy of a rule with two owners already.
 */
export interface CreateInvitationInput {
  readonly channel: InvitationChannel;
  readonly role: MemberRole;
  /** Absent for a shareable link; one of these is required otherwise (the table's CHECK). */
  readonly email: string | null;
  readonly phone: string | null;
  readonly apartmentId: ApartmentId | null;
  readonly tokenHash: string;
  /** ISO 8601, `now + INVITATION_TTL_DAYS` — computed by the use case, never by SQL's `now()`. */
  readonly expiresAt: string;
}

/** What the list route accepts. No free-text search: an invitation list is small and filtered. */
export interface InvitationQuery {
  readonly status?: InvitationStatus;
  readonly limit?: number;
  readonly offset?: number;
}

/** One page of invitations plus the total the filter produced. */
export interface InvitationPage {
  readonly invitations: readonly Invitation[];
  readonly total: number;
}

/**
 * A single-use token and its digest.
 *
 * Two facts about one secret, produced together so they cannot be produced apart — a factory that
 * could mint a token without recording its digest would be a token nobody can redeem, and one that
 * could record a digest without the token would be a credential nobody received.
 */
export interface IssuedInvitationToken {
  /** The bearer credential. Returned **once**, to the manager who created the invitation. */
  readonly token: string;
  /** Its sha256 hex digest — all that is ever stored. */
  readonly tokenHash: string;
}

/** The token port. Implemented over `node:crypto` by the API; faked deterministically in tests. */
export interface InvitationTokenPort {
  issue(): IssuedInvitationToken;
  /** A raw token (from a link) → the digest the row is keyed by. */
  hash(token: string): string;
}

export interface InvitationRepository {
  /** Insert one invitation as `actor`. `invited_by` is the trigger's, not this input's. */
  create(
    societyId: SocietyId,
    input: CreateInvitationInput,
    actor: UserId,
  ): Promise<Invitation>;

  /** One page of the society's invitations, newest first. */
  list(
    societyId: SocietyId,
    actor: UserId,
    query: InvitationQuery,
  ): Promise<InvitationPage>;

  /** One invitation of the society, or `null` when the caller may not see it. */
  findById(
    id: InvitationId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<Invitation | null>;

  /**
   * Mark an invitation revoked. The transition trigger decides whether that is legal and stamps
   * `revoked_at`/`revoked_by`; this method only asks.
   */
  revoke(
    id: InvitationId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<Invitation>;

  /**
   * The masked preview for a token hash — **no identity required**, because the caller may not
   * have an account yet.
   *
   * Runs on a `{ kind: "anonymous" }` transaction: the `authenticated` role with no `auth.uid()`,
   * so every policy still fails closed and only the `SECURITY DEFINER` projection is reachable.
   * Returns `null` for an unknown or malformed hash rather than an error — "no such invitation" is
   * this lookup's ordinary answer, and a caller that could tell it apart from a refusal could probe
   * for valid tokens.
   */
  previewByTokenHash(tokenHash: string): Promise<InvitationPreview | null>;

  /**
   * Accept, atomically, as `actor`.
   *
   * One transaction, one row lock: two simultaneous accepts cannot both win, and the membership is
   * created, linked or activated exactly once. Every refusal below (`invitation_recipient_mismatch`,
   * `invitation_expired`, `invitation_already_member`, …) is raised by the database function, which
   * is the only place that can hold the lock while deciding.
   */
  accept(tokenHash: string, actor: UserId): Promise<InvitationAcceptance>;
}
