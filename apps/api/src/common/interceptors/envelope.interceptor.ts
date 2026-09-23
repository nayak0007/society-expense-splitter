import { randomUUID } from "node:crypto";

import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { map, type Observable } from "rxjs";

import { RequestContext } from "../context/request-context";
import { NO_ENVELOPE_KEY } from "../decorators/no-envelope.decorator";
import { readRequestId } from "../http/http-access";
import { isHealthProbeUrl } from "../http/probe-paths";
import type { Envelope } from "@ses/contracts";

/**
 * Wraps every successful response in the SAD §7.9 envelope — `{ data, meta }`.
 *
 * WHY IT IS GLOBAL RATHER THAN PER CONTROLLER: the contract's value is that a
 * client has *one* shape to unwrap. A controller that opts out by forgetting a
 * decorator produces a response the client cannot parse, and the failure appears
 * in production rather than at the route someone is editing. Registering it once
 * means the default is correct and the two exceptions are explicit decorators.
 *
 * The two exceptions, both deliberate:
 *  - **health probes**, which SAD §17.5 defines for orchestrators. Their body is
 *    terminus's diagnostic shape; wrapping it would hide the per-component
 *    detail an operator needs, and the exempt-on-success/wrapped-on-failure
 *    asymmetry is worse than no exemption at all. `isHealthProbeUrl` is shared
 *    with the exception filter so both halves agree.
 *  - **`@NoEnvelope()`**, currently only the delete route's `204`, which has no
 *    body to wrap.
 *
 * `requestId` comes from the async context rather than being read again from the
 * request, so the id in the body is the same string the access log and the
 * `X-Request-Id` response header carry — SAD §7.10 makes it the one identifier a
 * user can quote and support can find.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // A standalone application context (the worker) has no HTTP request.
    if (context.getType() !== "http") {
      return next.handle();
    }

    const request: unknown = context.switchToHttp().getRequest();
    const noEnvelope = this.reflector.getAllAndOverride<boolean>(
      NO_ENVELOPE_KEY,
      [context.getHandler(), context.getClass()],
    );
    const url = (request as { url?: string }).url;

    if (noEnvelope === true || isHealthProbeUrl(url)) {
      return next.handle();
    }

    const requestId =
      RequestContext.requestId() ?? readRequestId(request) ?? randomUUID();
    const timestamp = new Date().toISOString();

    return next.handle().pipe(
      map((data: unknown): Envelope => ({
        // §7.9: `data` is always present and always an object or array. A
        // handler returning nothing (`undefined`) therefore envelopes as `{}`
        // rather than omitting the member — a client reading `.data` gets an
        // object either way.
        data: (data ?? {}) as Envelope["data"],
        meta: { requestId, timestamp },
      })),
    );
  }
}
