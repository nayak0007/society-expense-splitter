import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import {
  AUDIT_REDACTED,
  DEFAULT_SOCIETY_SETTINGS,
  asMemberId,
  asSocietyId,
  asUserId,
} from "@ses/domain";
import type {
  MemberRole,
  MembershipStatus,
  Society,
  SocietyId,
  SocietyMembership,
  UserId,
} from "@ses/domain";
import request from "supertest";

import type { SocietyAuthorizationContext } from "../src/common/authorization/society-authorization";
import {
  auditLogRecordFixture,
  createFakeAuditLogReader,
  type FakeAuditLogReader,
} from "./utils/fake-audit-log-reader";
import { createTestAuth, type TestAuth } from "./utils/supabase-auth";
import { createTestApp } from "./utils/test-app";

/**
 * `GET /v1/audit-logs` over real HTTP — T050 Stage E1, PRD §11.7, ADR-0014 D13.
 *
 * ## What runs for real
 *
 * The whole guard chain — a real signed token, `X-Society-Id` resolved to a live
 * membership by `SocietyGuard`, the matrix asked for `audit.view` by
 * `PermissionGuard` — the contract's `ZodPipe` parsing the query, `listAuditLogs`'
 * visibility decision, `AuditLogOperations`' cursor decoding and `Result`
 * unwrapping, the disclosure projection in `audit-log.mapper.ts`, and the global
 * envelope. Only the **storage** is faked, which is the boundary every other suite
 * in this directory draws.
 *
 * ## What only the integration suite can prove
 *
 * The RLS policy (`can_view_audit`) answering under a real `SET ROLE`, the keyset
 * SQL and its index, the one-extra-row `hasMore`, the `bigint` id surviving the
 * round trip as text, and the reader-audit row actually committing inside the
 * read's own transaction. This file pins the HTTP surface and the projection a
 * client receives.
 *
 * ## The reader audit is asserted through the fake, deliberately
 *
 * The port makes the plan a **required** parameter, so the fake records what it was
 * handed and what the plan produced. That is how a suite can fail on "the endpoint
 * quietly stopped recording who viewed the log" without a database — the property
 * the route inventory's `MANDATED_READ_AUDIT` manifest asserts statically, asserted
 * here dynamically.
 */

const SOCIETY_A = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const SOCIETY_B = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

const ADMIN: UserId = asUserId("11111111-1111-4111-8111-111111111111");
const TREASURER: UserId = asUserId("22222222-2222-4222-8222-222222222222");
const COMMITTEE: UserId = asUserId("77777777-7777-4777-8777-777777777777");
const RESIDENT: UserId = asUserId("33333333-3333-4333-8333-333333333333");
const GUEST: UserId = asUserId("44444444-4444-4444-8444-444444444444");

function membershipOf(
  actor: UserId,
  role: MemberRole,
  status: MembershipStatus = "active",
  societyId: SocietyId = SOCIETY_A,
): SocietyMembership {
  return {
    id: asMemberId(`10000000-0000-4000-8000-${actor.slice(-12)}`),
    societyId,
    userId: actor,
    role,
    status,
    occupancyType: "owner",
    joinedAt: "2026-01-01T00:00:00.000Z",
  };
}

const societies = new Map<string, Society>([
  [
    SOCIETY_A,
    {
      id: SOCIETY_A,
      name: "Green Meadows",
      city: "Pune",
      type: "apartment",
      deletedAt: null,
      settings: { ...DEFAULT_SOCIETY_SETTINGS },
    } as unknown as Society,
  ],
]);

const memberships = new Map<string, SocietyMembership>();
const key = (societyId: string, actor: string) => `${societyId}:${actor}`;

const reader = {
  load(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyAuthorizationContext | null> {
    const membership = memberships.get(key(societyId, actor));
    const society = societies.get(societyId);
    if (membership === undefined || society === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ society, membership });
  },
};

