import { SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { asMemberId, asSocietyId, asUserId } from "@ses/domain";
import type {
  MemberRole,
  MembershipStatus,
  SocietyMembership,
} from "@ses/domain";

import type {
  PermissionRefusal,
  SecurityEventRecorder,
} from "../../authorization/security-event-recorder";
import {
  RequirePermission,
  REQUIRE_PERMISSION_KEY,
} from "../../decorators/require-permission.decorator";
import { writeRequestActor } from "../../http/http-access";
import { writeRequestSocietyContext } from "../../http/http-access";
import { PermissionGuard } from "../permission.guard";

/**
 * Stage 4 of the chain (SAD §9.4), and Stage E2's refusal record (ADR-0014 D14).
 *
 * These tests assert the guard is a thin translation of the domain's matrix and
 * nothing more: every role decision here is really `can()`, and if one of these
 * fails while the evaluator's conformance test passes, the guard has grown a rule
 * of its own.
 *
 * The refusal half is asserted at the boundary the guard actually owns: *what* it hands
 * the recorder (the resolved society, the verified actor, the role the matrix refused, the
 * declared action, the reason) and *when* it does not hand anything over. Whether that row
 * reaches the database is the recorder's own suite, and whether the HTTP answer is
 * unchanged is the e2e suite's.
 */

const SOCIETY_ID = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");

function membershipOf(
  role: MemberRole,
  status: MembershipStatus = "active",
): SocietyMembership {
  return {
    id: asMemberId("3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f"),
    societyId: SOCIETY_ID,
    userId: asUserId("9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"),
    role,
    status,
    occupancyType: "owner",
    joinedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Metadata the way Nest sets it, so the guard's real lookup path is exercised. */
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

/** A recorder that keeps what it was handed, and can be told to fail. */
function recordingRecorder(options: { readonly fail?: boolean } = {}): {
  readonly recorder: SecurityEventRecorder;
  readonly refusals: PermissionRefusal[];
} {
  const refusals: PermissionRefusal[] = [];
  return {
    refusals,
    recorder: {
      recordRefusal: (refusal: PermissionRefusal): Promise<void> => {
        if (options.fail === true) {
          return Promise.reject(new Error("the writer is unreachable"));
        }
        refusals.push(refusal);
        return Promise.resolve();
      },
    },
  };
}

let recorded: PermissionRefusal[] = [];
let guard: PermissionGuard;

beforeEach(() => {
  const recorder = recordingRecorder();
  recorded = recorder.refusals;
  guard = new PermissionGuard(new Reflector(), recorder.recorder);
});

function requestWith(
  membership: SocietyMembership | undefined,
  // `null` rather than `undefined` means "no actor": a default parameter fires on an
  // explicit `undefined` too, which is exactly the mistake this signature prevents.
  actor: { readonly userId: string } | null = {
    userId: "9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  },
) {
  const request: Record<string, unknown> = {};
  if (actor !== null) {
    writeRequestActor(request, {
      userId: actor.userId,
      email: null,
      role: "authenticated",
    });
  }
  if (membership !== undefined) {
    writeRequestSocietyContext(request, {
      society: { id: SOCIETY_ID } as never,
      membership,
    });
  }
  return request;
}

describe("PermissionGuard", () => {
  it("is inert on a route that declares no permission", async () => {
    await expect(guard.canActivate(contextFor({}))).resolves.toBe(true);
  });

  it("reports a missing society context as an internal error, not a 403", async () => {
    // A mis-wired chain is not the caller's fault, and telling them they lack a
    // permission when the application forgot to resolve one sends them to the
    // wrong place entirely.
    await expect(
      guard.canActivate(contextFor({}, handlerRequiring("society.edit"))),
    ).rejects.toThrow(expect.objectContaining({ code: "INTERNAL" }));
  });

  it("refuses a non-active membership with MEMBER_INACTIVE", async () => {
    // A pending member knows the society exists — they applied to it — so this is
    // a 403, and 404 was never protecting anything from them.
    await expect(
      guard.canActivate(
        contextFor(
          requestWith(membershipOf("resident", "pending")),
          handlerRequiring("society.edit"),
        ),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "MEMBER_INACTIVE" }));
  });

  it("allows an Admin to edit the society", async () => {
    await expect(
      guard.canActivate(
        contextFor(
          requestWith(membershipOf("admin")),
          handlerRequiring("society.edit"),
        ),
      ),
    ).resolves.toBe(true);
  });

  it("refuses a Resident editing the society", async () => {
    await expect(
      guard.canActivate(
        contextFor(
          requestWith(membershipOf("resident")),
          handlerRequiring("society.edit"),
        ),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("refuses a Treasurer the two actions reserved for the Admin", async () => {
    for (const action of ["society.delete", "member.role_change"]) {
      await expect(
        guard.canActivate(
          contextFor(
            requestWith(membershipOf("treasurer")),
            handlerRequiring(action),
          ),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    }
  });

  it("allows a Treasurer the actions the PRD grants them", async () => {
    for (const action of ["member.approve", "cycle.publish", "expense.void"]) {
      await expect(
        guard.canActivate(
          contextFor(
            requestWith(membershipOf("treasurer")),
            handlerRequiring(action),
          ),
        ),
      ).resolves.toBe(true);
    }
  });

  it("lets a conditional grant through, to be narrowed on the record", async () => {
    // The PRD grants a Committee Member their own draft expenses. Returning false
    // here would lock them out of the feature; the handler narrows instead, which
    // is why `isScopedAction` exists.
    await expect(
      guard.canActivate(
        contextFor(
          requestWith(membershipOf("committee_member")),
          handlerRequiring("expense.create"),
        ),
      ),
    ).resolves.toBe(true);
  });

  it("gives a Guest nothing but gate logging", async () => {
    await expect(
      guard.canActivate(
        contextFor(
          requestWith(membershipOf("guest")),
          handlerRequiring("visitor.log"),
        ),
      ),
    ).resolves.toBe(true);

    await expect(
      guard.canActivate(
        contextFor(
          requestWith(membershipOf("guest")),
          handlerRequiring("expense.view"),
        ),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("names the action it refused, so a client can branch and report", async () => {
    const error = await (async () => {
      try {
        await guard.canActivate(
          contextFor(
            requestWith(membershipOf("resident")),
            handlerRequiring("report.export"),
          ),
        );
        return undefined;
      } catch (thrown: unknown) {
        return thrown as { payload: { message: string } };
      }
    })();

    expect(error?.payload.message).toContain("report.export");
  });

  it("fails loudly on an action that does not exist", async () => {
    // Unreachable through `@RequirePermission`, which validates at decoration
    // time — but a hand-written `SetMetadata` must not fall through to "allow".
    await expect(
      guard.canActivate(contextFor({}, handlerRequiring("expense:create"))),
    ).rejects.toThrow(expect.objectContaining({ code: "INTERNAL" }));
  });
});

describe("PermissionGuard — the refusal record (Stage E2)", () => {
  it("records a role refusal with the resolved society, actor and action", async () => {
    await expect(
      guard.canActivate(
        contextFor(
          requestWith(membershipOf("resident")),
          handlerRequiring("expense.publish"),
        ),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "FORBIDDEN" }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      societyId: SOCIETY_ID,
      actorUserId: "9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      actorRole: "resident",
      reason: "role_denied",
      action: "expense.publish",
      handler: "handler",
    });
    // The route is named by controller and handler, never by a URL: a path or a query
    // would carry the identifiers a 404 exists to hide.
    expect(JSON.stringify(recorded[0])).not.toContain("http");
  });

  it("records an inactive membership as its own reason", async () => {
    await expect(
      guard.canActivate(
        contextFor(
          requestWith(membershipOf("treasurer", "pending")),
          handlerRequiring("cycle.publish"),
        ),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "MEMBER_INACTIVE" }));

    expect(recorded.map((refusal) => refusal.reason)).toEqual([
      "member_inactive",
    ]);
    // The role is still the row's role: a pending Treasurer is recorded as a Treasurer
    // whose membership is not active, not as a role that was refused.
    expect(recorded[0]?.actorRole).toBe("treasurer");
  });

  it("records nothing when the request is allowed", async () => {
    await expect(
      guard.canActivate(
        contextFor(
          requestWith(membershipOf("admin")),
          handlerRequiring("society.edit"),
        ),
      ),
    ).resolves.toBe(true);

    expect(recorded).toEqual([]);
  });

  it("records nothing on a route that declares no permission", async () => {
    await expect(guard.canActivate(contextFor({}))).resolves.toBe(true);
    expect(recorded).toEqual([]);
  });

  it("records nothing for a mis-wired chain, which has no membership to name", async () => {
    await expect(
      guard.canActivate(contextFor({}, handlerRequiring("society.edit"))),
    ).rejects.toThrow(expect.objectContaining({ code: "INTERNAL" }));

    expect(recorded).toEqual([]);
  });

  it("records nothing when there is no verified actor", async () => {
    // `SupabaseAuthGuard` runs first, so this is unreachable over HTTP — and the guard
    // must not invent an actor to record. A row's actor is a verified fact.
    await expect(
      guard.canActivate(
        contextFor(
          requestWith(membershipOf("resident"), null),
          handlerRequiring("society.edit"),
        ),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "FORBIDDEN" }));

    expect(recorded).toEqual([]);
  });

  it("still refuses when the recorder itself fails", async () => {
    // The recorder's contract is "never throws", and this is why: the refusal is the
    // correct answer whether or not its record could be written (ADR-0014 D14).
    const failing = recordingRecorder({ fail: true });
    const failingGuard = new PermissionGuard(new Reflector(), failing.recorder);

    await expect(
      failingGuard.canActivate(
        contextFor(
          requestWith(membershipOf("resident")),
          handlerRequiring("society.edit"),
        ),
      ),
    ).rejects.toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });
});

describe("RequirePermission decorator", () => {
  it("rejects an unknown action when it is applied", () => {
    // Fails at import, and therefore in every test run, rather than on the one
    // request that needed the route.
    expect(() => RequirePermission("expense:create" as never)).toThrow(
      /not a known action/,
    );
  });

  it("accepts a real action", () => {
    expect(() => RequirePermission("expense.create")).not.toThrow();
  });
});
