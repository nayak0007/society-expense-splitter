import { err, ok } from "../shared/result";
import type { Result } from "../shared/result";

import type { Member, MemberRole, MemberStatus } from "./member";
import { DEFAULT_MEMBER_ROLE } from "./member";
import { memberError } from "./errors";
import type { MemberError } from "./errors";
import { can } from "./permission-evaluator";

/**
 * Join requests (PRD §3.2 "Join Society", §3.3; Roadmap T049).
 *
 * ## A join request *is* a pending membership — there is no second table
 *
 * PRD §7 defines no `join_requests` relation, and the membership row already carries every
 * field a request needs: a society, a subject (`user_id`), a flat, an occupancy declaration,
 * a status and a creation time. `members.status = 'pending'` is exactly "somebody asked to
 * join and nobody has decided yet", and the database's own trigger says so out loud
 * (`chk_member_self_change()`: "Joining a society needs an Admin to approve it").
 *
 * So this module adds **rules and types over `Member`**, never a parallel aggregate. The
 * alternative — a `join_requests` table plus a membership — would be two rows that must agree
 * about one fact, and the first thing that would disagree is which of them is pending.
 *
 * ## The lifecycle, in the database's words
 *
 * | Request state | Stored as                            | Reached by                        |
 * | ------------- | ------------------------------------ | --------------------------------- |
 * | `pending`     | `status = 'pending'`                 | `POST /societies/join`            |
 * | `approved`    | `status = 'active'`                  | the approval RPC                  |
 * | `rejected`    | `status = 'rejected'`                | the rejection RPC (with a reason)  |
 * | `withdrawn`   | `status = 'removed'`                 | `POST /societies/:id/leave`       |
 *
 * `expired` does **not** exist, and that is a decision rather than an omission: neither the
 * PRD nor the roadmap gives a join request a TTL, and a request that silently expired would
 * leave the requester staring at a pending screen while the row said something else. Where
 * expiry *is* part of the design — invitations — it is derived and checked at acceptance
 * (T047). A request lives until somebody decides.
 *
 * ## The decisions that are *not* here
 *
 * Nothing in this file writes. `checkJoinRequestReview` answers "may this reviewer decide this
 * request"; the write itself is a `SECURITY DEFINER` function that holds the row lock
 * (`member_approve_join()`/`member_reject_join()`), because two approvals racing must produce
 * exactly one active membership and one decision — a read-then-write in TypeScript cannot
 * promise that, and a row lock can.
 */

/** The four states of a *request*, as opposed to the five states of a *membership*. */
export const JOIN_REQUEST_STATES = [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
] as const;
export type JoinRequestState = (typeof JOIN_REQUEST_STATES)[number];

/**
 * One membership status → the request state a UI should render.
 *
 * `inactive` maps to `approved`, deliberately: a suspended member's request *was* approved,
 * and a suspension is a member-level state that does not re-open the queue. Collapsing the
 * two would show "awaiting approval" to somebody an Admin had already admitted and then
 * suspended, which is a different screen with a different action.
 */
export function joinRequestState(status: MemberStatus): JoinRequestState {
  switch (status) {
    case "pending":
      return "pending";
    case "active":
    case "inactive":
      return "approved";
    case "rejected":
      return "rejected";
    case "removed":
      return "withdrawn";
  }
}

/** `members.request_note`'s bound — the note is a sentence or two, not a dossier. */
export const JOIN_NOTE_MAX_LENGTH = 500;
/** A reason has to say something; "no" is not a reason (PRD: rejection carries a reason). */
export const REJECTION_REASON_MIN_LENGTH = 4;
export const REJECTION_REASON_MAX_LENGTH = 500;

/**
 * The optional note the requester may attach ("I'm the tenant of A-402 from March").
 *
 * Optional on purpose: PRD §3.2's join flow is code → preview → flat → occupancy → submit,
 * and a required message would put a text box in the way of the common case.
 */
export function createJoinNote(
  raw: string | null | undefined,
): Result<string | null, MemberError> {
  if (raw === null || raw === undefined) return ok(null);
  const note = raw.trim();
  if (note.length === 0) return ok(null);
  if (note.length > JOIN_NOTE_MAX_LENGTH) {
    return err(
      memberError(
        "validation",
        `Keep your note to ${JOIN_NOTE_MAX_LENGTH} characters or fewer.`,
        { field: "message" },
      ),
    );
  }
  return ok(note);
}

/**
 * The reason an Admin or Treasurer must give to reject a request.
 *
 * Required — not merely "recorded when supplied" — because the requester is a person waiting
 * for an answer and the PRD's rejection path is what tells them why. A rejection with no
 * reason is indistinguishable from a lost request.
 */
