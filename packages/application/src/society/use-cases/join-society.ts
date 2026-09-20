import {
  asSocietyError,
  createSocietyJoinRequest,
  err,
  isJoinCodeExpired,
  ok,
  societyError,
} from "@ses/domain";
import type {
  OccupancyType,
  Result,
  SocietyMembership,
  UserId,
} from "@ses/domain";

import type { SocietyDeps } from "./support";

/**
 * Join a society with a code (PRD §3.2 "Join Society").
 *
 * The order is deliberate: validate the code's *shape* first (no I/O, cheap),
 * then resolve it, then check expiry against the injected clock, then submit.
 * A malformed code never reaches the repository, and an expired code is refused
 * by the domain rather than by whichever adapter happens to remember to check.
 *
 * This use case does NOT decide the resulting status. PRD §3.2 is explicit that
 * joins are "never auto-approve": the membership comes back `pending` unless the
 * caller was already an admin of that society, and that judgement belongs to the
 * server, which is the only party that can see the approval queue.
 */
export interface JoinSocietyCommand {
  readonly code: string;
  readonly occupancyType: OccupancyType;
}

export async function joinSociety(
  deps: SocietyDeps,
  actor: UserId,
  command: JoinSocietyCommand,
): Promise<Result<SocietyMembership, ReturnType<typeof asSocietyError>>> {
  const request = createSocietyJoinRequest(command.code, command.occupancyType);
  if (!request.ok) return request;

  try {
    const preview = await deps.repository.findJoinPreview(request.value.code);
    if (preview === null) {
      // One message for "no such code" and for "code belongs to a deleted
      // society": a probe cannot use this endpoint to enumerate societies.
      return err(
        societyError(
          "join_code_invalid",
          "That join code does not match any society.",
        ),
      );
    }

    if (
      isJoinCodeExpired(preview.joinCodeExpiresAt, deps.clock.now().getTime())
    ) {
      return err(
        societyError(
          "join_code_expired",
          "That join code has expired. Ask an admin for a new one.",
        ),
      );
    }

    const membership = await deps.repository.join(
      { code: request.value.code, occupancyType: request.value.occupancyType },
      actor,
    );
    return ok(membership);
  } catch (error: unknown) {
    return err(asSocietyError(error));
  }
}
