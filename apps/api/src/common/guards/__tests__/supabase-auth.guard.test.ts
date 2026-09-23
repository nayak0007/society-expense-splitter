import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";

import { AppError } from "../../errors/app-error";
import { Public } from "../../decorators/public.decorator";
import { readRequestActor } from "../../http/http-access";
import {
  SupabaseJwtVerifier,
  TokenVerificationError,
} from "../../auth/supabase-jwt";
import type { VerifiedActor } from "../../auth/actor";
import { SupabaseAuthGuard } from "../supabase-auth.guard";

/**
 * The fail-closed half of the route inventory (T041).
 *
 * The guard's job is one decision — may this request proceed — and the property
 * that matters is the *default*: a route with no decorator is protected, and a
 * `@Public()` route is the only exception. These tests drive the guard directly
 * rather than through HTTP, so the failure shape can be asserted exactly.
 */

const ACTOR: VerifiedActor = {
  userId: "9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  email: "member@example.com",
  role: "authenticated",
};

/** A context over a plain request object, which is all the guard touches. */
function contextFor(
  request: Record<string, unknown>,
  handlers: { handler: unknown; controller: unknown } = {
    handler: function handler() {},
    controller: class Controller {},
  },
): ExecutionContext {
  return {
    getHandler: () => handlers.handler,
    getClass: () => handlers.controller,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guardWith(verify: (token: string) => Promise<VerifiedActor>) {
  const verifier = { verify } as unknown as SupabaseJwtVerifier;
  return new SupabaseAuthGuard(verifier, new Reflector());
}

describe("SupabaseAuthGuard", () => {
  it("rejects a request with no Authorization header", async () => {
    const guard = guardWith(() => Promise.resolve(ACTOR));

    await expect(guard.canActivate(contextFor({}))).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("rejects a malformed Authorization header without half-parsing it", async () => {
    // A half-parsed token would only reach the verifier to fail there, and the
    // answer for "no token" and "an unparseable one" is deliberately the same.
    const guard = guardWith(() => Promise.resolve(ACTOR));

    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: "Basic abc" } }),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("accepts a valid token and leaves the actor where the rest of the request reads it", async () => {
    const guard = guardWith(() => Promise.resolve(ACTOR));
    const request: Record<string, unknown> = {
      headers: { authorization: "Bearer good-token" },
    };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);

    // The guard runs before interceptors, so the request object is the only
    // place it can hand the actor over — `@Ctx()` and the request-context
    // interceptor both read it back from here.
    expect(readRequestActor(request)).toEqual(ACTOR);
  });

  it("verifies the token it was given, not a re-serialised form of it", async () => {
    const seen: string[] = [];
    const guard = guardWith((token) => {
      seen.push(token);
      return Promise.resolve(ACTOR);
    });

    await guard.canActivate(
      contextFor({ headers: { authorization: "Bearer  spaced.token " } }),
    );

    expect(seen).toEqual(["spaced.token"]);
  });

  it("maps a verification failure onto the catalogue code the client branches on", async () => {
    const guard = guardWith(() =>
      Promise.reject(
        new TokenVerificationError("TOKEN_EXPIRED", "internal detail"),
      ),
    );

    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: "Bearer expired" } }),
      ),
    ).rejects.toMatchObject({ code: "TOKEN_EXPIRED" });
  });

  it("does not disguise an outage as a rejection", async () => {
    // A JWKS fetch that failed is our infrastructure, and telling a signed-in
    // user to sign in again would both mislead them and hide the outage.
    const guard = guardWith(() =>
      Promise.reject(
        new TokenVerificationError("DEPENDENCY_UNAVAILABLE", "jwks timeout"),
      ),
    );

    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: "Bearer anything" } }),
      ),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
  });

  it("replaces the verifier's developer-facing message with client copy", async () => {
    // The verifier's strings are diagnostics; the guard's are product copy. One
    // leaking into the other is how a 401 body tells an attacker which check
    // failed.
    const guard = guardWith(() =>
      Promise.reject(
        new TokenVerificationError(
          "UNAUTHENTICATED",
          "JWTClaimValidationFailed: iss",
        ),
      ),
    );

    await expect(
      guard.canActivate(contextFor({ headers: { authorization: "Bearer x" } })),
    ).rejects.toMatchObject({
      message: "Sign in to continue.",
    });
  });

  it("lets a failure it does not recognise propagate untouched", async () => {
    // Swallowing it would turn a bug into a 401, which is the one outcome that
    // never gets investigated.
    const guard = guardWith(() => Promise.reject(new Error("boom")));

    await expect(
      guard.canActivate(contextFor({ headers: { authorization: "Bearer x" } })),
    ).rejects.toThrow("boom");
  });

  it("skips verification entirely for a route marked @Public()", async () => {
    let called = false;
    const guard = guardWith(async () => {
      called = true;
      return ACTOR;
    });

    const handler = function handler() {};
    Public()(handler as unknown as object, "handler", {
      value: handler,
    } as unknown as PropertyDescriptor);

    await expect(
      guard.canActivate(contextFor({}, { handler, controller: class {} })),
    ).resolves.toBe(true);
    expect(called).toBe(false);
  });

  it("honours @Public() declared on the controller, so a whole controller opts out once", async () => {
    // The health controller relies on this: repeating the decorator on every
    // probe would be one more place to forget it.
    let called = false;
    const guard = guardWith(async () => {
      called = true;
      return ACTOR;
    });

    class Controller {}
    Public()(Controller);

    await expect(
      guard.canActivate(
        contextFor(
          {},
          { handler: function handler() {}, controller: Controller },
        ),
      ),
    ).resolves.toBe(true);
    expect(called).toBe(false);
  });

  it("does not treat any non-`true` metadata as public", async () => {
    // `getAllAndOverride` returns whatever was set; only an explicit `true`
    // opts out, so a stray metadata value cannot open a route.
    const guard = guardWith(() => Promise.resolve(ACTOR));

    const handler = function handler() {};
    Reflect.defineMetadata("ses:isPublic", "yes", handler);

    await expect(
      guard.canActivate(contextFor({}, { handler, controller: class {} })),
    ).rejects.toBeInstanceOf(AppError);
  });
});
