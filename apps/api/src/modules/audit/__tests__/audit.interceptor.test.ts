import { Reflector } from "@nestjs/core";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { lastValueFrom, of } from "rxjs";

import { RequestContext } from "../../../common/context/request-context";
import { AuditInterceptor } from "../audit.interceptor";
import { AuditService } from "../audit.service";
import { AUDITED_ACTIONS, Audited } from "../audited.decorator";

/**
 * The `@Audited()` pipeline — T050, ADR-0014 D7.
 *
 * The declaration is metadata; the interceptor copies it into the request's audit
 * plan and otherwise leaves the handler alone. That is the whole contract, and
 * both halves are asserted here: a declared route records its actions, and an
 * undeclared one costs a metadata lookup and nothing else.
 */

class DeclaredController {
  @Audited("expense.created", "expense.updated")
  create(): void {
    /* the handler's body is irrelevant to the declaration */
  }

  undeclared(): void {
    /* no @Audited() */
  }
}

function contextFor(handler: (...args: never[]) => unknown): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => DeclaredController,
  } as unknown as ExecutionContext;
}

function callHandler(value: string): CallHandler {
  return { handle: () => of(value) } as CallHandler;
}

/**
 * A fresh store per test, because `declareAudit` mutates it: sharing one object
 * would let the first test's declaration leak into the "declared nothing" case and
 * make that assertion pass for the wrong reason.
 */
function requestStore() {
  return {
    requestId: "req-audit",
    userId: "33333333-3333-4333-8333-333333333333",
    member: undefined,
    ip: undefined,
    userAgent: undefined,
    audited: [] as readonly string[],
  };
}

describe("@Audited", () => {
  it("stores the declared actions under the key the interceptor reads", () => {
    const reflector = new Reflector();
    const metadata = reflector.get<readonly string[]>(
      AUDITED_ACTIONS,
      DeclaredController.prototype.create,
    );

    expect(metadata).toEqual(["expense.created", "expense.updated"]);
  });

  it("leaves an undecorated method with no metadata at all", () => {
    const reflector = new Reflector();
    expect(
      reflector.get(AUDITED_ACTIONS, DeclaredController.prototype.undeclared),
    ).toBeUndefined();
  });
});

describe("AuditInterceptor", () => {
  const reflector = new Reflector();
  let service: AuditService;

  beforeEach(() => {
    service = new AuditService();
  });

  it("declares the route's actions into the request context", async () => {
    const interceptor = new AuditInterceptor(reflector, service);

    await RequestContext.run(requestStore(), async () => {
      const result = await lastValueFrom(
        interceptor.intercept(
          contextFor(DeclaredController.prototype.create),
          callHandler("created"),
        ),
      );

      expect(result).toBe("created");
      expect(RequestContext.audited()).toEqual([
        "expense.created",
        "expense.updated",
      ]);
      expect(service.isAuditedRoute()).toBe(true);
    });
  });

  it("is inert on a route that declared nothing", async () => {
    const interceptor = new AuditInterceptor(reflector, service);

    await RequestContext.run(requestStore(), async () => {
      const result = await lastValueFrom(
        interceptor.intercept(
          contextFor(DeclaredController.prototype.undeclared),
          callHandler("ok"),
        ),
      );

      expect(result).toBe("ok");
      expect(RequestContext.audited()).toEqual([]);
      expect(service.isAuditedRoute()).toBe(false);
    });
  });

  it("has nowhere to write outside a request, and does not throw", async () => {
    const interceptor = new AuditInterceptor(reflector, service);

    // No `RequestContext.run`: the store is absent, which is what a unit test that
    // calls a controller directly looks like. Declaring must be a no-op rather
    // than an error inside request handling.
    const result = await lastValueFrom(
      interceptor.intercept(
        contextFor(DeclaredController.prototype.create),
        callHandler("created"),
      ),
    );

    expect(result).toBe("created");
    expect(service.isAuditedRoute()).toBe(false);
  });
});
