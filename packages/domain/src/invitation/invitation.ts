import { can } from "../member/permission-evaluator";
import { assignableRoles } from "../member/role-rules";
import type { MemberRole } from "../society/society";
import type {
  ApartmentId,
  InvitationId,
  MemberId,
  SocietyId,
} from "../shared/ids";
import { err, ok } from "../shared/result";
import type { Result } from "../shared/result";
import { invitationError } from "./errors";
import type { InvitationError } from "./errors";

/**
 * The invitation aggregate — Roadmap T047, from PRD §3.3 and §7.2.
 *
 * ## What an invitation *is*, and what it deliberately is not
 *
 * It is a **pre-authorised membership**: a flat, a role and a recipient, sealed in a single-use
 * token that a person can redeem once. It is not a membership — nothing exists in `members`
 * until acceptance runs — and it is not a permission grant: an invitation carries a *role*, and
 * the permissions it will confer are `actionsFor(role)`, read from the matrix that already
 * exists. That is the rule this module exists to keep: no second list of what a role may do, and
 * no second way to become a member.
 *
 * ## The lifecycle, in PRD §7.2's words
 *
 * ```text
 *   sent ──▶ opened ──▶ accepted        (terminal)
 *     │         │
 *     └─────────┴──────▶ revoked        (terminal)
 *   sent/opened ───────▶ expired        (derived: expires_at <= now())
 * ```
 *
 * `expired` is **derived rather than stored** (`invitationStatusAt`), for the reason the migration
 * gives: a status that needs a sweeper to become true makes a stopped worker look like working
 * invitations. The other four are decisions somebody made, and they are written down.
 *
 * ## Who may invite whom
 *
 * The matrix, not a role name: `member.invite` (Admin **and** Treasurer) decides who may create an
 * invitation at all, and `member.role_change` (Admin only) decides which **roles** they may put in
 * one. So a Treasurer keeps the directory moving — recording occupants, inviting a neighbour to
 * join at the default role — without becoming a way to appoint officers. `rolesInvitableBy` is
 * that rule, and it reads `can()` rather than listing roles, so the two halves cannot drift.
 */

/** PRD §7.2's enum, verbatim (and `public.invitations.chk_invitations_status`). */
export const INVITATION_STATUSES = [
  "sent",
  "opened",
  "accepted",
  "expired",
  "revoked",
] as const;

export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/**
 * How the inviter intends to reach the recipient — PRD §7.2's `channel`.
 *
 * Recorded rather than acted on: actually sending anything is the notifications phase
 * (SAD §6's `INotificationChannel`), and this module's job is to say what was intended and to
 * return the link *once*, to the manager who asked for it. A module that started sending would
 * be the notification infrastructure T047 was told not to build.
 */
export const INVITATION_CHANNELS = [
  "whatsapp",
  "sms",
  "email",
  "link",
] as const;

export type InvitationChannel = (typeof INVITATION_CHANNELS)[number];

/**
 * PRD §3.3: invitations expire after **fourteen days**.
 *
 * A constant rather than a setting: nobody has asked to configure it, and an unconfigurable
 * fourteen days is a decision a reviewer can check against the PRD, where a per-society setting
 * would be a second thing to test and a third place for it to be wrong.
 */
export const INVITATION_TTL_DAYS = 14;

/** The role an invitation carries when the caller does not name one (the column default too). */
export const DEFAULT_INVITATION_ROLE: MemberRole = "resident";

/** The two statuses that can still be accepted. */
export function isInvitationLive(status: InvitationStatus): boolean {
  return status === "sent" || status === "opened";
}

export function isInvitationStatus(value: unknown): value is InvitationStatus {
  return (
    typeof value === "string" &&
    (INVITATION_STATUSES as readonly string[]).includes(value)
  );
}

export function isInvitationChannel(
  value: unknown,
): value is InvitationChannel {
  return (
    typeof value === "string" &&
    (INVITATION_CHANNELS as readonly string[]).includes(value)
  );
}

