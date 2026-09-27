import { asInvitationError, err, invitationError, ok } from "@ses/domain";
import type {
  Clock,
  Invitation,
  InvitationError,
  InvitationRepository,
  InvitationTokenPort,
  Member,
  MemberCapabilities,
  MemberRepository,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import { loadMemberContext } from "../../member/use-cases/support";

/**
 * Use-case dependencies for the invitations module.
 *
 * Four, and the count is the design:
 *
 *  - `invitations` — the port this module owns;
 *  - `members` — a **read** of the callers' own membership, because who may invite is the member
 *    module's `member.invite` cell and the one place that answers it is `findViewer`. The
 *    invitations module deliberately has no membership port of its own: a second way to read
 *    `public.members` is the duplicate concept the task's brief forbids, and the caller's own row
 *    is exactly what the members module already exposes;
 *  - `tokens` — issuing and hashing, because a package that compiles for Hermes cannot import
 *    `node:crypto`, and because a fake makes tokens deterministic in tests;
 *  - `clock` — so "expires in fourteen days" is a function of an injected instant rather than of
 *    the wall clock a test would have to sleep through.
 */
export interface InvitationDeps {
  readonly invitations: InvitationRepository;
  readonly members: MemberRepository;
  readonly tokens: InvitationTokenPort;
  readonly clock: Clock;
}

/** The caller, their capabilities, and the society they are acting in. */
export interface InvitationContext {
  readonly viewer: Member;
  readonly capabilities: MemberCapabilities;
}

/**
 * Loads the caller's own membership of the society, or fails with `not_found`.
 *
 * Delegates to the members module's loader rather than reimplementing it, so "no membership here"
 * is answered once — `not_found`, never `forbidden`, per PRD T041: a non-member cannot tell another
 * tenant's society apart from a non-existent id. The dependency is narrowed to `{ members }`, which
 * is what makes the reuse total rather than cosmetic.
 */
export async function loadInvitationContext(
  deps: InvitationDeps,
  actor: UserId,
  societyId: SocietyId,
): Promise<Result<InvitationContext, InvitationError>> {
  const loaded = await loadMemberContext(
    { members: deps.members },
    actor,
    societyId,
  );
  if (!loaded.ok) {
    // The member module's error vocabulary is a superset of the shared four (`not_found` and
    // `forbidden` here, in practice), and those are the same words the invitation module uses —
    // so the code survives the translation and the message is the member module's, which is the
    // sentence already written for this exact situation.
    return err(
      invitationError(
        loaded.error.code === "not_found" ? "not_found" : "forbidden",
        loaded.error.message,
        loaded.error.details,
      ),
    );
  }
  return ok(loaded.value);
}

/**
 * Refuses an operation when the caller does not hold `member.invite`.
 *
 * One capability for both adding a member and inviting one, because the matrix has one cell for
 * both: `member.invite` (Admin and Treasurer). `canAdd` is its name in the member module — historical
 * by now, but the alternative was two flags that always move together, which is a drift waiting to
 * happen rather than a clarification.
 */
export function requireInviteCapability(
  capabilities: MemberCapabilities,
  reason: string,
): Result<true, InvitationError> {
  return capabilities.canAdd
    ? ok(true)
    : err(invitationError("forbidden", reason));
}

/**
 * A created invitation and the **one** copy of its credential.
 *
 * No link and no path: the shape of an invitation URL is a client concern, so the two clients and
 * the API's own contract agree on it through `@ses/contracts`' `INVITATION_LINK_PREFIX` rather than
 * through a string this layer would have to keep in step with them.
 */
export interface CreatedInvitation {
  readonly invitation: Invitation;
  /** The bearer token. Returned to the creator, never stored, never logged. */
  readonly token: string;
}

/** Wraps an adapter failure into the module's error vocabulary. */
export function invitationFailure(error: unknown): InvitationError {
  return asInvitationError(error);
}
