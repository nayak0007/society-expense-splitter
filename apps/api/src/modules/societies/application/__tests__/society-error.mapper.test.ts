import {
  ERROR_CODE_BY_SOCIETY_CODE,
  toAppError,
} from "../society-error.mapper";
import { SocietyError } from "@ses/domain";
import type { SocietyErrorCode } from "@ses/domain";

/**
 * The domain's rule vocabulary → the API's transport catalogue (SAD §7.10).
 *
 * The mapping is a `Record<SocietyErrorCode, ErrorCode>` rather than a `switch`
 * precisely so that adding a domain code fails the build until someone decides
 * what it means over HTTP — the test that matters here is the one that proves the
 * record is total, because that is the property the type alone cannot check at
 * runtime for a value that arrived from the database.
 */

describe("ERROR_CODE_BY_SOCIETY_CODE", () => {
  it("covers every code the domain can produce", () => {
    // Listed explicitly rather than derived, so a new domain code shows up as a
    // failing test as well as a compile error — the two together are what stop
    // an unmapped code reaching `undefined` and rendering as a 500.
    const codes: readonly SocietyErrorCode[] = [
      "validation",
      "not_found",
      "forbidden",
      "join_code_invalid",
      "join_code_expired",
      "already_member",
      "sole_admin",
      "conflict",
      "unknown",
    ];

    for (const code of codes) {
      expect(ERROR_CODE_BY_SOCIETY_CODE[code]).toBeDefined();
    }
    expect(Object.keys(ERROR_CODE_BY_SOCIETY_CODE).sort()).toEqual(
      [...codes].sort(),
    );
  });

  it("maps transport-shaped rules to transport-shaped codes, not to INTERNAL", () => {
    // The failure this guards against is the lazy one: a `default: "INTERNAL"`
    // would answer 500 for a rule that deserved a 403 or a 409, and the client's
    // `code`-based branching would never fire.
    const mapped = Object.entries(ERROR_CODE_BY_SOCIETY_CODE).filter(
      ([domainCode]) => domainCode !== "unknown",
    );

    for (const [domainCode, httpCode] of mapped) {
      expect([domainCode, httpCode]).not.toEqual([domainCode, "INTERNAL"]);
    }
  });
});

describe("toAppError", () => {
  it("carries the domain's message, which is what the mobile client shows today", () => {
    const error = toAppError(new SocietyError("not_found", "No such society."));

    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("No such society.");
  });

  it("forwards a field so a form can highlight the offending input", () => {
    const error = toAppError(
      new SocietyError("validation", "Enter a 6-digit PIN code.", {
        field: "pincode",
      }),
    );

    expect(error.payload.field).toBe("pincode");
  });

  it("preserves the domain's distinction in details[].code", () => {
    // The catalogue has no code of its own for an expired join code — adding one
    // is a change to a vocabulary the client branches on, not a local
    // convenience — so the distinction the client actually needs travels in
    // `details`, which is what `ErrorDetail.code` exists for.
    const expired = toAppError(
      new SocietyError("join_code_expired", "That code has expired."),
    );
    const invalid = toAppError(
      new SocietyError("join_code_invalid", "No such code."),
    );

    expect(expired.code).toBe("VALIDATION_ERROR");
    expect(expired.payload.details?.[0]?.code).toBe("JOIN_CODE_EXPIRED");
    expect(invalid.payload.details?.[0]?.code).toBe("JOIN_CODE_INVALID");
  });

  it("gives the sole-admin refusal a 403 and an actionable detail code", () => {
    const error = toAppError(
      new SocietyError("sole_admin", "You are the only Admin."),
    );

    expect(error.code).toBe("SOCIETY_ADMIN_REQUIRED");
    expect(error.status).toBe(403);
    expect(error.payload.details?.[0]?.code).toBe("SOLE_ADMIN");
  });

  it("omits details entirely for a code that has no distinction to preserve", () => {
    // SAD §7.10: `details` is present only when there is something structured to
    // say. An empty array would make every client render an empty error list.
    const error = toAppError(new SocietyError("unknown", "Something broke."));

    expect(error.payload.details).toBeUndefined();
  });

  it("never forwards a non-string field as a field path", () => {
    const error = toAppError(
      new SocietyError("validation", "Bad input.", { field: 42 }),
    );

    expect(error.payload.field).toBeUndefined();
  });
});
