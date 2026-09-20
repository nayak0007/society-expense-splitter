import { FastifyAdapter } from "@nestjs/platform-fastify";

import {
  readRequestHeader,
  readRequestId,
  writeResponseHeader,
} from "./common/http/http-access";
import { resolveRequestId } from "./observability/logger";

/**
 * HTTP adapter configuration, shared by the real bootstrap (`main.ts`) and the
 * integration test harness (`test/utils/test-app.ts`).
 *
 * WHY THIS IS ITS OWN MODULE: every setting here is invisible to a unit test and
 * only observable over HTTP, so a test that assembles its own adapter verifies a
 * pipeline that does not ship. That is not hypothetical — the first version of
 * the harness built a bare `FastifyAdapter`, and the assertion "an inbound
 * `X-Request-Id` is honoured" failed against `req-1`, because the setting lived
 * only in `main.ts`. Sharing the construction makes that class of drift
 * impossible rather than merely unlikely.
 */

/**
 * SAD §7.3: URL-based versioning. Defined once so the router, the OpenAPI export
 * and the tests cannot disagree about it.
 */
export const GLOBAL_PREFIX = "v1";

/** SAD §13.2/§14: a request body is bounded unless a route raises it explicitly. */
const BODY_LIMIT_BYTES = 1_048_576;

export function createAdapter(): FastifyAdapter {
  const adapter = new FastifyAdapter({
    bodyLimit: BODY_LIMIT_BYTES,

    // §1.6 puts a load balancer in front, so the client IP arrives in
    // X-Forwarded-For and §7.6's IP-keyed rate limits need it trusted. Only safe
    // because nothing reaches this process directly; on a public internet-facing
    // server it would let a client spoof its own identity.
    trustProxy: true,

    /**
     * Request id (SAD §17.4 — "`requestId` propagated end to end … so a user
     * reporting a problem can quote one string that finds the exact trace").
     *
     * Configured **here, on Fastify**, and not only in pino: Fastify assigns
     * `request.id` itself (`req-1`, `req-2`, …) before any hook runs, and
     * pino-http honours an id that already exists. A `genReqId` passed to pino
     * alone is therefore never reached on this adapter, and the API would ship
     * with per-process counters — which collide across instances and identify
     * nothing. Confirmed by observing `req-3` on a live response header.
     *
     * The parameter is `unknown` and narrowed, rather than annotated with
     * Fastify's request type: this module does not depend on `fastify` directly
     * (only `@nestjs/platform-fastify` does), and `readRequestHeader` is the same
     * adapter-agnostic accessor the rest of the pipeline uses.
     */
    genReqId: (request: unknown): string =>
      resolveRequestId(readRequestHeader(request, "x-request-id")),
  });

  /**
   * Echo the correlation id on the response — SAD §7.10 makes it the string
   * support asks a user for, so it has to be visible to the caller, not only in
   * the access log.
   *
   * WHY A FASTIFY HOOK RATHER THAN THE REQUEST-CONTEXT INTERCEPTOR, which is
   * where this started: Nest binds a global interceptor to the *matched route*, so
   * it does not run when no route matches. Unmatched requests still reach the
   * exception filter (Nest's 404 handler throws through it), so those responses
   * carried a `requestId` in the body and no `X-Request-Id` header — the body and
   * the header disagreed, which is worse than omitting both, because support would
   * be handed an id that appears nowhere else. An `onRequest` hook runs for every
   * request the server accepts, including 404s, validation failures and errors in
   * guards, so the header and the id it echoes are now set in one place.
   *
   * `onRequest` specifically, not `onSend`: Fastify runs `onRequest` after
   * assigning `request.id`, but before routing and before any handler writes a
   * response — so there is no risk of a route having already flushed headers.
   */
  adapter
    .getInstance()
    .addHook(
      "onRequest",
      (request: unknown, reply: unknown, done: () => void): void => {
        const requestId = readRequestId(request);
        if (requestId !== undefined) {
          writeResponseHeader(reply, "x-request-id", requestId);
        }
        done();
      },
    );

  return adapter;
}
