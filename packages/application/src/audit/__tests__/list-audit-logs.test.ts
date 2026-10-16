import { asMemberId, asSocietyId, asUserId } from "@ses/domain";
import type {
  AuditCategory,
  AuditDescriptor,
  AuditLogPage,
  AuditLogQuery,
  AuditLogReader,
  MemberSnapshot,
  ReaderAuditPlan,
} from "@ses/domain";

import { listAuditLogs } from "../use-cases/list-audit-logs";

/**
 * The audit read's own rules — Roadmap T050 Stage E1.
 *
 * No Nest, no database, no `jest.mock`: the use case is a pure function of
 * `(deps, command)`, so the fake below is the whole world it runs in. The database
 * half — RLS, the writer, the committed reader-audit row — is the integration suite's
 * (`apps/api/test/integration/audit-logs.integration-spec.ts`), and the split is
 * deliberate: a fake cannot prove a policy.
 */

const SOCIETY = asSocietyId("11111111-1111-4111-8111-111111111111");
const ME = asMemberId("33333333-3333-4333-8333-333333333333");
const ACTOR = asUserId("55555555-5555-4555-8555-555555555555");

function member(
  role: MemberSnapshot["role"],
  overrides: Partial<MemberSnapshot> = {},
): MemberSnapshot {
  return {
    membershipId: ME,
    societyId: SOCIETY,
    role,
    status: "active",
    ...overrides,
  };
}

type Recorded = {
  readonly query: AuditLogQuery;
  readonly actor: string;
  readonly descriptors: AuditDescriptor[];
};

/** A reader that answers with one canned page and records what it was asked. */
function fakeReader(
  page: AuditLogPage,
): AuditLogReader & { readonly calls: Recorded[] } {
  const calls: Recorded[] = [];

  return {
    calls,
    async list(
      query: AuditLogQuery,
      actor: string,
      readerAudit: ReaderAuditPlan,
    ): Promise<AuditLogPage> {
      const descriptors: AuditDescriptor[] = [];
      calls.push({
        query,
        actor,
        descriptors,
      });
      // The adapter runs the plan once, inside the read's transaction. Capturing the
      // descriptor here is how these tests assert what the log will record.
      descriptors.push(readerAudit(page));
      return page;
    },
  };
}

/** One row, so a page is not trivially empty. */
const ROW = {
  id: "42",
  occurredAt: "2026-10-14T10:00:00.000Z",
  category: "financial" as AuditCategory,
  action: "expense.published",
  entityType: "expense",
  entityId: "99999999-9999-4999-8999-999999999999",
  actorUserId: ACTOR,
  actorRole: "admin" as const,
  before: null,
  after: { status: "published" },
  metadata: { requestId: "req-1", ip: "203.0.113.9" },
};

const EMPTY: AuditLogPage = {
  records: [],
  nextCursor: null,
  hasMore: false,
};

const ONE: AuditLogPage = {
  records: [ROW],
  nextCursor: { occurredAt: ROW.occurredAt, id: ROW.id },
  hasMore: true,
};

