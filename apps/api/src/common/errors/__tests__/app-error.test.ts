import { ERROR_CODES } from "@ses/contracts";

import {
  AppError,
  buildErrorPayload,
  completeErrorBody,
  HTTP_STATUS_BY_ERROR_CODE,
  isErrorPayload,
} from "../app-error";

describe("AppError", () => {
  it("maps every catalogue code to a status", () => {
    // Exhaustiveness is the requirement: a code present in the SAD catalogue but
    // missing here would fall through to `undefined` at runtime, and the filter
    // would reply with a status it never chose.
    for (const code of ERROR_CODES) {
      const status = HTTP_STATUS_BY_ERROR_CODE[code];
      expect(typeof status).toBe("number");
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it("derives its status from the code, and allows an override", () => {
    expect(new AppError("NOT_FOUND", "nope").status).toBe(404);
    expect(new AppError("INTERNAL", "boom", { status: 599 }).status).toBe(599);
  });

  it("omits optional members rather than emitting empty ones", () => {
    // SAD §7.10: `details` is present only for multi-field validation failures,
    // and §7.9's "nulls are explicit" is about values, not about inventing keys.
    const payload = buildErrorPayload("CONFLICT", "already exists");

    expect(payload).not.toHaveProperty("field");
    expect(payload).not.toHaveProperty("details");
    expect(payload).not.toHaveProperty("requestId");
  });

  it("completes a payload with the request-scoped fields", () => {
    const at = new Date("2026-09-19T06:31:44.812Z");
    const body = completeErrorBody(
      buildErrorPayload("VALIDATION_ERROR", "bad input"),
      "req_9k2x",
      at,
    );

    expect(body.requestId).toBe("req_9k2x");
    expect(body.timestamp).toBe("2026-09-19T06:31:44.812Z");
    expect(body.docs).toBe(
      "https://docs.societysplit.in/errors/VALIDATION_ERROR",
    );
  });

  it("recognises only payloads that carry a real catalogue code", () => {
    expect(isErrorPayload({ code: "NOT_FOUND", message: "x" })).toBe(true);
    // A foreign body — a terminus health result, a library error — must not be
    // mistaken for one of ours, or the filter would echo it as a catalogue error.
    expect(isErrorPayload({ code: "SOMETHING_ELSE", message: "x" })).toBe(
      false,
    );
    expect(isErrorPayload({ status: "error", info: {} })).toBe(false);
    expect(isErrorPayload(null)).toBe(false);
    expect(isErrorPayload("NOT_FOUND")).toBe(false);
  });
});
