import { asMemberError, err, ok, toMemberView } from "@ses/domain";
import type {
  MemberError,
  MemberView,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import { loadMemberContext } from "./support";
import type { MemberDeps } from "./support";
import type { MemberDetail } from "./get-member";

/**
 * The **caller's own** membership — who am I here, and what may I do.
 *
 * Every member use case in this package starts by loading the caller's membership
 * (`loadMemberContext`), and over HTTP that read is the one thing a client cannot get from
 * `GET /members`: the directory is a roster, and a roster does not answer "which row is
 * mine". This use case is that answer, and it is deliberately the *only* one — the mobile
 * repository implements `findViewer` with it, which is what lets the member screens call the
 * same use cases the API does, with the same rules, instead of re-deriving capabilities from
 * a role string they happen to have in a local store.
 *
 * ## No capability gate, and that is the point
 *
 * `getMember` requires `member.view`; this does not, because a capability check needs the
 * *viewer* it would be checking — asking for one first would be circular, and for a
 * suspended or pending member it would answer with the very state the caller is asking
 * about. So the row is returned as-is with the capabilities evaluated from it, all-false in
 * those cases: an inactive membership gets a real answer here (its own row, saying so) rather
 * than a refusal that cannot explain itself. The route still sits behind the JWT and the
 * society header, and the repository returns `null` — hence `not_found` — when there is no
 * live membership at all, so a non-member learns nothing about the society.
 *
 * Seen through the caller's own eyes (`toMemberView` with `viewer === target`), which is what
 * makes `contactVisible` true for it: you may always see your own contact details, even with
 * `share_contact` off.
 */
export async function getViewer(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
): Promise<Result<MemberDetail, MemberError>> {
  const loaded = await loadMemberContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  try {
    const viewer: MemberView = toMemberView(
      loaded.value.viewer,
      loaded.value.viewer,
    );
    return ok({ member: viewer, capabilities: loaded.value.capabilities });
  } catch (error: unknown) {
    return err(asMemberError(error));
  }
}
