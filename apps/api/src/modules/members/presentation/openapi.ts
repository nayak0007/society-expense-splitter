import { ApiErrorResponses } from "../../../common/swagger/zod-openapi";

/**
 * The error responses every member route can return.
 *
 * The 404 description names three cases that must stay indistinguishable, because they are the
 * ones a client is most likely to want to tell apart and must not be able to: a society the
 * caller has no membership in, a member of another society, and a member who does not exist —
 * including one who has been removed, which the API answers identically on purpose. A caller
 * who could tell "removed" from "never existed" could map a society's staff turnover by probing
 * ids (PRD T041).
 *
 * The 403 description is precise about what this module's refusals mean, and there are more of
 * them than in the structure module: a role that does not hold the action (`member.view`,
 * `member.invite`, `member.remove`, `member.role_change`), a membership that is not active, an
 * attempt to suspend, remove or re-role *yourself*, and the database's refusal to leave a society
 * without an active Admin — that last one is reported as `SOCIETY_ADMIN_REQUIRED` with a
 * `SOLE_ADMIN` detail code.
 *
 * The 409 names the conflicts the directory actually produces, because the fix for each is
 * different and a client that has to guess from a message string will guess wrong: `phone`
 * (another shadow member holds that number), `apartmentId` (that flat already has a primary
 * occupant for that occupancy), a member who is already in the society, a role that is already
 * held or at its cap (`ROLE_CAP_EXCEEDED` — PRD §2.2's 3 admins and 2 treasurers), and a role
 * change on a membership that is not active.
 */
export function ApiMemberErrors(): ClassDecorator & MethodDecorator {
  return ApiErrorResponses({
    notFound:
      "No such society, no such member — or one the caller is not an active member of, or one who has been removed. This API deliberately does not distinguish these (PRD T041).",
    forbidden:
      "An active member whose role does not hold the action this operation needs (`member.view` for reads, `member.invite` for directory edits, `member.remove` for suspension and removal), a membership that is not active, an attempt to change your own membership, or `SOCIETY_ADMIN_REQUIRED` when the change would leave the society with no active Admin.",
    conflict:
      "Another member is already recorded with that phone number (`field: phone`); the flat already has a primary occupant for that occupancy (`field: apartmentId`); the person is already a member; or the member is not in the state the operation requires (not active to suspend, not suspended to reactivate). A refused value — a name, an email address, a lease window that ends before it starts, a primary occupant without a flat — answers 422 with the offending `field`.",
  });
}
