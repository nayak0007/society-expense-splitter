import { Reflector } from "@nestjs/core";
import { lastValueFrom, of } from "rxjs";
import type { CallHandler, ExecutionContext } from "@nestjs/common";

import { NoEnvelope } from "../../decorators/no-envelope.decorator";
import { ResponseEnvelopeInterceptor } from "../envelope.interceptor";

/**
 * The success envelope (SAD §7.9), and the two cases where a `{ data, meta }`
 * wrapper would be dishonest or harmful.
 *
 * The interceptor is global, so the property that matters most is the *default*:
 * a handler that returns a value gets wrapped, without the handler doing
 * anything. A controller that has to remember a decorator is a controller that
 * will eventually forget one, and the resulting response is one the mobile
 * client cannot parse.
 */

function contextFor(
  url: string,
  handlers: { handler: unknown; controller: unknown } = {
    handler: function handler() {},
    controller: class Controller {},
  },
  type: "http" | "rpc" = "http",
): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => handlers.handler,
    getClass: () => handlers.controller,
    switchToHttp: () => ({ getRequest: () => ({ url }) }),
  } as unknown as ExecutionContext;
}

function handlerReturning(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

function interceptor() {
  return new ResponseEnvelopeInterceptor(new Reflector());
}

/**
 * Runs one interception and returns the handler's result.
 *
 * Typed by the caller because the interceptor is honestly `Observable<unknown>`
 * — it cannot know what a handler returns — while each assertion below knows
 * exactly what it arranged.
 */
function pass<T>(context: ExecutionContext, handler: CallHandler): Promise<T> {
  return lastValueFrom(interceptor().intercept(context, handler)) as Promise<T>;
}

describe("ResponseEnvelopeInterceptor", () => {
  it("wraps a handler's value in data and meta, without the handler opting in", async () => {
    const result = await pass<{
      data: unknown;
      meta: { requestId: string; timestamp: string };
    }>(contextFor("/v1/societies"), handlerReturning({ societies: [] }));

    expect(result).toMatchObject({ data: { societies: [] } });
    expect(result.meta.requestId).toEqual(expect.any(String));
    expect(new Date(result.meta.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("envelopes a handler that returns nothing as an empty object", async () => {
    // §7.9: `data` is always present and always an object or array, so a client
    // reading `.data` gets an object either way rather than `undefined`.
    const result = await pass<{ data: unknown }>(
      contextFor("/v1/societies"),
      handlerReturning(undefined),
    );

    expect(result.data).toEqual({});
  });

  it("passes an array through unwrapped-in-an-object, since data may be an array", async () => {
    const result = await pass<{ data: unknown }>(
      contextFor("/v1/societies"),
      handlerReturning([{ id: "a" }]),
    );

    expect(result.data).toEqual([{ id: "a" }]);
  });

  it("leaves a 204 alone, because a data member there would have to be invented", async () => {
    // The only honest exception: a delete has nothing to say, and `{ data: {} }`
    // next to a 204 would be a lie rather than a convenience.
    const handler = function handler() {};
    NoEnvelope()(handler as unknown as object, "handler", {
      value: handler,
    } as unknown as PropertyDescriptor);

    const result = await pass<undefined>(
      contextFor("/v1/societies/abc", { handler, controller: class {} }),
      handlerReturning(undefined),
    );

    expect(result).toBeUndefined();
  });

  it("leaves health probes unwrapped, so terminus's diagnosis survives", async () => {
    const body = { status: "ok", info: {}, error: {}, details: {} };

    for (const url of ["/v1/health/live", "/v1/health/ready"]) {
      const result = await pass<unknown>(
        contextFor(url),
        handlerReturning(body),
      );

      expect(result).toEqual(body);
    }
  });

  it("recognises a probe with a query string or an unversioned path", async () => {
    const body = { status: "ok" };

    for (const url of ["/v1/health/ready?verbose=1", "/health/live"]) {
      const result = await pass<unknown>(
        contextFor(url),
        handlerReturning(body),
      );

      expect(result).toEqual(body);
    }
  });

  it("does not mistake a business route for a probe", async () => {
    // The prefix match must not become a hole: no business route begins with
    // `health`, and this is the assertion that keeps it that way.
    const result = await pass<{ data: unknown }>(
      contextFor("/v1/societies/health-check"),
      handlerReturning({ ok: true }),
    );

    expect(result.data).toEqual({ ok: true });
  });

  it("passes through untouched outside HTTP, where there is no envelope to fill", async () => {
    // The worker is a standalone application context with no request; wrapping
    // there would produce a body for nobody.
    const result = await pass<unknown>(
      contextFor("", undefined, "rpc"),
      handlerReturning({ jobId: "1" }),
    );

    expect(result).toEqual({ jobId: "1" });
  });
});
