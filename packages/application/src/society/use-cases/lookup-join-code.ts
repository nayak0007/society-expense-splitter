import { asSocietyError, err, ok } from "@ses/domain";
import type { Result, SocietyJoinPreview } from "@ses/domain";

import type { SocietyDeps } from "./support";

/**
 * Resolve a join code to its society's public details (PRD §3.2, the join
 * screen's preview step).
 *
 * Holds no rules, on purpose — it is one repository read, and it is here rather
 * than in the controller so that "who may resolve a code" stays a decision this
 * layer owns. That decision is: **anyone.** A code is a capability: possessing it
 * is the authorisation, which is why this takes no actor, and why the repository
 * method underneath runs with no identity at all.
 *
 * It deliberately does not evaluate expiry. `joinSociety` does, against the
 * injected clock, because refusing an expired code is about committing to the
 * membership; showing a preview of a society whose code has expired is not an
 * error, it is information the join screen needs in order to say so. The preview
 * therefore reports `joinCodeExpiresAt` and lets the caller decide.
 *
 * `null` means "no society has this code", including a malformed one and a code
 * belonging to a deleted society. One answer for all three: a probe must not be
 * able to enumerate codes, or to tell a deleted society from a live one.
 */
export async function lookupJoinCode(
  deps: SocietyDeps,
  code: string,
): Promise<
  Result<SocietyJoinPreview | null, ReturnType<typeof asSocietyError>>
> {
  try {
    return ok(await deps.repository.findJoinPreview(code));
  } catch (error: unknown) {
    return err(asSocietyError(error));
  }
}
