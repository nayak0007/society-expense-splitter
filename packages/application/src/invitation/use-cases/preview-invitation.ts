import { err, invitationError, ok } from "@ses/domain";
import type { InvitationError, InvitationPreview, Result } from "@ses/domain";

import { invitationFailure, type InvitationDeps } from "./support";

/**
 * Preview an invitation from its link — **no identity, no society header, no capability**.
 *
 * This is the one read in the module a signed-out person must be able to make, because the whole
 * point of a link is that the recipient may not have an account yet. It is safe to expose for three
 * reasons, and they are all in the projection rather than in a check:
 *
 *  1. the caller must already hold the **token** — 256 bits of CSPRNG output, matched against a
 *     sha256 digest, so guessing is not a strategy (and a guess is answered `not_found`, which
 *     reveals nothing about whether a token exists);
 *  2. what comes back is **masked**: the society's name, the role, the flat and `in***@example.com`.
 *     Enough to recognise your own invitation, not enough to harvest an address from a forwarded
 *     link;
 *  3. the row is loaded by a `SECURITY DEFINER` function on an **anonymous** transaction — the
 *     `authenticated` role with no `auth.uid()` — so every policy still fails closed and this
 *     function is the only thing reachable.
 *
 * The first call also moves the funnel's second step (`sent → opened`), and only the second: the
 * database does it in the same statement, so a preview is idempotent and a client cannot claim it
 * delivered anything.
 *
 * The **hash** is computed here from the raw token, and the raw token is never passed further: the
 * adapter only ever sees the digest, which is what keeps the credential out of query logs and out of
 * the database's own statement history.
 */
export async function previewInvitation(
  deps: InvitationDeps,
  token: string,
): Promise<Result<InvitationPreview, InvitationError>> {
  try {
    const preview = await deps.invitations.previewByTokenHash(
      deps.tokens.hash(token),
    );
    if (preview === null) {
      return err(
        invitationError(
          "invitation_not_found",
          "That invitation link is not valid. Ask for a new one.",
        ),
      );
    }
    return ok(preview);
  } catch (error: unknown) {
    return err(invitationFailure(error));
  }
}
