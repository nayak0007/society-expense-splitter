import { InvitationError } from "@ses/domain";

import { toAppError } from "../invitation-error.mapper";

/**
 * The one invitation code this task adds, checked at the place it becomes HTTP.
 *
 * The mapper is a `Record<InvitationErrorCode, ErrorCode>`, so an unmapped code fails
 * the build rather than falling back to `INTERNAL` — but the *detail* code is a plain
 * lookup, and it is what a client actually branches on. This pins both, because the
 * whole point of the new code is that it answers the same way the members module
 * answers the identical database refusal.
 */
describe("toAppError", () => {
  it("reports a role that filled up as a conflict carrying ROLE_CAP_EXCEEDED", () => {
    const error = toAppError(
      new InvitationError(
        "invitation_role_unavailable",
        "A society can have at most 2 treasurers.",
        { field: "role" },
      ),
    );

    expect(error.code).toBe("CONFLICT");
    expect(error.payload.details?.[0]?.code).toBe("ROLE_CAP_EXCEEDED");
    expect(error.payload.details?.[0]?.field).toBe("role");
  });

  it("still reports the inviter's own refusal as forbidden, not as a cap", () => {
    // The distinction the new code exists to preserve: `invitation_role_not_assignable`
    // is about the inviter's permission, and folding the two together would tell an
    // Admin their society was full when the truth is that they may not hand out that
    // role at all.
    const error = toAppError(
      new InvitationError(
        "invitation_role_not_assignable",
        "Only a society Admin can invite somebody at a role above Resident.",
        { field: "role" },
      ),
    );

    expect(error.code).toBe("FORBIDDEN");
    expect(error.payload.details?.[0]?.code).toBe(
      "INVITATION_ROLE_NOT_ASSIGNABLE",
    );
  });
});
