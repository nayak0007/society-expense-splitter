import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { asSocietyId, asUserId } from "@ses/domain";
import { z } from "zod";

import {
  SOCIETY_AUTHORIZATION_READER,
  type SocietyAuthorizationReader,
} from "../authorization/society-authorization";
import { REQUIRE_PERMISSION_KEY } from "../decorators/require-permission.decorator";
import { AppError } from "../errors/app-error";
import {
  readRequestActor,
  readRequestHeader,
  readRequestMembership,
  writeRequestSocietyContext,
} from "../http/http-access";

/** The header a society-scoped route is addressed with (SAD §7.4). */
export const SOCIETY_HEADER = "x-society-id";

/** Same check the society routes already apply to a `:societyId` path param. */
const societyIdSchema = z.uuid();

/**
 * Stage 3 of the guard chain — SAD §9.4. Resolves `X-Society-Id` to the caller's
 * membership and attaches it, once, for the rest of the request.
 *
 * ## It runs only where a society context is asked for
 *
 * Registered globally but **inert unless the route declares
 * `@RequirePermission(…)`**. That is not a loophole: every action in the matrix is
 * a *per-membership* grant (PRD §2, SAD §9.3), so a permission cannot be evaluated
 * without a membership, and a route that names a permission is therefore by
 * definition society-scoped. Making the guard unconditional instead would mean
 * every route in the API — the join-code lookup, the health probes, `GET
 * /societies` for a user who belongs to nothing yet — suddenly required a header
 * it has no meaning for.
 *
 * Global registration is still worth it versus `@UseGuards` per controller: the
 * ordering below is then a property of the application rather than of whichever
 * file someone copied, and a future module cannot apply the permission guard while
 * forgetting the one that resolves the membership it evaluates against.
 *
 * ## What each refusal means, and why two of them are one answer
 *
 * - **400** — the header is absent or not a UUID. A syntactic failure (SAD §7.8
 *   stage 1), so 400 rather than 422; the request never named a society.
 * - **401** — no verified actor. Unreachable while the auth guard runs first,
 *   which is exactly why it is cheap to keep.
 * - **404** — the caller has no live membership there, *including* when the
 *   society does not exist. Deliberately one answer: telling a caller which of
 *   the two happened lets them enumerate ids they cannot access (SAD §7.2, PRD
 *   T041). See the note in the report about the requested 403.
 *
 * ## One read per request, never two
 *
 * The context is written to the request object and the guard returns early if it
 * is already there, so a second application of this guard — or any other guard
 * that wants the membership — reads zero times, not once. It is *not* cached
 * anywhere global: the request object dies with the request, which is the only
 * lifetime that is automatically correct when a role changes mid-flight.
 */
@Injectable()
export class SocietyGuard implements CanActivate {
  constructor(
    @Inject(SOCIETY_AUTHORIZATION_READER)
    private readonly reader: SocietyAuthorizationReader,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<unknown>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (action === undefined) {
      return true;
    }

    const request: unknown = context.switchToHttp().getRequest();

    // Already resolved for this request — do not read again.
    if (readRequestMembership(request) !== undefined) {
      return true;
    }

    const actor = readRequestActor(request);
    if (actor === undefined) {
      throw new AppError("UNAUTHENTICATED", "Sign in to continue.");
    }

    const raw = readRequestHeader(request, SOCIETY_HEADER);
    if (raw === undefined) {
      throw new AppError(
        "VALIDATION_ERROR",
        `This request must name a society in the ${SOCIETY_HEADER} header.`,
        { field: SOCIETY_HEADER, status: 400 },
      );
    }

    const parsed = societyIdSchema.safeParse(raw.trim());
    if (!parsed.success) {
      throw new AppError("VALIDATION_ERROR", "Invalid Society Id.", {
        field: SOCIETY_HEADER,
        status: 400,
      });
    }

    const resolved = await this.reader.load(
      asSocietyId(parsed.data),
      asUserId(actor.userId),
    );

    if (resolved === null) {
      throw new AppError("NOT_FOUND", "That society is not available to you.");
    }

    writeRequestSocietyContext(request, resolved);
    return true;
  }
}