let app: NestFastifyApplication;
let auth: TestAuth;
let auditLogs: FakeAuditLogReader;

beforeAll(async () => {
  auth = await createTestAuth();
  auditLogs = createFakeAuditLogReader();

  app = await createTestApp({ jwks: auth.jwks, reader, auditLogs });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  memberships.clear();
  memberships.set(key(SOCIETY_A, ADMIN), membershipOf(ADMIN, "admin"));
  memberships.set(
    key(SOCIETY_A, TREASURER),
    membershipOf(TREASURER, "treasurer"),
  );
  memberships.set(
    key(SOCIETY_A, COMMITTEE),
    membershipOf(COMMITTEE, "committee_member"),
  );
  memberships.set(key(SOCIETY_A, RESIDENT), membershipOf(RESIDENT, "resident"));
  memberships.set(key(SOCIETY_A, GUEST), membershipOf(GUEST, "guest"));
  memberships.set(
    key(SOCIETY_B, ADMIN),
    membershipOf(ADMIN, "admin", "active", SOCIETY_B),
  );

  auditLogs.state.calls.length = 0;
  auditLogs.state.plans.length = 0;
  auditLogs.state.descriptors.length = 0;
  auditLogs.state.failure = null;
  auditLogs.seed([]);
});

const server = () => request(app.getHttpServer());

async function call(
  path = "/v1/audit-logs",
  options: {
    readonly userId?: UserId;
    readonly societyId?: string | null;
    readonly token?: string;
  } = {},
): Promise<request.Response> {
  let pending = server().get(path);
  const bearer =
    options.token ??
    (options.userId === undefined
      ? undefined
      : await auth.token(options.userId));
  if (bearer !== undefined) {
    pending = pending.set("Authorization", `Bearer ${bearer}`);
  }
  if (options.societyId !== null && options.societyId !== undefined) {
    pending = pending.set("X-Society-Id", options.societyId);
  }
  return pending;
}

/** Three rows at distinct instants, newest first: financial, other, financial. */
function seedThree(): void {
  auditLogs.seed([
    auditLogRecordFixture({
      id: "3",
      occurredAt: "2026-10-03T00:00:00.000Z",
      category: "financial",
      action: "expense.published",
    }),
    auditLogRecordFixture({
      id: "2",
      occurredAt: "2026-10-02T00:00:00.000Z",
      category: "other",
      action: "member.role_assigned",
      entityType: "member",
      before: { role: "resident" },
      after: { role: "treasurer" },
    }),
    auditLogRecordFixture({
      id: "1",
      occurredAt: "2026-10-01T00:00:00.000Z",
      category: "financial",
      action: "expense.created",
    }),
  ]);
}