/** `now + 14 days`, as the ISO string the entity and the wire both carry. */
export function invitationExpiry(now: Date): string {
  return new Date(
    now.getTime() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

/**
 * An invitation as the manager's list and detail screens read it.
 *
 * `status` is the **stored** status. A screen that wants to explain why a link no longer works
 * asks `invitationStatusAt()`, which folds expiry in — keeping the two apart is what lets an
 * invitation be "sent, and overdue" for a manager who is tidying up, while the recipient's
 * preview says "expired".
 */
export interface Invitation {
  readonly id: InvitationId;
  readonly societyId: SocietyId;
  readonly apartmentId: ApartmentId | null;
  /** Denormalised for the list; `null` when the invitation was not tied to a flat. */
  readonly apartmentNumber: string | null;
  /** The **member** who issued it — not the account: the row is attributed to a membership. */
  readonly invitedBy: MemberId;
  readonly invitedByName: string | null;
  readonly channel: InvitationChannel;
  readonly email: string | null;
  readonly phone: string | null;
  readonly role: MemberRole;
  readonly status: InvitationStatus;
  readonly expiresAt: string;
  readonly openedAt: string | null;
  readonly acceptedAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

/**
 * The public, **masked** view of an invitation — what a link holder may see before signing in.
 *
 * There is no token here, no hash and no society id beyond what the preview screen needs; the
 * projection is the database function's (`invitation_preview()`), which is also what masks the
 * recipient. `inviteeHint` is enough for somebody to recognise their own invitation
 * (`in***@example.com`) and not enough for anybody else to harvest the address, which is the
 * whole reason preview is safe to make public.
 */
export interface InvitationPreview {
  readonly id: InvitationId;
  readonly societyId: SocietyId;
  readonly societyName: string;
  readonly role: MemberRole;
  readonly apartmentId: ApartmentId | null;
  readonly apartmentNumber: string | null;
  readonly channel: InvitationChannel;
  readonly inviteeHint: string;
  /**
   * Whether acceptance must match the signed-in account (a targeted invite) or accepts whoever
   * holds the link (an unaddressed one). The screen's copy differs, so the flag travels.
   */
  readonly requiresAccountMatch: boolean;
  /** `expired` is folded in here: this is what the recipient's screen shows. */
  readonly status: InvitationStatus;
  readonly expired: boolean;
  readonly expiresAt: string;
}

/** What acceptance produced — the membership, and how it came to exist. */
export interface InvitationAcceptance {
  readonly societyId: SocietyId;
  readonly memberId: MemberId;
  readonly role: MemberRole;
  readonly apartmentId: ApartmentId | null;
  /**
   * True when a live **shadow** member with the invitation's number was linked rather than a new
   * row created (PRD §3.3's "linked when that phone signs up"). Surfaced because it is the
   * difference between an Admin's recorded occupant gaining an account and a duplicate being
   * recorded — the thing the flow is most likely to get wrong.
   */
  readonly linkedShadow: boolean;
}

/** The same invitation, with expiry folded into the status. */
export function invitationStatusAt(
  invitation: Pick<Invitation, "status" | "expiresAt">,
  now: Date,
): InvitationStatus {
  if (!isInvitationLive(invitation.status)) return invitation.status;
  return new Date(invitation.expiresAt).getTime() <= now.getTime()
    ? "expired"
    : invitation.status;
}

/**
 * The masked hint for a recipient — `in***@example.com`, or the last four digits of a number.
 *
 * A **mirror** of the database's, not a rival implementation: the preview a client renders comes
 * from `invitation_preview()`, and this exists for the one case SQL cannot serve — a client that
 * has the address locally (the create form's confirmation, a test) and needs to show what the
 * recipient will see. Kept byte-identical on purpose, and asserted so in the domain's tests,
 * because two masks that differ by a character are two different promises about privacy.
 */
export function maskInvitee(contact: {
  readonly email?: string | null;
  readonly phone?: string | null;
}): string {
  const email = contact.email ?? null;
  const phone = contact.phone ?? null;
  if (email !== null && email.length > 0) {
    return `${email.slice(0, 2)}***@${email.split("@")[1] ?? ""}`;
  }
  if (phone !== null && phone.length > 0) {
    return `••••${phone.slice(-4)}`;
  }
  return "Anyone with this link";
}

/**
 * The roles `actorRole` may put in an invitation.
 *
 * `assignableRoles()` filtered by the *same* predicate `canAssignRole()` uses — one rule, read
 * twice — rather than a second list. A Treasurer therefore gets `["resident"]`, and an Admin gets
 * every role in PRD order.
 */
export function rolesInvitableBy(actorRole: MemberRole): readonly MemberRole[] {
  if (can(actorRole, "member.role_change")) return assignableRoles();
  return [DEFAULT_INVITATION_ROLE];
}

/**
 * Refuses an invitation at a role the inviter cannot hand out.
 *
 * The counterpart of `canAssignRole()` for the invitation path, and it is the *same* grant:
 * `member.role_change`. Stated separately because invitations are the one place a role is handed
 * out to somebody who is not yet a member, so the refusal has to be reachable before any member
 * row exists to check it against.
 */
export function checkInviteRole(
  actorRole: MemberRole,
  role: MemberRole,
): Result<true, InvitationError> {
  if (rolesInvitableBy(actorRole).includes(role)) return ok(true);

  return err(
    invitationError(
      "invitation_role_not_assignable",
      "Only a society Admin can invite somebody at a role above Resident.",
      { field: "role", role },
    ),
  );
}

/**
 * Refuses a **shareable link** at a role above `resident`.
 *
 * An unaddressed link is a bearer credential: whoever sees it is the invitee, so a leaked admin
 * link would be privilege escalation with a share button. A targeted invitation is different — the
 * recipient must match on acceptance — so a role above Resident is allowed there, by an Admin.
 */
export function checkOpenLinkInvite(
  channel: InvitationChannel,
  hasRecipient: boolean,
  role: MemberRole,
): Result<true, InvitationError> {
  if (channel !== "link" || hasRecipient) return ok(true);
  if (role === DEFAULT_INVITATION_ROLE) return ok(true);

  return err(
    invitationError(
      "invitation_open_link_role",
      "A shareable link can only be created at the Resident role. Invite the person directly to give them another role.",
      { field: "role", role },
    ),
  );
}

/**
 * Whether an invitation can still be accepted — the **ordered** check the database performs.
 *
 * State first, then the clock: a revoked invitation is revoked even if the fourteenth day also
 * passed, and the message the recipient sees should say the true reason rather than the later one.
 * The order is asserted on both sides (here and in the canary) because it is the difference
 * between "ask an Admin for a new link" and "the Admin cancelled this".
 */
export function checkInvitationAcceptable(
  invitation: Pick<Invitation, "status" | "expiresAt">,
  now: Date,
): Result<true, InvitationError> {
  if (!isInvitationLive(invitation.status)) {
    return err(
      invitationError(
        "invitation_not_acceptable",
        invitation.status === "accepted"
          ? "That invitation has already been accepted."
          : "That invitation has been revoked. Ask a society Admin for a new one.",
        { field: "status", status: invitation.status },
      ),
    );
  }

  if (new Date(invitation.expiresAt).getTime() <= now.getTime()) {
    return err(
      invitationError(
        "invitation_expired",
        "That invitation has expired. Ask a society Admin for a new one.",
        { field: "expiresAt" },
      ),
    );
  }

  return ok(true);
}
