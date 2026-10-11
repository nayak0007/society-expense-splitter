import { AUDIT_REDACTED } from "@ses/domain";

import { RequestContext } from "../../context/request-context";
import { buildAuditEntry } from "../audit-context";

/**
 * `buildAuditEntry` — T050, ADR-0014 D5.
 *
 * The property under test is *where the facts come from*: the actor, the role and
 * the request facts must be read from the server-side context and never from the
 * descriptor, which is the caller's half. And the payload must be redacted on the
 * way out, so no call site can hand the writer a token.
 */

const descriptor = {
  societyId: "11111111-1111-4111-8111-111111111111",
  category: "financial",
  action: "expense.created",
  entityType: "expense",
  entityId: "22222222-2222-4222-8222-222222222222",
  before: null,
  after: { title: "Diesel", amountPaise: "145000" },
} as const;

describe("buildAuditEntry", () => {
  it("records a system entry with no actor when there is no request context", () => {
    const entry = buildAuditEntry(descriptor);

    expect(entry.actorUserId).toBeNull();
    expect(entry.actorRole).toBeNull();
    expect(entry.metadata).toEqual({
      requestId: null,
      ip: null,
      userAgent: null,
    });
    expect(entry.operationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("takes the actor, role and request facts from the context, never the descriptor", () => {
    const entry = RequestContext.run(
      {
        requestId: "req-123",
        userId: "33333333-3333-4333-8333-333333333333",
        member: {
          membershipId: "44444444-4444-4444-8444-444444444444",
          societyId: descriptor.societyId,
          role: "treasurer",
          status: "active",
        },
        ip: "203.0.113.7",
        userAgent: "Resident360/1.0",
        audited: [],
      },
      () =>
        buildAuditEntry({
          ...descriptor,
          // A caller that tried to smuggle an actor in through the descriptor gets
          // nowhere: it is not a field the descriptor has, and metadata is data,
          // not identity.
          metadata: { source: "mobile" },
        }),
    );

    expect(entry.actorUserId).toBe("33333333-3333-4333-8333-333333333333");
    expect(entry.actorRole).toBe("treasurer");
    expect(entry.metadata).toEqual({
      requestId: "req-123",
      ip: "203.0.113.7",
      userAgent: "Resident360/1.0",
      source: "mobile",
    });
    expect(entry.category).toBe("financial");
    expect(entry.action).toBe("expense.created");
    expect(entry.entityId).toBe(descriptor.entityId);
  });

  it("redacts the payload and any sensitive metadata before it can be persisted", () => {
    const entry = buildAuditEntry({
      ...descriptor,
      before: { refreshToken: "abc", role: "resident" },
      after: { role: "admin", phoneNumber: "+91 90000 00000" },
      metadata: { apiKey: "k" },
    });

    expect(entry.before).toEqual({
      refreshToken: AUDIT_REDACTED,
      role: "resident",
    });
    expect(entry.after).toEqual({ role: "admin", phoneNumber: AUDIT_REDACTED });
    expect(entry.metadata["apiKey"]).toBe(AUDIT_REDACTED);
  });

  it("honours an explicit operation id so a replay is an explicit choice", () => {
    const operationId = "55555555-5555-4555-8555-555555555555";
    expect(buildAuditEntry({ ...descriptor, operationId }).operationId).toBe(
      operationId,
    );
  });

  it("defaults an absent entity id to null rather than leaving it undefined", () => {
    const entry = buildAuditEntry({
      societyId: descriptor.societyId,
      category: "other",
      action: "society.updated",
      entityType: "society",
    });

    expect(entry.entityId).toBeNull();
    expect(entry.before).toBeNull();
    expect(entry.after).toBeNull();
  });
});