describe("GET /v1/audit-logs — the guard chain", () => {
  it("requires a session before anything else", async () => {
    const response = await call("/v1/audit-logs", { societyId: SOCIETY_A });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("refuses a request that names no society, as a 400", async () => {
    const response = await call("/v1/audit-logs", { userId: ADMIN });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("x-society-id");
    // Nothing was read: the refusal happens before the port is reached.
    expect(auditLogs.state.calls).toHaveLength(0);
  });

  it("answers 404 — not 403 — for a society the caller is not in", async () => {
    const response = await call("/v1/audit-logs", {
      userId: RESIDENT,
      societyId: SOCIETY_B,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("refuses a Resident, a Guest and a Committee member with 403", async () => {
    for (const userId of [RESIDENT, GUEST, COMMITTEE]) {
      const response = await call("/v1/audit-logs", {
        userId,
        societyId: SOCIETY_A,
      });

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    }
    // `audit.view` is Admin full and Treasurer financial-only (PRD §2.1), so none of
    // these three ever reaches the query.
    expect(auditLogs.state.calls).toHaveLength(0);
  });

  it("refuses a membership that is not active, naming that rather than the role", async () => {
    memberships.set(
      key(SOCIETY_A, ADMIN),
      membershipOf(ADMIN, "admin", "pending"),
    );

    const response = await call("/v1/audit-logs", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("MEMBER_INACTIVE");
    expect(auditLogs.state.calls).toHaveLength(0);
  });

  it("returns the log in the standard envelope, with a request id", async () => {
    seedThree();

    const response = await call("/v1/audit-logs", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(typeof response.body.meta.requestId).toBe("string");
    expect(response.body.data.hasMore).toBe(false);
    expect(response.body.data.nextCursor).toBeNull();
  });
});

describe("GET /v1/audit-logs — the page", () => {
  it("shows an Admin the whole log, newest first", async () => {
    seedThree();

    const response = await call("/v1/audit-logs", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(
      (response.body.data.entries as { action: string }[]).map(
        (entry) => entry.action,
      ),
    ).toEqual(["expense.published", "member.role_assigned", "expense.created"]);
  });

  it("narrows a Treasurer to the financial half, in the query and not after the fetch", async () => {
    seedThree();

    const response = await call("/v1/audit-logs", {
      userId: TREASURER,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(
      (response.body.data.entries as { category: string }[]).map(
        (entry) => entry.category,
      ),
    ).toEqual(["financial", "financial"]);
    // The filter travelled *into* the read: `auditVisibleCategories` answered from the
    // matrix, and the adapter's query carries the answer. A post-filter would return
    // the same two rows here while reading the third — which is the bug this asserts
    // against.
    expect(auditLogs.state.calls[0]?.query.categories).toEqual(["financial"]);
  });

  it("asks for both halves on behalf of an Admin", async () => {
    await call("/v1/audit-logs", { userId: ADMIN, societyId: SOCIETY_A });

    expect(auditLogs.state.calls[0]?.query.categories).toEqual([
      "financial",
      "other",
    ]);
  });

  it("answers an empty page rather than a 404, and still records the read", async () => {
    const response = await call("/v1/audit-logs", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    expect(response.body.data.entries).toEqual([]);
    expect(response.body.data.hasMore).toBe(false);
    expect(auditLogs.state.descriptors).toHaveLength(1);
    expect(auditLogs.state.descriptors[0]?.metadata).toMatchObject({
      returned: 0,
    });
  });

  it("scopes the query to the society the header resolved", async () => {
    await call("/v1/audit-logs", { userId: ADMIN, societyId: SOCIETY_A });

    expect(auditLogs.state.calls[0]?.query.societyId).toBe(SOCIETY_A);
    expect(auditLogs.state.calls[0]?.actor).toBe(ADMIN);
  });
});

describe("GET /v1/audit-logs — the disclosure projection", () => {
  it("drops the IP and the user agent for everybody, including an Admin", async () => {
    auditLogs.seed([
      auditLogRecordFixture({
        metadata: {
          requestId: "req-42",
          ip: "203.0.113.7",
          userAgent: "Mozilla/5.0 (iPhone)",
          expenseId: "20000000-0000-4000-8000-000000000001",
        },
      }),
    ]);

    const response = await call("/v1/audit-logs", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    const entry = (response.body.data.entries as Record<string, unknown>[])[0]!;
    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata).not.toHaveProperty("ip");
    expect(metadata).not.toHaveProperty("userAgent");
    // What the writer added for correlation is still there.
    expect(metadata.expenseId).toBe("20000000-0000-4000-8000-000000000001");
    // And the raw body never carried it either — the check is on the serialised
    // response, not only on the parsed field.
    expect(JSON.stringify(response.body)).not.toContain("203.0.113.7");
    expect(JSON.stringify(response.body)).not.toContain("Mozilla/5.0");
  });

  it("lifts the request id out of metadata into a field of its own", async () => {
    auditLogs.seed([
      auditLogRecordFixture({ metadata: { requestId: "req-42" } }),
    ]);

    const response = await call("/v1/audit-logs", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    const entry = (response.body.data.entries as Record<string, unknown>[])[0]!;
    expect(entry.requestId).toBe("req-42");
    expect(entry.metadata).not.toHaveProperty("requestId");
  });

  it("reports a missing request id as null rather than omitting the field", async () => {
    auditLogs.seed([auditLogRecordFixture({ metadata: {} })]);

    const response = await call("/v1/audit-logs", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    const entry = (response.body.data.entries as Record<string, unknown>[])[0]!;
    expect(entry.requestId).toBeNull();
    expect(entry).toHaveProperty("requestId");
  });

  it("carries an action this build does not know as an opaque name", async () => {
    // The column is regex-shaped rather than an enum so a later deploy can record a
    // name an older build has never heard of. The read must not crash on it and must
    // not silently drop the row.
    auditLogs.seed([
      auditLogRecordFixture({ action: "expense.something_new" }),
    ]);

    const response = await call("/v1/audit-logs", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(200);
    const entry = (response.body.data.entries as Record<string, unknown>[])[0]!;
    expect(entry.action).toBe("expense.something_new");
  });

  it("returns a system write's null actor and role as explicit nulls", async () => {
    auditLogs.seed([
      auditLogRecordFixture({ actorUserId: null, actorRole: null }),
    ]);

    const response = await call("/v1/audit-logs", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    const entry = (response.body.data.entries as Record<string, unknown>[])[0]!;
    expect(entry.actorUserId).toBeNull();
    expect(entry.actorRole).toBeNull();
    expect(entry).toHaveProperty("actorUserId");
    expect(entry).toHaveProperty("actorRole");
  });

  it("returns the before and after payloads as stored, unredacted a second time", async () => {
    auditLogs.seed([
      auditLogRecordFixture({
        before: { status: "draft" },
        after: { status: "published", [AUDIT_REDACTED]: true },
      }),
    ]);

    const response = await call("/v1/audit-logs", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    const entry = (response.body.data.entries as Record<string, unknown>[])[0]!;
    expect(entry.before).toEqual({ status: "draft" });
    // The marker is returned as it is stored: the payload was redacted at the write
    // boundary, so the read has nothing left to remove and must not blank a field.
    expect(entry.after).toEqual({
      status: "published",
      [AUDIT_REDACTED]: true,
    });
  });
});

describe("GET /v1/audit-logs — the cursor", () => {
  it("defaults the page size to 20 and clamps a larger request to 100", async () => {
    await call("/v1/audit-logs", { userId: ADMIN, societyId: SOCIETY_A });
    expect(auditLogs.state.calls[0]?.query.limit).toBe(20);

    await call("/v1/audit-logs?limit=1000", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(auditLogs.state.calls[1]?.query.limit).toBe(100);
  });

  it("refuses a limit the schema cannot hold rather than rounding it", async () => {
    const response = await call("/v1/audit-logs?limit=0", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    // 422, not 400: `0` is the right *shape* and the wrong *value*, which is SAD
    // §7.8's stage-2 answer. A `limit` the contract cannot hold is refused rather than
    // coerced up to a page the client did not ask for.
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("limit");
    expect(auditLogs.state.calls).toHaveLength(0);
  });

  it("refuses a malformed cursor rather than starting somewhere else", async () => {
    const response = await call("/v1/audit-logs?cursor=not-a-cursor", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("cursor");
    // A cursor that could not be decoded is refused *before* the read, so no page is
    // returned and no reader-audit row is minted for an access that never happened.
    expect(auditLogs.state.calls).toHaveLength(0);
    expect(auditLogs.state.descriptors).toHaveLength(0);
  });

  it("refuses an unknown query parameter rather than ignoring it", async () => {
    const response = await call("/v1/audit-logs?category=financial", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("paginates with the opaque cursor without repeating or skipping a row", async () => {
    seedThree();

    const first = await call("/v1/audit-logs?limit=1", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(first.status).toBe(200);
    expect(
      (first.body.data.entries as { id: string }[]).map((entry) => entry.id),
    ).toEqual(["3"]);
    expect(first.body.data.hasMore).toBe(true);

    const cursor = first.body.data.nextCursor as string;
    expect(typeof cursor).toBe("string");
    // Opaque on the wire — not JSON, and not a shape a client may construct. What it
    // encodes is the sort tuple, in the order the query orders by, which is what makes
    // changing the tuple a server-only edit.
    expect(() => JSON.parse(cursor) as unknown).toThrow();
    expect(
      JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as unknown,
    ).toEqual({ occurredAt: "2026-10-03T00:00:00.000Z", id: "3" });

    const second = await call(
      `/v1/audit-logs?limit=1&cursor=${encodeURIComponent(cursor)}`,
      { userId: ADMIN, societyId: SOCIETY_A },
    );
    expect(second.status).toBe(200);
    expect(
      (second.body.data.entries as { id: string }[]).map((entry) => entry.id),
    ).toEqual(["2"]);
    // The cursor reached the port as the decoded tuple, not as the wire string.
    expect(auditLogs.state.calls[1]?.query.cursor).toEqual({
      occurredAt: "2026-10-03T00:00:00.000Z",
      id: "3",
    });
  });

  it("breaks a shared instant by id, so a page boundary cannot skip a row", async () => {
    // Two rows written by one request share a millisecond — the case the tuple's id
    // half exists for. A timestamp-only cursor would repeat or skip one of them.
    auditLogs.seed([
      auditLogRecordFixture({
        id: "9",
        occurredAt: "2026-10-01T00:00:00.000Z",
      }),
      auditLogRecordFixture({
        id: "8",
        occurredAt: "2026-10-01T00:00:00.000Z",
      }),
      auditLogRecordFixture({
        id: "7",
        occurredAt: "2026-10-01T00:00:00.000Z",
      }),
    ]);

    const first = await call("/v1/audit-logs?limit=2", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(
      (first.body.data.entries as { id: string }[]).map((entry) => entry.id),
    ).toEqual(["9", "8"]);

    const second = await call(
      `/v1/audit-logs?limit=2&cursor=${encodeURIComponent(
        first.body.data.nextCursor as string,
      )}`,
      { userId: ADMIN, societyId: SOCIETY_A },
    );
    expect(
      (second.body.data.entries as { id: string }[]).map((entry) => entry.id),
    ).toEqual(["7"]);
    expect(second.body.data.hasMore).toBe(false);
  });
});

describe("GET /v1/audit-logs — the log records who viewed it", () => {
  it("hands the reader a plan for every read, and records the access", async () => {
    seedThree();

    await call("/v1/audit-logs?limit=2", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(auditLogs.state.plans).toHaveLength(1);
    expect(auditLogs.state.descriptors).toHaveLength(1);

    const descriptor = auditLogs.state.descriptors[0]!;
    expect(descriptor.action).toBe("audit.viewed");
    // `other`, not `financial`: accessing the log is an event, not financial state —
    // which is also why a Treasurer cannot see these rows (PRD §2.1, ADR-0014 D13).
    expect(descriptor.category).toBe("other");
    expect(descriptor.entityType).toBe("audit_log");
    expect(descriptor.entityId).toBeNull();
    // A read transitions nothing, so both snapshots are null rather than a page's
    // contents copied into an append-only table.
    expect(descriptor.before).toBeNull();
    expect(descriptor.after).toBeNull();
    expect(descriptor.societyId).toBe(SOCIETY_A);
    expect(descriptor.metadata).toEqual({
      categories: ["financial", "other"],
      limit: 2,
      usedCursor: false,
      returned: 2,
    });
  });

  it("records the visibility that applied, not the caller's role", async () => {
    seedThree();

    await call("/v1/audit-logs", { userId: TREASURER, societyId: SOCIETY_A });

    expect(auditLogs.state.descriptors[0]?.metadata).toEqual({
      categories: ["financial"],
      limit: 20,
      usedCursor: false,
      returned: 2,
    });
  });

  it("records that a scroll continued, without storing the cursor", async () => {
    seedThree();

    const first = await call("/v1/audit-logs?limit=1", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    const cursor = first.body.data.nextCursor as string;

    const second = await call(
      `/v1/audit-logs?limit=1&cursor=${encodeURIComponent(cursor)}`,
      { userId: ADMIN, societyId: SOCIETY_A },
    );

    expect(second.status).toBe(200);
    const metadata = auditLogs.state.descriptors[1]?.metadata as Record<
      string,
      unknown
    >;
    expect(metadata.usedCursor).toBe(true);
    expect(metadata.returned).toBe(1);
    // The cursor names a position. A stored copy would be a second, unreachable copy
    // of a query parameter; `usedCursor` is the only part with audit meaning.
    expect(JSON.stringify(auditLogs.state.descriptors[1])).not.toContain(
      cursor,
    );
  });

  it("does not record an access for a read that failed", async () => {
    auditLogs.state.failure = auditErrorStub();

    const response = await call("/v1/audit-logs", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    // A read whose audit write failed rolls back and must not be reported as a page
    // (ADR-0014 D13's failure semantics) — the adapter throws, and the module's
    // classifier renders it as a fixed 500.
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe("INTERNAL");
    // The plan was supplied — the port makes it a required parameter — but a page that
    // was never read has no access to describe.
    expect(auditLogs.state.plans).toHaveLength(1);
    expect(auditLogs.state.descriptors).toHaveLength(0);
  });

  it("never leaks the driver's own message for a failed read", async () => {
    auditLogs.state.failure = auditErrorStub();

    const response = await call("/v1/audit-logs", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });

    expect(JSON.stringify(response.body)).not.toContain("write_audit_logs");
    expect(JSON.stringify(response.body)).not.toContain("password");
  });

  it("shows a reader their own access row on a later request, never in the response it produced", async () => {
    // What the previous request wrote — an `audit.viewed` row, category `other`.
    auditLogs.seed([
      auditLogRecordFixture({
        id: "2",
        occurredAt: "2026-10-02T00:00:00.000Z",
        category: "other",
        action: "audit.viewed",
        entityType: "audit_log",
        entityId: null,
        before: null,
        after: null,
        metadata: { categories: ["financial", "other"], returned: 1 },
      }),
      auditLogRecordFixture({
        id: "1",
        occurredAt: "2026-10-01T00:00:00.000Z",
        category: "financial",
        action: "expense.published",
      }),
    ]);

    const admin = await call("/v1/audit-logs", {
      userId: ADMIN,
      societyId: SOCIETY_A,
    });
    expect(
      (admin.body.data.entries as { action: string }[]).map(
        (entry) => entry.action,
      ),
    ).toEqual(["audit.viewed", "expense.published"]);
    // The row this request produced is not in its own page: it is written after the
    // read, which is also what keeps the page from shifting under its own cursor.
    expect(auditLogs.state.descriptors).toHaveLength(1);

    const treasurer = await call("/v1/audit-logs", {
      userId: TREASURER,
      societyId: SOCIETY_A,
    });
    // A Treasurer sees the financial half only, and `audit.viewed` is `other` — so
    // they do not get to see who read the log, including their own read by an Admin.
    expect(
      (treasurer.body.data.entries as { action: string }[]).map(
        (entry) => entry.action,
      ),
    ).toEqual(["expense.published"]);
  });
});

/**
 * The failure the fake throws: a raw driver error, not an `AuditError`.
 *
 * That is the direction that matters. A rolled-back reader-audit write arrives as
 * `42501 permission denied for function write_audit_logs`, and it is the use case's
 * `asAuditError` that turns it into the module's fixed sentence — so a suite that
 * injected an already-classified `AuditError` would skip the step under test and
 * would pass on a build that leaked the Postgres message.
 */
function auditErrorStub(): Error {
  const error = new Error("permission denied for function write_audit_logs");
  error.name = "PostgresError";
  return error;
}
