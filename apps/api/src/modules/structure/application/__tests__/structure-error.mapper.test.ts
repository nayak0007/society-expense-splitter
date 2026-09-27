import { structureError } from "@ses/domain";
import type { StructureErrorCode } from "@ses/domain";

import { HTTP_STATUS_BY_ERROR_CODE } from "../../../../common/errors/app-error";
import {
  ERROR_CODE_BY_STRUCTURE_CODE,
  toAppError,
} from "../structure-error.mapper";

/**
 * The one place the module's rule vocabulary meets the API catalogue (SAD §7.10).
 *
 * The mapping is a `Record`, so the compiler already guarantees every domain code
 * is covered. What these tests add is that the *values* are the ones a client
 * branches on, and that the two pieces of context the mobile client needs — which
 * form field failed, and which catalogue code to switch on — survive the trip.
 */

describe("ERROR_CODE_BY_STRUCTURE_CODE", () => {
  it("maps every domain code to a catalogue code", () => {
    const codes = Object.keys(
      ERROR_CODE_BY_STRUCTURE_CODE,
    ) as StructureErrorCode[];
    expect(codes.sort()).toEqual([
      "building_has_apartments",
      "conflict",
      "forbidden",
      "not_found",
      "unknown",
      "validation",
    ]);
  });

  it("gives each one a status a client can act on", () => {
    // The statuses are the point: a conflict must not arrive as a 500, and a
    // missing membership must not arrive as a 403.
    expect(
      HTTP_STATUS_BY_ERROR_CODE[ERROR_CODE_BY_STRUCTURE_CODE.validation],
    ).toBe(422);
    expect(
      HTTP_STATUS_BY_ERROR_CODE[ERROR_CODE_BY_STRUCTURE_CODE.not_found],
    ).toBe(404);
    expect(
      HTTP_STATUS_BY_ERROR_CODE[ERROR_CODE_BY_STRUCTURE_CODE.forbidden],
    ).toBe(403);
    expect(
      HTTP_STATUS_BY_ERROR_CODE[ERROR_CODE_BY_STRUCTURE_CODE.conflict],
    ).toBe(409);
    // A structural refusal is also a 409 — the payload was fine and the state
    // refused it — and it keeps the 422 meaning "fix a field".
    expect(
      HTTP_STATUS_BY_ERROR_CODE[
        ERROR_CODE_BY_STRUCTURE_CODE.building_has_apartments
      ],
    ).toBe(409);
    expect(
      HTTP_STATUS_BY_ERROR_CODE[ERROR_CODE_BY_STRUCTURE_CODE.unknown],
    ).toBe(500);
  });
});

describe("toAppError", () => {
  it("carries a validation failure's field so a form can highlight it", () => {
    const error = toAppError(
      structureError("validation", "Enter a building name.", { field: "name" }),
    );

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.payload.field).toBe("name");
  });

  it("reports a name conflict against `name`, with a code to branch on", () => {
    // The only conflict this module produces is a duplicate name, and a form has
    // to attach it to the input the user typed.
    const error = toAppError(
      structureError("conflict", "A building with that name already exists."),
    );

    expect(error.code).toBe("CONFLICT");
    expect(error.payload.field).toBe("name");
    expect(error.payload.details?.[0]?.code).toBe("BUILDING_NAME_TAKEN");
    expect(error.payload.details?.[0]?.field).toBe("name");
  });

  it("reports a building with flats as a conflict with its own detail code", () => {
    // The one refusal that names a *different* entity as the reason, so the client
    // can send the user to the flats instead of to the name field.
    const error = toAppError(
      structureError(
        "building_has_apartments",
        "This building still has 2 flats. Remove them first.",
        { count: 2 },
      ),
    );

    expect(error.code).toBe("CONFLICT");
    expect(error.payload.details?.[0]?.code).toBe("BUILDING_HAS_APARTMENTS");
    // No field: there is nothing to correct on the building's own form.
    expect(error.payload.field).toBeUndefined();
  });

  it("keeps a domain code out of the top-level catalogue", () => {
    // `not_found` is the domain's word; `NOT_FOUND` is the wire's. A client
    // switching on the catalogue must never see the former.
    const error = toAppError(structureError("not_found", "Not available."));

    expect(error.code).toBe("NOT_FOUND");
    expect(error.payload.details).toBeUndefined();
  });

  it("does not invent a field for a forbidden failure", () => {
    const error = toAppError(
      structureError("forbidden", "Only a society Admin can do this."),
    );

    expect(error.payload.field).toBeUndefined();
    expect(error.payload.details).toBeUndefined();
  });

  it("passes the developer-facing message through as the message", () => {
    // Better than anything this layer could invent, and it is what the mobile
    // client already renders.
    const error = toAppError(
      structureError("unknown", "Something went wrong. Please try again."),
    );

    expect(error.code).toBe("INTERNAL");
    expect(error.message).toBe("Something went wrong. Please try again.");
  });

  it("ignores a non-string or empty field rather than serialising it", () => {
    const numeric = toAppError(
      structureError("validation", "Bad value.", { field: 7 }),
    );
    const blank = toAppError(
      structureError("validation", "Bad value.", { field: "" }),
    );

    expect(numeric.payload.field).toBeUndefined();
    expect(blank.payload.field).toBeUndefined();
  });
});
