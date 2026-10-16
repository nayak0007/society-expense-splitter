import type { AuditLogPage } from "@ses/domain";

import { encodeAuditCursor } from "../../application/audit-cursor";
import { auditLogPageToDto, auditLogRecordToDto } from "../audit-log.mapper";

/**
 * The row → wire projection — T050 Stage E1.
 *
 * This is the file that decides disclosure, so the assertions are mostly about what is
 * **absent**: the two internal request facts, the writer's idempotency key and the
 * reader-audit row's own details must not be reachable from a response.
 */

const RECORD = {
  id: "77",
  occurredAt: "2026-10-14T10:00:00.000Z",
  category: "financial" as const,
  action: "expense.published",
  entityType: "expense",
  entityId: "99999999-9999-4999-8999-999999999999",
  actorUserId: "55555555-5555-4555-8555-555555555555",
  actorRole: "treasurer" as const,
  before: { status: "draft" },
  after: { status: "published" },
  metadata: {
    requestId: "req-42",
    ip: "203.0.113.9",
    userAgent: "Mozilla/5.0 (test)",
    expenseId: "99999999-9999-4999-8999-999999999999",
  },
};

describe("auditLogRecordToDto", () => {
  it("projects the stored row and lifts the request id out of metadata", () => {
    expect(auditLogRecordToDto(RECORD)).toEqual({
      id: "77",
      occurredAt: "2026-10-14T10:00:00.000Z",
      category: "financial",
      action: "expense.published",
      entityType: "expense",
      entityId: "99999999-9999-4999-8999-999999999999",
      actorUserId: "55555555-5555-4555-8555-555555555555",
      actorRole: "treasurer",
      before: { status: "draft" },
      after: { status: "published" },
      requestId: "req-42",
      metadata: {
        expenseId: "99999999-9999-4999-8999-999999999999",
      },
    });
  });

  it("never returns the IP or the user agent, for anybody", () => {
    const dto = auditLogRecordToDto(RECORD);
    const serialised = JSON.stringify(dto);

    expect(dto.metadata).not.toHaveProperty("ip");
    expect(dto.metadata).not.toHaveProperty("userAgent");
    expect(serialised).not.toContain("203.0.113.9");
    expect(serialised).not.toContain("Mozilla/5.0");
  });

  it("keeps requestId in exactly one place", () => {
    const dto = auditLogRecordToDto(RECORD);
    expect(dto.requestId).toBe("req-42");
    expect(dto.metadata).not.toHaveProperty("requestId");
  });

  it("does not mutate the stored metadata it projects", () => {
    // The row is persisted JSON: the `delete`s the projection performs must happen on
    // a copy, or the caller's object would lose fields it is still entitled to read.
    const metadata = { ...RECORD.metadata };
    auditLogRecordToDto({ ...RECORD, metadata });

    expect(metadata).toEqual(RECORD.metadata);
  });

  it("answers null for a write that recorded no request id", () => {
    const dto = auditLogRecordToDto({
      ...RECORD,
      metadata: { requestId: null, ip: "203.0.113.9" },
    });
    expect(dto.requestId).toBeNull();
    expect(dto.metadata).toEqual({});
  });

  it("never returns operationId, because it is not on the read row at all", () => {
    const dto = auditLogRecordToDto(RECORD);
    expect(dto).not.toHaveProperty("operationId");
    expect(dto).not.toHaveProperty("societyId");
  });
});

describe("auditLogPageToDto", () => {
  it("maps a page and re-encodes the cursor, so a client only ever echoes it", () => {
    const page: AuditLogPage = {
      records: [RECORD],
      nextCursor: { occurredAt: RECORD.occurredAt, id: RECORD.id },
      hasMore: true,
    };

    const dto = auditLogPageToDto(page);

    expect(dto.entries).toHaveLength(1);
    expect(dto.hasMore).toBe(true);
    expect(dto.nextCursor).toBe(
      encodeAuditCursor({ occurredAt: RECORD.occurredAt, id: RECORD.id }),
    );
  });

  it("answers a null cursor and hasMore false on the last page", () => {
    const dto = auditLogPageToDto({
      records: [],
      nextCursor: null,
      hasMore: false,
    });

    expect(dto).toEqual({ entries: [], nextCursor: null, hasMore: false });
  });
});
