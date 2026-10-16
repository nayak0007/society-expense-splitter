import {
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  AUDIT_MAX_DEPTH,
  AUDIT_REDACTED,
  auditKeySegments,
  isAuditAction,
  isSensitiveAuditKey,
  redactAuditEntry,
  redactAuditPayload,
  type AuditEntry,
} from "../audit";

/**
 * The audit vocabulary's pure rules — T050, ADR-0014 D3.
 *
 * The redaction rule is the one piece of T050 that can leak a secret silently, so
 * it is tested exhaustively here rather than only through the database suite: the
 * unit test names every shape a payload can take, and the integration suite proves
 * the row it produces is what the writer persisted.
 */

describe("auditKeySegments", () => {
  it("splits camelCase, snake_case and kebab-case the same way", () => {
    expect(auditKeySegments("phoneNumber")).toEqual(["phone", "number"]);
    expect(auditKeySegments("phone_number")).toEqual(["phone", "number"]);
    expect(auditKeySegments("phone-number")).toEqual(["phone", "number"]);
    expect(auditKeySegments("PHONE_NUMBER")).toEqual(["phone", "number"]);
  });

  it("ignores empty segments rather than reporting them as a match", () => {
    expect(auditKeySegments("__")).toEqual([]);
    expect(isSensitiveAuditKey("__")).toBe(false);
  });

  it("keeps a multi-digit run attached to its segment", () => {
    expect(auditKeySegments("refreshToken2")).toEqual(["refresh", "token2"]);
  });
});

describe("isSensitiveAuditKey", () => {
  it.each([
    "password",
    "currentPassword",
    "accessToken",
    "refresh_token",
    "authorization",
    "cookie",
    "otpCode",
    "phone",
    "phoneNumber",
    "mobile",
    "email",
    "razorpaySignature",
    "cvv",
    "cardNumber",
    "apiKey",
    "api_key",
    "jwt",
    "credentials",
    "sessionId",
    // Over-redaction, and deliberately: `token` is a segment of the second and
    // the joined `apikey` of the first, so both are treated as sensitive. Hiding a
    // value that was safe is the direction this rule must fail in.
    "tokenCount",
  ])("redacts %s", (key) => {
    expect(isSensitiveAuditKey(key)).toBe(true);
  });

  it.each([
    "secretaryName",
    "title",
    "amountPaise",
    "fullName",
    "status",
    "entityId",
    "vendorName",
    "idempotencyKey",
    "storageKey",
  ])("leaves %s alone", (key) => {
    expect(isSensitiveAuditKey(key)).toBe(false);
  });
});

describe("redactAuditPayload", () => {
  it("normalises the non-JSON leaf values rather than refusing them", () => {
    expect(redactAuditPayload(null)).toBeNull();
    expect(redactAuditPayload(undefined)).toBeNull();
    expect(redactAuditPayload("text")).toBe("text");
    expect(redactAuditPayload(42)).toBe(42);
    expect(redactAuditPayload(true)).toBe(true);
    expect(redactAuditPayload(10n)).toBe("10");
    expect(redactAuditPayload(() => undefined)).toBeNull();
    expect(redactAuditPayload(Symbol("s"))).toBeNull();
    expect(redactAuditPayload(new Date("2026-10-10T00:00:00.000Z"))).toBe(
      "2026-10-10T00:00:00.000Z",
    );
  });

  it("redacts a sensitive value wholesale instead of descending into it", () => {
    const redacted = redactAuditPayload({
      auth: { token: "super-secret", nested: { password: "p" } },
      phoneNumber: "+91 90000 00000",
      title: "Water bill",
    });

    expect(redacted).toEqual({
      auth: { token: AUDIT_REDACTED, nested: { password: AUDIT_REDACTED } },
      phoneNumber: AUDIT_REDACTED,
      title: "Water bill",
    });
  });

  it("walks arrays and keeps their element order", () => {
    expect(
      redactAuditPayload([{ token: "t" }, "plain", [{ password: "p" }]]),
    ).toEqual([
      { token: AUDIT_REDACTED },
      "plain",
      [{ password: AUDIT_REDACTED }],
    ]);
  });

  it("replaces a payload nested past the depth ceiling", () => {
    // `AUDIT_MAX_DEPTH` objects deep: the value at the ceiling is the marker, and
    // everything above it is intact.
    let nested: Record<string, unknown> = { leaf: "bottom" };
    for (let depth = 0; depth < AUDIT_MAX_DEPTH; depth += 1) {
      nested = { a: nested };
    }

    const redacted = redactAuditPayload(nested);
    // Walk down to the boundary: one more object than the ceiling allows.
    let cursor: unknown = redacted;
    for (let depth = 0; depth < AUDIT_MAX_DEPTH - 1; depth += 1) {
      cursor = (cursor as Record<string, unknown>)["a"];
    }
    expect((cursor as Record<string, unknown>)["a"]).toBe(AUDIT_REDACTED);
  });

  it("returns an object for a plain object, and an empty one for an object with no own keys", () => {
    expect(redactAuditPayload({})).toEqual({});
    expect(redactAuditPayload(new Map())).toEqual({});
  });
});

describe("redactAuditEntry", () => {
  const entry: AuditEntry = {
    operationId: "55555555-5555-4555-8555-555555555555",
    societyId: "11111111-1111-4111-8111-111111111111",
    actorUserId: "33333333-3333-4333-8333-333333333333",
    actorRole: "admin",
    category: "other",
    action: "member.updated",
    entityType: "member",
    entityId: null,
    before: { role: "resident" },
    after: { role: "admin", accessToken: "leak" },
    metadata: { requestId: "r", cookie: "c" },
  };

  it("redacts a hand-built entry, so a call site that skipped the builder cannot leak", () => {
    const redacted = redactAuditEntry(entry);

    expect(redacted.after).toEqual({
      role: "admin",
      accessToken: AUDIT_REDACTED,
    });
    expect(redacted.metadata).toEqual({
      requestId: "r",
      cookie: AUDIT_REDACTED,
    });
    // Everything that is not a payload is untouched.
    expect(redacted.operationId).toBe(entry.operationId);
    expect(redacted.actorUserId).toBe(entry.actorUserId);
    expect(redacted.before).toEqual({ role: "resident" });
  });

  it("is idempotent, because the flush runs it a second time", () => {
    const once = redactAuditEntry(entry);
    expect(redactAuditEntry(once)).toEqual(once);
  });
});

describe("the vocabulary", () => {
  it("names two categories, because the Treasurer's audit.view narrows on one", () => {
    expect([...AUDIT_CATEGORIES]).toEqual(["financial", "other"]);
  });

  it("keeps every action in the database's dotted, lowercase shape", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(action).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
      expect(action.length).toBeLessThanOrEqual(64);
    }
  });

  it("names the reader audit, because PRD §11.7 logs who viewed the log", () => {
    expect([...AUDIT_ACTIONS]).toContain("audit.viewed");
  });
});

describe("isAuditAction", () => {
  it("narrows a known action and refuses anything else", () => {
    expect(isAuditAction("expense.published")).toBe(true);
    expect(isAuditAction("audit.viewed")).toBe(true);
    // A row written by a later deploy: shaped like an action, unknown to this build.
    expect(isAuditAction("expense.reconciled")).toBe(false);
    expect(isAuditAction("published")).toBe(false);
    expect(isAuditAction(undefined)).toBe(false);
    expect(isAuditAction(7)).toBe(false);
  });
});
