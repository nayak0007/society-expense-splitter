import { SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { asMemberId, asSocietyId, asUserId } from "@ses/domain";
import type {
  MemberRole,
  MembershipStatus,
  SocietyMembership,
} from "@ses/domain";

import {
  RequirePermission,
  REQUIRE_PERMISSION_KEY,
} from "../../decorators/require-permission.decorator";
import { writeRequestSocietyContext } from "../../http/http-access";
import { PermissionGuard } from "../permission.guard";

/**
 * Stage 4 of the chain (SAD §9.4).
 *
 * These tests assert the guard is a thin translation of the domain's matrix and
 * nothing more: every role decision here is really `can()`, and if one of these
 * fails while the evaluator's conformance test passes, the guard has grown a rule
 * of its own.
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

const guard = new PermissionGuard(new Reflector());

function requestWith(membership: SocietyMembership | undefined) {
  const request: Record<string, unknown> = {};
  if (membership !== undefined) {
    writeRequestSocietyContext(request, {
      society: { id: SOCIETY_ID } as never,
      membership,
    });
  }
  return request;
}

describe("PermissionGuard", () => {
  it("is inert on a route that declares no permission", () => {
    expect(guard.canActivate(contextFor({}))).toBe(true);
  });

  it("reports a missing society context as an internal error, not a 403", () => {
    // A mis-wired chain is not the caller's fault, and telling them they lack a
    // permission when the application forgot to resolve one sends them to the
    // wrong place entirely.
    expect(() =>
      guard.canActivate(contextFor({}, handlerRequiring("society.edit"))),
    ).toThrow(expect.objectContaining({ code: "INTERNAL" }));
  });

  it("refuses a non-active membership with MEMBER_INACTIVE", () => {
    // A pending member knows the society exists — they applied to it — so this is
    // a 403, and 404 was never protecting anything from them.
    expect(() =>
      guard.canActivate(
        contextFor(
          requestWith(membershipOf("resident", "pending")),
          handlerRequiring("society.edit"),
        ),
      ),
    ).toThrow(expect.objectContaining({ code: "MEMBER_INACTIVE" }));
  });

  it("allows an Admin to edit the society", () => {
    expect(
      guard.canActivate(
        contextFor(
          requestWith(membershipOf("admin")),
          handlerRequiring("society.edit"),
        ),
      ),
    ).toBe(true);
  });

  it("refuses a Resident editing the society", () => {
    expect(() =>
      guard.canActivate(
        contextFor(
          requestWith(membershipOf("resident")),
          handlerRequiring("society.edit"),
        ),
      ),
    ).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("refuses a Treasurer the two actions reserved for the Admin", () => {
    for (const action of ["society.delete", "member.role_change"]) {
      expect(() =>
        guard.canActivate(
          contextFor(
            requestWith(membershipOf("treasurer")),
            handlerRequiring(action),
          ),
        ),
      ).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    }
  });

  it("allows a Treasurer the actions the PRD grants them", () => {
    for (const action of ["member.approve", "cycle.publish", "expense.void"]) {
      expect(
        guard.canActivate(
          contextFor(
            requestWith(membershipOf("treasurer")),
            handlerRequiring(action),
          ),
        ),
      ).toBe(true);
    }
  });

  it("lets a conditional grant through, to be narrowed on the record", () => {
    // The PRD grants a Committee Member their own draft expenses. Returning false
    // here would lock them out of the feature; the handler narrows instead, which
    // is why `isScopedAction` exists.
    expect(
      guard.canActivate(
        contextFor(
          requestWith(membershipOf("committee_member")),
          handlerRequiring("expense.create"),
        ),
      ),
    ).toBe(true);
  });

  it("gives a Guest nothing but gate logging", () => {
    expect(
      guard.canActivate(
        contextFor(
          requestWith(membershipOf("guest")),
          handlerRequiring("visitor.log"),
        ),
      ),
    ).toBe(true);

    expect(() =>
      guard.canActivate(
        contextFor(
          requestWith(membershipOf("guest")),
          handlerRequiring("expense.view"),
        ),
      ),
    ).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });

  it("names the action it refused, so a client can branch and report", () => {
    const error = (() => {
      try {
        guard.canActivate(
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

  it("fails loudly on an action that does not exist", () => {
    // Unreachable through `@RequirePermission`, which validates at decoration
    // time — but a hand-written `SetMetadata` must not fall through to "allow".
    expect(() =>
      guard.canActivate(contextFor({}, handlerRequiring("expense:create"))),
    ).toThrow(expect.objectContaining({ code: "INTERNAL" }));
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
