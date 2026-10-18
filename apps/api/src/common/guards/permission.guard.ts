import {
  Inject,
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { can, isAction } from "@ses/domain";
import type { Action } from "@ses/domain";

import {
  SECURITY_EVENT_RECORDER,
  type PermissionRefusalReason,
  type SecurityEventRecorder,
} from "../authorization/security-event-recorder";
import { REQUIRE_PERMISSION_KEY } from "../decorators/require-permission.decorator";
import { AppError } from "../errors/app-error";
import {
  readRequestActor,
  readRequestIp,
  readRequestId,
  readRequestMembership,
  readRequestUserAgent,
} from "../http/http-access";

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
 *
 * ## The two 403s it decides are recorded — T050 Stage E2, ADR-0014 D14
 *
 * A refusal made here is the only kind this codebase keeps a durable record of: the
 * caller is authenticated, the society and the role come from the membership the
 * previous guard resolved from the database, and the action is the one the route
 * declared. The write happens outside the request's own work — there is none yet, because
 * this guard runs before any handler — so it goes through `SecurityEventRecorder`, whose
 * adapter owns that transaction and is bounded to one row per member, action, reason and
 * hour.
 *
 * The refusals this guard does *not* decide stay unrecorded by design. A 401 (no verified
 * actor) and `SocietyGuard`'s 404 (no live membership) are out of scope, and D14 says why:
 * an unauthenticated caller must not be able to write to an immutable table at all, and a
 * cross-society row would have to be filed under the target society.
 *
 * Recording is awaited before the refusal is thrown, so the row is on the table by the
 * time the client reads the status. It is not transactional with anything (there is
 * nothing to be transactional with), and its failure cannot change the answer: the
 * recorder logs and returns, and the guard refuses regardless.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(SECURITY_EVENT_RECORDER)
    private readonly refusals: SecurityEventRecorder,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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
      await this.recordRefusal(context, request, action, "member_inactive");
      throw new AppError(
        "MEMBER_INACTIVE",
        "Your membership is awaiting approval in this society.",
      );
    }

    if (!can(membership.role, action)) {
      await this.recordRefusal(context, request, action, "role_denied");
      throw new AppError(
        "FORBIDDEN",
        `Your role in this society does not allow "${action}".`,
      );
    }

    // Eligible — including a conditional (scoped) grant, which the handler must
    // narrow against the record. See the docstring above.
    return true;
  }

  /**
   * Hands one refusal to the recorder, and never lets that hand-off change the answer.
   *
   * Every fact is read from what the chain already established: the actor from the verified
   * token, the society and role from the resolved membership, and the route from the
   * controller and handler **names** rather than from the request's URL — a path or query
   * would carry the ids a 404 is meant not to disclose.
   *
   * A missing actor or membership means the chain is mis-wired rather than that the caller
   * is unauthorised, and the guard already refuses that case with the `INTERNAL` above; there
   * is nothing honest to record, so this returns without one.
   */
  private async recordRefusal(
    context: ExecutionContext,
    request: unknown,
    action: Action,
    reason: PermissionRefusalReason,
  ): Promise<void> {
    const actor = readRequestActor(request);
    const membership = readRequestMembership(request);
    if (actor === undefined || membership === undefined) {
      return;
    }

    try {
      await this.refusals.recordRefusal({
        societyId: membership.societyId,
        actorUserId: actor.userId,
        actorRole: membership.role,
        reason,
        action,
        controller: context.getClass().name,
        handler: context.getHandler().name,
        requestId: readRequestId(request),
        ip: readRequestIp(request),
        userAgent: readRequestUserAgent(request),
      });
    } catch (error: unknown) {
      // Defence in depth, not the design: the recorder's contract is that it never
      // throws, and the real adapter swallows its own failures after logging them. This
      // exists because a *misbehaving* implementation must still not be able to turn a
      // correct `403` into a `500` — the authorization answer is the guard's to give.
      this.logger.warn(
        `The refusal of "${action}" was not recorded. The caller was refused ` +
          `regardless. Cause: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
  }
}
