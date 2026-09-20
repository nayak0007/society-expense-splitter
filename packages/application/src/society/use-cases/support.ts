import {
  asSocietyError,
  err,
  evaluateSocietyCapabilities,
  findMembership,
  ok,
  societyError,
} from "@ses/domain";
import type {
  Clock,
  Result,
  Society,
  SocietyCapabilities,
  SocietyId,
  SocietyMembership,
  SocietyRepository,
  UserId,
} from "@ses/domain";

/**
 * Use-case dependencies.
 *
 * Explicit and injected, never imported as singletons: that is what makes a use
 * case a pure function of `(deps, actor, command)` and lets a unit test pass a
 * five-line fake repository and a frozen clock. No DI container, no module
 * mocking, no `jest.mock`.
 */
export interface SocietyDeps {
  readonly repository: SocietyRepository;
  readonly clock: Clock;
}

/** Everything a use case needs to decide about one society and one caller. */
export interface SocietyContext {
  readonly society: Society;
  /** The caller's own membership; never null in a loaded context. */
  readonly membership: SocietyMembership;
  /** All memberships of the society — required by the sole-admin invariant. */
  readonly memberships: readonly SocietyMembership[];
  readonly capabilities: SocietyCapabilities;
}

/**
 * Loads the society and the caller's relationship to it, or fails with
 * `not_found`.
 *
 * `not_found` — never `forbidden` — when the caller is not a member: PRD T041
 * requires that a non-member cannot tell another tenant's society apart from a
 * non-existent id. The same rule is enforced again by RLS; this layer exists so
 * the answer is identical regardless of which layer rejects.
 */
export async function loadSocietyContext(
  deps: SocietyDeps,
  actor: UserId,
  societyId: SocietyId,
): Promise<Result<SocietyContext, ReturnType<typeof asSocietyError>>> {
  try {
    const society = await deps.repository.findById(societyId, actor);
    if (society === null) {
      return err(
        societyError("not_found", "That society is not available to you."),
      );
    }

    const memberships = await deps.repository.listSocietyMemberships(
      societyId,
      actor,
    );
    // Scoped to the *actor*: the society's membership list holds everyone, and
    // picking the wrong row here means acting as someone else (see
    // `findMembership`).
    const membership = findMembership(memberships, societyId, actor);
    if (membership === null || membership.status === "removed") {
      return err(
        societyError("not_found", "That society is not available to you."),
      );
    }

    return ok({
      society,
      membership,
      memberships,
      capabilities: evaluateSocietyCapabilities(membership, memberships),
    });
  } catch (error: unknown) {
    return err(asSocietyError(error));
  }
}

/**
 * Turns a capability into a result. The message comes from the rule that denied
 * it, so the UI can explain *why* rather than just greying a button out.
 */
export function requireCapability(
  capabilities: SocietyCapabilities,
  capability: keyof SocietyCapabilities,
  reason: string,
): Result<true, ReturnType<typeof asSocietyError>> {
  return capabilities[capability]
    ? ok(true)
    : err(societyError("forbidden", reason));
}