describe("listAuditLogs", () => {
  it("gives an Admin both categories and records an audit.viewed entry for the read", async () => {
    const reader = fakeReader(ONE);

    const result = await listAuditLogs(
      { logs: reader },
      { actor: ACTOR, member: member("admin"), limit: 20, cursor: null },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The read ran as the caller, with the tenant and the visibility filter.
    expect(reader.calls).toHaveLength(1);
    const call = reader.calls[0]!;
    expect(call.actor).toBe(ACTOR);
    expect(call.query.societyId).toBe(SOCIETY);
    expect(call.query.categories).toEqual(["financial", "other"]);
    expect(call.query.limit).toBe(20);
    expect(call.query.cursor).toBeNull();

    // Exactly one entry, describing the access and never the page's payload.
    expect(call.descriptors).toHaveLength(1);
    expect(call.descriptors[0]).toEqual({
      societyId: SOCIETY,
      category: "other",
      action: "audit.viewed",
      entityType: "audit_log",
      entityId: null,
      before: null,
      after: null,
      metadata: {
        categories: ["financial", "other"],
        limit: 20,
        usedCursor: false,
        returned: 1,
      },
    });

    // And "other" is the whole point: a Treasurer must not learn that an Admin read.
    expect(call.descriptors[0]!.category).not.toBe("financial");
  });

  it("narrows a Treasurer to the financial half, in the query and in the audit entry", async () => {
    const reader = fakeReader(ONE);

    const result = await listAuditLogs(
      { logs: reader },
      { actor: ACTOR, member: member("treasurer"), limit: 20, cursor: null },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.categories).toEqual(["financial"]);

    const call = reader.calls[0]!;
    expect(call.query.categories).toEqual(["financial"]);
    expect(call.descriptors[0]!.metadata).toMatchObject({
      categories: ["financial"],
    });
  });

  it.each(["committee_member", "resident", "tenant", "guest"] as const)(
    "refuses a %s without reading anything at all",
    async (role) => {
      const reader = fakeReader(ONE);

      const result = await listAuditLogs(
        { logs: reader },
        { actor: ACTOR, member: member(role), limit: 20, cursor: null },
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("forbidden");
      // The refusal happens *before* the query: no reader call, and therefore no
      // reader-audit row for a read that never happened.
      expect(reader.calls).toHaveLength(0);
    },
  );

  it("refuses an Admin whose membership is not active, before reading", async () => {
    const reader = fakeReader(ONE);

    const result = await listAuditLogs(
      { logs: reader },
      {
        actor: ACTOR,
        member: member("admin", { status: "pending" }),
        limit: 20,
        cursor: null,
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("forbidden");
    expect(reader.calls).toHaveLength(0);
  });

  it("records usedCursor for a continuation without storing the cursor itself", async () => {
    const reader = fakeReader(EMPTY);
    // Both halves are deliberately distinctive: a weaker value would make the
    // absence assertions below pass by accident (`"41"` occurs inside a uuid).
    const cursor = {
      occurredAt: "2026-10-14T09:59:00.000Z",
      id: "987654321098765432",
    };

    const result = await listAuditLogs(
      { logs: reader },
      { actor: ACTOR, member: member("admin"), limit: 50, cursor },
    );

    expect(result.ok).toBe(true);
    const descriptor = reader.calls[0]!.descriptors[0]!;
    expect(descriptor.metadata).toMatchObject({
      limit: 50,
      usedCursor: true,
      returned: 0,
    });
    // A position is not a fact about the change, and a stored copy would be an
    // unreachable one — the shape of the read is all that is recorded.
    const stored = JSON.stringify(descriptor);
    expect(stored).not.toContain(cursor.occurredAt);
    expect(stored).not.toContain(cursor.id);
    expect(Object.keys(descriptor.metadata ?? {}).sort()).toEqual([
      "categories",
      "limit",
      "returned",
      "usedCursor",
    ]);
  });

  it("records an empty page as a read that happened", async () => {
    const reader = fakeReader(EMPTY);

    const result = await listAuditLogs(
      { logs: reader },
      { actor: ACTOR, member: member("admin"), limit: 20, cursor: null },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.page.records).toEqual([]);
    expect(result.value.page.hasMore).toBe(false);
    // "Somebody looked and found nothing" must not look like "nobody looked": the
    // entry exists and says how many rows came back.
    expect(reader.calls[0]!.descriptors[0]!.metadata).toMatchObject({
      returned: 0,
    });
  });

  it("classifies an adapter failure as unknown rather than fabricating an audit entry", async () => {
    const failing: AuditLogReader = {
      list: () =>
        Promise.reject(
          new Error("permission denied for function write_audit_logs"),
        ),
    };

    const result = await listAuditLogs(
      { logs: failing },
      { actor: ACTOR, member: member("admin"), limit: 20, cursor: null },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("unknown");
    // The driver's message never becomes the caller-facing sentence.
    expect(result.error.message).not.toContain("write_audit_logs");
    expect(result.error.details).toBeUndefined();
  });
});
