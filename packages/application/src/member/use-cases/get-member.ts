import { asMemberError, err, ok, toMemberView } from "@ses/domain";
import type {
  MemberCapabilities,
  MemberError,
  MemberId,
  MemberView,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import { loadMemberTarget, requireMemberCapability } from "./support";
import type { MemberDeps } from "./support";

/**
 * One member of the society — the details screen's read.
 *
 * The same capability the list needs (`member.view`), checked here rather than inherited
 * from the list: a deep link or a cold start can render the detail screen without ever
 * having read the directory, and a guard that only exists on the list is a guard a route
 * can miss.
 *
 * A member who has been removed is `not_found`, which is the same answer the repository
 * gives for one that never existed — deliberately, so this read cannot be used to work out
 * whether a particular person once lived in a particular flat.
 */
export interface MemberDetail {
  readonly member: MemberView;
  readonly capabilities: MemberCapabilities;
}

export async function getMember(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
  memberId: MemberId,
): Promise<Result<MemberDetail, MemberError>> {
  const loaded = await loadMemberTarget(deps, actor, societyId, memberId);
  if (!loaded.ok) return loaded;

  const guard = requireMemberCapability(
    loaded.value.capabilities,
    "canView",
    loaded.value.viewer.status === "active"
      ? "Your role in this society cannot view its members."
      : "Your membership in this society is not active.",
  );
  if (!guard.ok) return guard;

  try {
    return ok({
      member: toMemberView(loaded.value.viewer, loaded.value.target),
      capabilities: loaded.value.capabilities,
    });
  } catch (error: unknown) {
    return err(asMemberError(error));
  }
}
