import { ATTACHMENT_ERROR_CODES, attachmentError } from "@ses/domain";

import {
  ERROR_CODE_BY_ATTACHMENT_CODE,
  toAppError,
} from "../attachment-error.mapper";

/**
 * The attachment module's error vocabulary → the API's catalogue — SAD §7.10.
 *
 * The mapping is a product decision, not a translation, so it is pinned here rather
 * than inferred from whichever use case happens to raise each failure. Two of the
 * rows are the ones worth defending:
 *
 * ```text
 *   quota_exceeded  ->  402 PLAN_LIMIT_EXCEEDED   not 500, and not a new code
 *   storage_unavailable -> 503 DEPENDENCY_UNAVAILABLE   an outage is not a defect
 * ```
 *
 * The last test is the one that keeps the table honest: it fails if a domain code is
 * ever added without a decision about what it means over HTTP.
 */

describe("the catalogue mapping", () => {
  it("covers every domain code — a new one fails this suite, not production", () => {
    expect(Object.keys(ERROR_CODE_BY_ATTACHMENT_CODE).sort()).toEqual(
      [...ATTACHMENT_ERROR_CODES].sort(),
    );
  });

  it.each([
    ["validation", "VALIDATION_ERROR", 422],
    ["not_found", "NOT_FOUND", 404],
    ["forbidden", "FORBIDDEN", 403],
    ["invalid_transition", "INVALID_TRANSITION", 409],
    ["conflict", "CONFLICT", 409],
    ["content_mismatch", "VALIDATION_ERROR", 422],
    ["quota_exceeded", "PLAN_LIMIT_EXCEEDED", 402],
    ["storage_unavailable", "DEPENDENCY_UNAVAILABLE", 503],
    ["unknown", "INTERNAL", 500],
  ] as const)("maps %s to %s (%i)", (domainCode, apiCode, status) => {
    const appError = toAppError(attachmentError(domainCode, "a message"));

    expect(appError.code).toBe(apiCode);
    expect(appError.status).toBe(status);
    expect(appError.message).toBe("a message");
  });
});

describe("the stable detail codes a client branches on", () => {
  it("tags a content mismatch so a client can say 'not the file you said'", () => {
    const appError = toAppError(
      attachmentError("content_mismatch", "the bytes are a PDF"),
    );

    expect(appError.code).toBe("VALIDATION_ERROR");
    expect(appError.payload.details).toEqual([
      {
        field: "code",
        code: "CONTENT_MISMATCH",
        message: "the bytes are a PDF",
      },
    ]);
  });

  it("tags a quota refusal on the code that already means 'upgrade'", () => {
    const appError = toAppError(
      attachmentError("quota_exceeded", "the plan is full"),
    );

    expect(appError.status).toBe(402);
    expect(appError.payload.details?.[0]?.code).toBe(
      "ATTACHMENT_QUOTA_EXCEEDED",
    );
  });

  it("tags a state refusal without inventing a new top-level code", () => {
    const appError = toAppError(
      attachmentError("conflict", "not uploaded yet"),
    );

    expect(appError.code).toBe("CONFLICT");
    expect(appError.payload.details?.[0]?.code).toBe(
      "ATTACHMENT_STATE_CONFLICT",
    );
  });

  it("emits no detail block where there is no stable code to emit", () => {
    expect(
      toAppError(attachmentError("forbidden", "no")).payload.details,
    ).toBeUndefined();
  });
});

describe("the field a form highlights", () => {
  it("carries a non-empty field through to the payload", () => {
    const appError = toAppError(
      attachmentError("validation", "unsupported", { field: "mimeType" }),
    );

    expect(appError.payload.field).toBe("mimeType");
    // The detail block uses the field when one is present, so a form can attach the
    // message to the right input rather than to the response as a whole.
    expect(
      toAppError(
        attachmentError("content_mismatch", "wrong bytes", {
          field: "mimeType",
        }),
      ).payload.details?.[0]?.field,
    ).toBe("mimeType");
  });

  it("drops an empty field rather than rendering an error bound to nothing", () => {
    const appError = toAppError(
      attachmentError("validation", "unsupported", { field: "" }),
    );

    expect(appError.payload.field).toBeUndefined();
  });

  it("ignores a non-string field", () => {
    const appError = toAppError(
      attachmentError("validation", "unsupported", { field: 42 }),
    );

    expect(appError.payload.field).toBeUndefined();
  });
});
