import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

import type { Society, SocietyMembership } from "@ses/domain";

import { REQUEST_ACTOR_KEY, type VerifiedActor } from "../auth/actor";
import { AppError } from "../errors/app-error";
import { RequestContext } from "../context/request-context";
import {
  readRequestActor,
  readRequestId,
  readRequestMembership,
  readRequestSociety,
} from "../http/http-access";

/**
 * `@Ctx()` — the request's identity, injected as a parameter.
 *
 * Follows SAD §4.5's `common/decorators/` convention (`@Ctx`), and exists so a
 * handler never touches the adapter's request object: the controller stays
 * testable as a plain class, and the shape the handler sees is one this module
 * defines rather than Fastify's.
 *
 * `requestId` is read from the async context (established by
 * `RequestContextInterceptor`, which runs before parameter decorators are
 * evaluated) with the request object as a fallback — the same fallback chain the
 * exception filter uses, so a response body and a log line cannot disagree about
 * which request they describe.
 *
 * `actor` is `undefined` only on a `@Public()` route: the guard runs before the
 * interceptor that publishes it, so a route that requires an actor and reads a
 * missing one has mis-declared itself. `requireActor` turns that into a 401
 * rather than letting `undefined` reach a repository, where the failure would be
 * a confusing query error instead of a clear rejection.
 */
export interface RequestCtx {
  readonly requestId: string;
  readonly actor: VerifiedActor | undefined;
  /**
   * The society `SocietyGuard` resolved. Undefined on every route that declared
   * no permission — the guard is inert there (see `society.guard.ts`).
   */
  readonly society: Society | undefined;
  /** The caller's membership in that society. Present exactly when `society` is. */
  readonly membership: SocietyMembership | undefined;
}

export const Ctx = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestCtx => {
    const request: unknown = context.switchToHttp().getRequest();

    return {
      requestId: RequestContext.requestId() ?? readRequestId(request) ?? "",
      actor: readRequestActor(request),
      society: readRequestSociety(request),
      membership: readRequestMembership(request),
    };
  },
);

/**
 * Narrows a `@Ctx()` to one with a resolved society, or throws.
 *
 * The mirror of `requireActor`, for the same reason: a handler that declares
 * `@RequirePermission` but reads a missing society has mis-declared itself, and a
 * clear 500 naming the mis-wiring is worth more than `undefined` reaching a
 * repository.
 */
export function requireSociety(context: RequestCtx): {
  readonly society: Society;
  readonly membership: SocietyMembership;
} {
  if (context.society === undefined || context.membership === undefined) {
    throw new AppError(
      "INTERNAL",
      "This route requires a society context that was never resolved.",
    );
  }
  return { society: context.society, membership: context.membership };
}

/** Narrows a `@Ctx()` to an authenticated one, or throws `UNAUTHENTICATED`. */
export function requireActor(context: RequestCtx): VerifiedActor {
  if (context.actor === undefined) {
    throw new AppError("UNAUTHENTICATED", "Sign in to continue.");
  }
  return context.actor;
}

/** Re-exported so a handler can name the key without importing the guard. */
export { REQUEST_ACTOR_KEY };
