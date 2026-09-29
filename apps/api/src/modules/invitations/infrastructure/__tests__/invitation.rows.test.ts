import { SQLSTATE } from "../../../../common/database/postgres-errors";
import { invitationErrorFromPostgres } from "../invitation.rows";

/**
 * The invitations module's database ⇄ domain boundary, for the two refusals the
 * concurrency audit found missing from it.
 *
 * Both are refusals `invitation_accept()` can produce while a *second* write is in
 * flight, and both used to fall through the classifier's last branch: the first
 * answered a generic "that invitation conflicts with one that already exists" where
 * the sequential path says "you are already a member", and the second — a `P0001`
 * with no entry in the raised-exception list — answered `unknown`, which is a **500**
 * for a rule the user could have been told about. Each test names the sentence the
 * user should see, not just the code.
 */

/** The wrapper Drizzle actually throws: `code` lives one level down, in `cause`. */
function asDrizzleWraps(
  cause: Record<string, unknown>,
): Record<string, unknown> {
  return {
    message: "Failed query: select public.invitation_accept($1, $2::uuid)",
    query: "select public.invitation_accept($1, $2::uuid)",
    params: ["…", "…"],
    cause,
  };
}

describe("invitationErrorFromPostgres", () => {
  it("reads a membership collision as the named already-a-member refusal", () => {
    // What a race produces: two *different* invitations accepted at once by one
    // recipient. `invitation_accept()` translates it, and this branch is the second
    // line of defence for a later migration re-creating the function without the
    // handler.
    const error = invitationErrorFromPostgres(
      asDrizzleWraps({
        code: SQLSTATE.uniqueViolation,
        message:
          'duplicate key value violates unique constraint "members_society_user_key"',
        detail: "Key (society_id, user_id)=(…) already exists.",
      }),
      "accept",
    );

    expect(error.code).toBe("invitation_already_member");
    expect(error.message).toBe("You are already a member of this society.");
  });

  it("answers a role that filled up with the members module's own meaning", () => {
    // `chk_role_caps()` refuses from inside the acceptance when the invited role is at
    // PRD §2.2's cap. It travels as `P0001` with the name in the message, so a missing
    // entry in `RAISED_EXCEPTION` is the difference between a 409 and a 500.
    const error = invitationErrorFromPostgres(
      asDrizzleWraps({
        code: SQLSTATE.raised,
        message: "SOCIETY_ROLE_CAP_EXCEEDED",
        hint: "A society can have at most 2 treasurers.",
      }),
      "accept",
    );

    expect(error.code).toBe("invitation_role_unavailable");
    // The database's own sentence reaches the user, because it is more specific than
    // any fallback this module could write.
    expect(error.message).toBe("A society can have at most 2 treasurers.");
  });

  it("keeps the live-invitation indexes as their own field conflicts", () => {
    // Unchanged behaviour, pinned here because the new branch above is matched on the
    // same SQLSTATE and must not swallow these.
    const email = invitationErrorFromPostgres(
      {
        code: SQLSTATE.uniqueViolation,
        constraint: "uq_invitations_live_email",
      },
      "write",
    );
    const phone = invitationErrorFromPostgres(
      {
        code: SQLSTATE.uniqueViolation,
        constraint: "uq_invitations_live_phone",
      },
      "write",
    );

    expect(email.code).toBe("conflict");
    expect(email.details?.field).toBe("email");
    expect(phone.code).toBe("conflict");
    expect(phone.details?.field).toBe("phone");
  });
});
