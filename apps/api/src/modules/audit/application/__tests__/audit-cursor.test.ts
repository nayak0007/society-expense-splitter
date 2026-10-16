import { AppError } from "../../../../common/errors/app-error";
import { decodeAuditCursor, encodeAuditCursor } from "../audit-cursor";

/**
 * The audit cursor's codec — T050 Stage E1, SAD §7.4.
 *
 * The codec is the only thing standing between a client's opaque string and a `where`
 * clause, so the assertions are about the *refusals* as much as the round trip: a
 * cursor that decodes to something unintended is a page that silently starts somewhere
 * else, which a screen shows as duplicated or skipped history.
 */

const TUPLE = {
  occurredAt: "2026-10-14T09:59:00.000Z",
  id: "987654321098765432",
};

describe("encodeAuditCursor / decodeAuditCursor", () => {
  it("round-trips the sort tuple", () => {
    expect(decodeAuditCursor(encodeAuditCursor(TUPLE))).toEqual(TUPLE);
  });

  it("keeps the id a digit string, so a bigint never becomes a JS number", () => {
    const encoded = encodeAuditCursor(TUPLE);
    const decoded = decodeAuditCursor(encoded);
    expect(typeof decoded.id).toBe("string");
    // Past `Number.MAX_SAFE_INTEGER`: a numeric round trip would have changed it.
    expect(decoded.id).toBe("987654321098765432");
    expect(encoded).not.toContain("987654321098765432");
  });

  it.each([
    "not-a-cursor",
    "",
    Buffer.from("hello", "utf8").toString("base64"),
    Buffer.from(
      JSON.stringify({ occurredAt: TUPLE.occurredAt }),
      "utf8",
    ).toString("base64"),
    Buffer.from(
      JSON.stringify({ occurredAt: "not-a-date", id: TUPLE.id }),
      "utf8",
    ).toString("base64"),
    Buffer.from(
      JSON.stringify({ occurredAt: TUPLE.occurredAt, id: "41; drop table" }),
      "utf8",
    ).toString("base64"),
    Buffer.from(
      JSON.stringify({ occurredAt: 7, id: Number(TUPLE.id) }),
      "utf8",
    ).toString("base64"),
  ])("refuses a malformed cursor with a 422 naming the cursor", (cursor) => {
    expect(() => decodeAuditCursor(cursor)).toThrow(AppError);
    try {
      decodeAuditCursor(cursor);
    } catch (error: unknown) {
      const appError = error as AppError;
      expect(appError.code).toBe("VALIDATION_ERROR");
      expect(appError.status).toBe(422);
      expect(appError.payload.field).toBe("cursor");
    }
  });
});
