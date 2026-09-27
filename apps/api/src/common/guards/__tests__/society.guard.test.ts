import { SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { asMemberId, asSocietyId, asUserId } from "@ses/domain";
import type {
  Society,
  SocietyId,
  SocietyMembership,
  UserId,
} from "@ses/domain";

import { REQUIRE_PERMISSION_KEY } from "../../decorators/require-permission.decorator";
import type {
  SocietyAuthorizationContext,
  SocietyAuthorizationReader,
} from "../../authorization/society-authorization";
import { REQUEST_ACTOR_KEY, type VerifiedActor } from "../../auth/actor";
import {
  readRequestMembership,
  readRequestSociety,
  writeRequestActor,
} from "../../http/http-access";
import { SocietyGuard, SOCIETY_HEADER } from "../society.guard";

/**
 * Stage 3 of the chain (SAD §9.4), driven directly rather than over HTTP so each
 * refusal's *code* can be asserted exactly — the whole point of the 404-not-403
 * rule is the code, and an HTTP test that only checked "not 200" would not notice
 * it changing.
 */

const ACTOR_ID = asUserId("9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d");
const SOCIETY_ID = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");

const ACTOR: VerifiedActor = {
  userId: ACTOR_ID,
  email: "member@example.com",
  role: "authenticated",
};

const SOCIETY = { id: SOCIETY_ID, name: "Green Meadows" } as unknown as Society;
const MEMBERSHIP = {
  id: asMemberId("3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f"),
  societyId: SOCIETY_ID,
  userId: ACTOR_ID,
  role: "admin",
  status: "active",
  occupancyType: "owner",
  joinedAt: "2026-01-01T00:00:00.000Z",
} as SocietyMembership;

const RESOLVED: SocietyAuthorizationContext = {
  society: SOCIETY,
  membership: MEMBERSHIP,
};

/** Metadata on the handler is what the guard reads — set it the way Nest does. */
function handlerRequiring(action: string): () => void {
  const handler = function handler(): void {};
  SetMetadata(REQUIRE_PERMISSION_KEY, action)(handler);
  return handler;
}

function contextFor(
  request: Record<string, unknown>,
  handler: unknown = function handler() {},
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function readerOf(
  load: (
    societyId: SocietyId,
    actor: UserId,
  ) => Promise<SocietyAuthorizationContext | null>,
): { reader: SocietyAuthorizationReader; calls: () => number } {
  let calls = 0;
  return {
    reader: {
      load: (societyId, actor) => {
        calls += 1;
        return load(societyId, actor);
      },
    },
    calls: () => calls,
  };
}

function guardWith(reader: SocietyAuthorizationReader): SocietyGuard {
  return new SocietyGuard(reader, new Reflector());
}

describe("SocietyGuard", () => {
  it("is inert on a route that declares no permission", async () => {
    // The reason this guard can be global at all: most routes have no society
    // context to resolve, and requiring a header on them would be nonsense.
    const { reader, calls } = readerOf(() => Promise.resolve(RESOLVED));
    const request: Record<string, unknown> = {};

    await expect(
      guardWith(reader).canActivate(contextFor(request)),
    ).resolves.toBe(true);
    expect(calls()).toBe(0);
    expect(readRequestMembership(request)).toBeUndefined();
  });

  it("rejects an unauthenticated request before reading the header", async () => {
    const { reader, calls } = readerOf(() => Promise.resolve(RESOLVED));

    await expect(
      guardWith(reader).canActivate(
        contextFor({}, handlerRequiring("society.edit")),
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(calls()).toBe(0);
  });

  it("rejects a missing header with 400", async () => {
    const { reader, calls } = readerOf(() => Promise.resolve(RESOLVED));
    const request: Record<string, unknown> = {};
    writeRequestActor(request, ACTOR);

    await expect(
      guardWith(reader).canActivate(
        contextFor(request, handlerRequiring("society.edit")),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    // No header means no society to look up — the read must not happen.
    expect(calls()).toBe(0);
  });

  it("rejects a malformed society id with 400 and names the header", async () => {
    const { reader, calls } = readerOf(() => Promise.resolve(RESOLVED));
    const request: Record<string, unknown> = {
      headers: { [SOCIETY_HEADER]: "not-a-uuid" },
    };
    writeRequestActor(request, ACTOR);

    const error = await guardWith(reader)
      .canActivate(contextFor(request, handlerRequiring("society.edit")))
      .catch((thrown: unknown) => thrown);

    expect(error).toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
    expect((error as { payload: { field?: string } }).payload.field).toBe(
      SOCIETY_HEADER,
    );
    // A non-UUID must never reach the database: `$1::uuid` would fail there as a
    // 22P02 the error classifier can only report as an internal error.
    expect(calls()).toBe(0);
  });

  it("answers 404 — never 403 — when the caller has no membership", async () => {
    const { reader } = readerOf(() => Promise.resolve(null));
    const request: Record<string, unknown> = {
      headers: { [SOCIETY_HEADER]: SOCIETY_ID },
    };
    writeRequestActor(request, ACTOR);

    await expect(
      guardWith(reader).canActivate(
        contextFor(request, handlerRequiring("society.edit")),
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("attaches the society and the membership the rest of the request reads", async () => {
    const seen: { societyId?: string; actor?: string } = {};
    const { reader } = readerOf((societyId, actor) => {
      seen.societyId = societyId;
      seen.actor = actor;
      return Promise.resolve(RESOLVED);
    });
    const request: Record<string, unknown> = {
      headers: { [SOCIETY_HEADER]: SOCIETY_ID },
    };
    writeRequestActor(request, ACTOR);

    await expect(
      guardWith(reader).canActivate(
        contextFor(request, handlerRequiring("society.edit")),
      ),
    ).resolves.toBe(true);

    expect(seen.societyId).toBe(SOCIETY_ID);
    expect(seen.actor).toBe(ACTOR_ID);
    expect(readRequestSociety(request)).toBe(SOCIETY);
    expect(readRequestMembership(request)).toBe(MEMBERSHIP);
  });

  it("reads once per request, even when the guard runs twice", async () => {
    // "Do not query the same membership multiple times during a request" — the
    // guarantee is memoisation on the request object, so a second stage (or a
    // repeat) costs zero reads.
    const { reader, calls } = readerOf(() => Promise.resolve(RESOLVED));
    const request: Record<string, unknown> = {
      headers: { [SOCIETY_HEADER]: SOCIETY_ID },
    };
    writeRequestActor(request, ACTOR);
    const context = contextFor(request, handlerRequiring("society.edit"));

    await guardWith(reader).canActivate(context);
    await guardWith(reader).canActivate(context);

    expect(calls()).toBe(1);
  });

  it("accepts a padded, upper-case header", async () => {
    const { reader } = readerOf(() => Promise.resolve(RESOLVED));
    const request: Record<string, unknown> = {
      headers: { [SOCIETY_HEADER]: `  ${SOCIETY_ID.toUpperCase()}  ` },
    };
    writeRequestActor(request, ACTOR);

    await expect(
      guardWith(reader).canActivate(
        contextFor(request, handlerRequiring("society.edit")),
      ),
    ).resolves.toBe(true);
  });

  it("does not attach a context when it refuses", async () => {
    // A failed guard must leave nothing behind: a later layer reading a stale
    // `currentMembership` would act on someone else's tenancy.
    const { reader } = readerOf(() => Promise.resolve(null));
    const request: Record<string, unknown> = {
      headers: { [SOCIETY_HEADER]: SOCIETY_ID },
    };
    writeRequestActor(request, ACTOR);

    await guardWith(reader)
      .canActivate(contextFor(request, handlerRequiring("society.edit")))
      .catch(() => undefined);

    expect(readRequestSociety(request)).toBeUndefined();
    expect(readRequestMembership(request)).toBeUndefined();
  });

  it("keeps the actor the auth guard verified", async () => {
    const { reader } = readerOf(() => Promise.resolve(RESOLVED));
    const request: Record<string, unknown> = {
      headers: { [SOCIETY_HEADER]: SOCIETY_ID },
    };
    writeRequestActor(request, ACTOR);

    await guardWith(reader).canActivate(
      contextFor(request, handlerRequiring("society.edit")),
    );

    expect(request[REQUEST_ACTOR_KEY]).toBe(ACTOR);
  });
});
