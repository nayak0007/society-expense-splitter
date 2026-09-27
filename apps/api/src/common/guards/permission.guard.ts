import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { can, isAction } from "@ses/domain";
import type { Action } from "@ses/domain";

import { REQUIRE_PERMISSION_KEY } from "../decorators/require-permission.decorator";
import { AppError } from "../errors/app-error";
import { readRequestMembership } from "../http/http-access";

/**
 * Stage 4 of the guard chain — SAD §9.4. Reads the action a route declared and
 * asks the domain's evaluator whether the caller's membership may perform it.
 *
 * ## It hardcodes nothing
 *
 * There is no role comparison anywhere in this file, and that is the point of the
 * task it implements: the matrix lives in one place
 * (`@ses/domain`'s `permission-evaluator`, keyed off PRD §2.1), the mobile UI calls
 * the same function for affordance, and the RLS policies mirror it. A
 * `membership.role === "admin"` written here would be a fourth copy, and the copy
 * that no conformance test enumerates.
 *
 * ## Why the membership is read from the request rather than reloaded
 *
 * `SocietyGuard` ran first and attached it. Re-reading here would double the
 * queries on every guarded request for no new information — and worse, it would
 * introduce a window in which the two guards disagree about the caller's role.
 *
 * A missing membership therefore means the chain is mis-wired, not that the caller
 * is unauthorised: it is an `INTERNAL` (a 500 the client can quote a request id
 * for) rather than a 403, because telling a caller they lack a permission when the
 * application forgot to look it up sends them to the wrong place entirely.
 *
 * ## 403 versus 404, and the pending member
 *
 * `SocietyGuard` answers "may you know this society exists?" — 404 when the answer
 * is no. This guard answers a different question, "may you do this here?", and it
 * only ever runs for a caller the first guard already accepted. A membership that
 * exists but is not `active` (a pending join request) legitimately reaches this
 * point: they already know the society exists, so `MEMBER_INACTIVE` — a 403 — leaks
 * nothing that 404 was protecting.
 *
 * ## Scoped actions
 *
 * When the action's grant is conditional in the PRD's matrix (a Committee
 * Member's *own* draft, a Resident's *own* complaint), `can()` answers
 * "eligible" and this guard lets the request through. The handler **must** then
 * narrow against the actual record via `isScopedAction`. That requirement is
 * stated here rather than implied because allowing a request is exactly the point
 * at which forgetting it becomes a privilege bug — and the report lists it as the
 * first piece of remaining work.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<unknown>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required === undefined) {
      return true;
    }

    if (!isAction(required)) {
      // Unreachable through the decorator, which validates at decoration time.
      // Kept because a hand-written `SetMetadata` — or a future decorator with a
      // looser signature — must fail loudly rather than fall through to "allow".
      throw new AppError(
        "INTERNAL",
        "This route declares a permission that does not exist.",
      );
    }

    const action: Action = required;
    const request: unknown = context.switchToHttp().getRequest();
    const membership = readRequestMembership(request);

    if (membership === undefined) {
      throw new AppError(
        "INTERNAL",
        "This route requires a society context that was never resolved.",
      );
    }

    if (membership.status !== "active") {
      throw new AppError(
        "MEMBER_INACTIVE",
        "Your membership is awaiting approval in this society.",
      );
    }

    if (!can(membership.role, action)) {
      throw new AppError(
        "FORBIDDEN",
        `Your role in this society does not allow "${action}".`,
      );
    }

    // Eligible — including a conditional (scoped) grant, which the handler must
    // narrow against the record. See the docstring above.
    return true;
  }
}
