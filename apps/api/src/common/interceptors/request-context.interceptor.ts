import { randomUUID } from "node:crypto";

import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import type { Observable } from "rxjs";

import { RequestContext } from "../context/request-context";
import {
  readRequestActor,
  readRequestId,
  readRequestHeader,
} from "../http/http-access";

/**
 * Binds `RequestContext` for the rest of the request.
 *
 * An interceptor, rather than middleware, because Nest's lifecycle puts
 * interceptors *after* guards and *before* pipes and handlers — so the context it
 * establishes is visible to exactly the layers that need it (validation, use
 * cases, repositories), while the layers that run earlier already have the raw
 * request object in hand.
 *
 * It deliberately does **not** log the request (`pino-http` already emits one
 * structured access log per request) and deliberately does **not** write the
 * `X-Request-Id` response header — that belongs to the adapter's `onRequest`
 * hook in `bootstrap.ts`, because an interceptor is only bound to matched routes
 * and would therefore miss 404s. See the comment there.
 *
 * The actor is *copied* from the request, not resolved here: guards run before
 * interceptors, so `SupabaseAuthGuard` has already written the verified actor
 * onto the request by this point. Copying rather than re-reading the token keeps
 * one verification per request and one source of truth for who the caller is.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request: unknown = http.getRequest();

    // The adapter's `genReqId` already set this on the request. The fallbacks
    // cover a non-HTTP adapter or a disabled logger — as in tests — so a request
    // id is always available rather than being conditionally undefined.
    const requestId =
      readRequestId(request) ??
      readRequestHeader(request, "x-request-id") ??
      randomUUID();

    return RequestContext.run(
      { requestId, userId: readRequestActor(request)?.userId },
      () => next.handle(),
    );
  }
}