export function createRejectionReason(
  raw: string | null | undefined,
): Result<string, MemberError> {
  const reason = (raw ?? "").trim();
  if (reason.length < REJECTION_REASON_MIN_LENGTH) {
    return err(
      memberError("validation", "Give a reason the requester can act on.", {
        field: "reason",
      }),
    );
  }
  if (reason.length > REJECTION_REASON_MAX_LENGTH) {
    return err(
      memberError(
        "validation",
        `Keep the reason to ${REJECTION_REASON_MAX_LENGTH} characters or fewer.`,
        { field: "reason" },
      ),
    );
  }
  return ok(reason);
}

/**
 * One request as the review queue renders it: the membership, plus everybody else claiming
 * the same flat.
 *
 * `claims` is the PRD §3.2 rule made structural — "If someone claims an already-claimed flat,
 * route it to the Admin with both claims visible — do not auto-reject". A queue that showed
 * only the requester would leave the Admin to discover the collision by opening the flat, and
 * the two rows would look like two unrelated requests.
 *
 * It is a *read* shape: the write is the approval, which either confirms a claim or refused it
 * under `uq_primary_occupant`. An empty `claims` means the request has no flat yet.
 */
export interface JoinRequest {
  /**
   * The request itself. A plain `Member` here, not a `MemberView`: contact visibility is a
   * property of *who is looking* (see `toMemberView`), and the repository knows only the
   * actor's id. The use case redacts, exactly as the directory's does.
   */
  readonly member: Member;
  /** Every live membership naming the same flat, this request included. */
  readonly claims: readonly Member[];
}

/** The queue's query — paging only; the queue is the society's own pending rows. */
export interface JoinRequestQuery {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** One page of the queue, with the total the filters produced. */
export interface JoinRequestPage {
  readonly requests: readonly JoinRequest[];
  readonly total: number;
}

/**
 * What an approval may change, all optional.
 *
 * Absent means "as requested": the requester already declared their occupancy and (since
 * T049) their flat, so an approver who agrees with all of it sends an empty body. What the
 * approver *can* correct is what the requester could not know — the flat they picked wrongly,
 * the occupancy the society records for billing, and (Admin only) an initial role.
 */
export interface JoinApprovalInput {
  readonly role?: MemberRole | undefined;
  readonly occupancy?: Member["occupancy"] | undefined;
  readonly apartmentId?: string | null | undefined;
  readonly isPrimary?: boolean | undefined;
}

/**
 * May `viewer` decide this request?
 *
 * Three refusals, in the order that gives the most useful answer:
 *
 *  1. **not pending** — the request was already decided, withdrawn or removed. Its own state
 *     is the answer, and a second approval must never create a second decision;
 *  2. **self-review** — nobody decides their own request. The rule is structural today (a
 *     pending member holds no `member.approve`), and it is stated anyway because "structural"
 *     is a property of the current schema, not of the rule;
 *  3. **capability** — `member.approve` (Admin **and** Treasurer), which the use case checks
 *     from the capability set rather than from a role string.
 */
export function checkJoinRequestReview(
  viewer: Member,
  request: Member,
): Result<true, MemberError> {
  if (request.status !== "pending") {
    return err(
      memberError(
        "join_request_not_pending",
        "That request has already been decided.",
        { field: "memberId" },
      ),
    );
  }
  if (viewer.id === request.id || viewer.userId === request.userId) {
    return err(
      memberError("self_review", "You cannot decide your own request.", {
        field: "memberId",
      }),
    );
  }
  return ok(true);
}

/**
 * May this reviewer admit somebody at `role`?
 *
 * The same asymmetry the invitation path enforces (`stamp_invitation_creator`): a Treasurer
 * holds `member.approve` — they may say *whether* somebody joins — and only an Admin holds
 * `member.role_change`, which is what handing out a role is. Admitting somebody as an
 * ordinary Resident is the default and needs no extra grant; anything above it does.
 */
export function checkJoinRoleAssignment(
  viewer: Member,
  role: MemberRole,
): Result<true, MemberError> {
  if (role === DEFAULT_MEMBER_ROLE) return ok(true);
  return can(viewer.role, "member.role_change")
    ? ok(true)
    : err(
        memberError(
          "role_not_assignable",
          "Only a society Admin can admit somebody at a role above Resident.",
          { field: "role" },
        ),
      );
}

/** Runtime guard for a request state that arrived over the wire. */
export function isJoinRequestState(value: unknown): value is JoinRequestState {
  return (
    typeof value === "string" &&
    (JOIN_REQUEST_STATES as readonly string[]).includes(value)
  );
}
