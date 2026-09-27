import { asMemberError, err, ok, roleDefinitions } from "@ses/domain";
import type {
  MemberCapabilities,
  MemberError,
  Result,
  RoleDefinition,
  SocietyId,
  UserId,
} from "@ses/domain";

import { loadMemberContext, requireMemberCapability } from "./support";
import type { MemberDeps } from "./support";

/**
 * The role catalogue (T046): every role with everything it may ever do.
 *
 * ## Why a catalogue endpoint exists at all
 *
 * The matrix lives in code and the app ships with it, so a client could compute this locally —
 * `actionsFor` is a pure function and it is in `@ses/domain`, which the mobile bundle already
 * depends on. The endpoint exists for the two things a local copy cannot answer: it is the
 * **server's** declaration of what it will accept (a client that renders a role picker from a
 * stale bundle would otherwise offer a role the deployed API refuses), and it carries the
 * caller's capabilities, which is what decides whether the picker is usable at all.
 *
 * ## `member.view`, not `member.role_change`
 *
 * Reading what the roles *mean* is directory knowledge — the same grant that lets somebody read
 * the roster of names and roles. Requiring the write permission instead would hide the matrix
 * from every Treasurer and Resident, including the screens that explain why a button is missing.
 * The write paths are gated where they are used; this is a read of public policy.
 */
export interface RoleCatalogue {
  readonly roles: readonly RoleDefinition[];
  readonly capabilities: MemberCapabilities;
}

export async function listRoles(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
): Promise<Result<RoleCatalogue, MemberError>> {
  const loaded = await loadMemberContext(deps, actor, societyId);
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
      roles: roleDefinitions(),
      capabilities: loaded.value.capabilities,
    });
  } catch (error: unknown) {
    return err(asMemberError(error));
  }
}
