import { err, ok } from "@ses/domain";
import type {
  InvitationError,
  InvitationPage,
  InvitationStatus,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import {
  invitationFailure,
  loadInvitationContext,
  requireInviteCapability,
  type InvitationDeps,
} from "./support";

/**
 * The society's invitations, newest first — the pending-invitations screen's read.
 *
 * Gated by `member.invite`, the same grant that creates them: whoever may issue an invitation may
 * see the ones outstanding, and nobody else may. A Guest, a Resident or a pending member gets
 * `403` — an invitation list is a list of people's addresses and numbers, which is the same class of
 * data the directory protects.
 *
 * The page carries `total` because the screen says "3 of 12" and the alternative is a second
 * request; the repository computes it in the same statement (`count(*) over ()`), so a filter does
 * not cost a round trip.
 *
 * **No expiry sweep here.** An invitation past its fourteenth day is still listed, and
 * `expired` is computed when it is rendered. A read path that rewrote rows would make a list
 * request a write, and the two would then need to agree about locking — for a column that is
 * already derivable from `expires_at`.
 */
export async function listInvitations(
  deps: InvitationDeps,
  actor: UserId,
  societyId: SocietyId,
  query: {
    readonly status?: InvitationStatus | undefined;
    readonly limit?: number | undefined;
    readonly offset?: number | undefined;
  },
): Promise<Result<InvitationPage, InvitationError>> {
  const loaded = await loadInvitationContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  const gate = requireInviteCapability(
    loaded.value.capabilities,
    "Only a society Admin or Treasurer can view invitations.",
  );
  if (!gate.ok) return gate;

  try {
    const page = await deps.invitations.list(societyId, actor, {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.offset === undefined ? {} : { offset: query.offset }),
    });
    return ok(page);
  } catch (error: unknown) {
    return err(invitationFailure(error));
  }
}
