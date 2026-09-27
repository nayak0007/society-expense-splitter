import {
  asMemberError,
  err,
  evaluateMemberCapabilities,
  memberError,
  ok,
} from "@ses/domain";
import type {
  Member,
  MemberCapabilities,
  MemberError,
  MemberId,
  MemberRepository,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

/**
 * Use-case dependencies.
 *
 * Explicit and injected, never imported as singletons — the property that makes a use case
 * a pure function of `(deps, actor, …)` and lets a unit test pass a five-line fake. No DI
 * container, no module mocking, no `jest.mock`.
 *
 * **One dependency**, where the structure module has three, and the difference is worth
 * stating: the member module owns the table it reads. The structures' third dependency
 * exists because `deleteBuilding` has to ask a question about *another* module's table
 * (how many flats point at this building); here every question — the caller's own
 * membership, the target member, the duplicate-phone lookup — is about `members`, so a
 * second port would be a second way to read one table.
 *
 * In particular this module does **not** take the society module's
 * `StructureMembershipReader`: that port collapses `inactive` and `rejected` onto
 * `removed`, which is right for the switcher and wrong here — a suspended member must be
 * told their membership is suspended, not that the society does not exist.
 */
export interface MemberDeps {
  readonly members: MemberRepository;
}

/** Everything a use case needs to decide about one society and one caller. */
export interface MemberContext {
  readonly viewer: Member;
  readonly capabilities: MemberCapabilities;
}

/**
 * Loads the caller's own membership, or fails with `not_found`.
 *
 * `not_found` — never `forbidden` — when there is no membership at all: PRD T041 requires
 * that a non-member cannot tell another tenant's society apart from a non-existent id,
 * and RLS underneath enforces the same answer so both layers agree.
 *
 * A **removed** membership is folded into the same answer deliberately (the repository
 * filters it): the caller once belonged and no longer does, and there is no state they can
 * act in. An `inactive` membership is *not* folded — it is a live row with live
 * consequences, and the capability evaluation is what turns it into a refusal that says so.
 */
export async function loadMemberContext(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
): Promise<Result<MemberContext, MemberError>> {
  try {
    const viewer = await deps.members.findViewer(societyId, actor);
    if (viewer === null) {
      return err(
        memberError("not_found", "That society is not available to you."),
      );
    }
    return ok({ viewer, capabilities: evaluateMemberCapabilities(viewer) });
  } catch (error: unknown) {
    return err(asMemberError(error));
  }
}

/**
 * Turns a capability into a result. The message comes from the caller, which knows which
 * action it was attempting — so "your role cannot view the directory" is attached to a
 * read and "only an Admin can remove a member" to a removal, from one evaluation of one
 * matrix.
 */
export function requireMemberCapability(
  capabilities: MemberCapabilities,
  capability: keyof MemberCapabilities,
  reason: string,
): Result<true, MemberError> {
  return capabilities[capability]
    ? ok(true)
    : err(memberError("forbidden", reason));
}

/** A loaded member context plus the row it is about. */
export interface MemberTargetContext extends MemberContext {
  readonly target: Member;
}

/**
 * Loads the caller's context and one member of the same society, or fails.
 *
 * Both halves are scoped by `societyId` **and** by the caller, and a member of another
 * society is reported as `not_found` rather than as a permission problem: a distinguishable
 * answer lets a caller enumerate people they cannot see.
 *
 * `removed` members are absent rather than rejected — the repository filters them — and the
 * distinction that matters is that this is *not* the same as "you may not see them": both
 * arrive here as `null` deliberately, because a caller who could tell them apart could map
 * a society's staff turnover by probing ids.
 */
export async function loadMemberTarget(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
  memberId: MemberId,
): Promise<Result<MemberTargetContext, MemberError>> {
  const loaded = await loadMemberContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  try {
    const target = await deps.members.findById(memberId, societyId, actor);
    if (target === null) {
      return err(
        memberError("not_found", "That member is not available to you."),
      );
    }
    return ok({ ...loaded.value, target });
  } catch (error: unknown) {
    return err(asMemberError(error));
  }
}
