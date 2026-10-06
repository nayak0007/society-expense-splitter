import { expenseError } from "@ses/domain";
import type { ExpenseErrorCode } from "@ses/domain";

import { HTTP_STATUS_BY_ERROR_CODE } from "../../../../common/errors/app-error";
import {
  ERROR_CODE_BY_EXPENSE_CODE,
  toAppError,
} from "../expense-category-error.mapper";

/**
 * The one place the module's rule vocabulary meets the API catalogue (SAD §7.10).
 *
 * The mapping is a `Record`, so the compiler already guarantees every domain code is
 * covered. What these tests add is that the *values* are the ones a client branches on,
 * and that the two pieces of context the mobile client needs — which form field failed,
 * and which catalogue code to switch on — survive the trip.
 *
 * This file is also where the expense union's *unreachable* codes are pinned: the
 * lifecycle codes (T061) belong to routes that do not exist yet, and they are mapped here
 * so that T063's routes inherit an answer rather than a compile error.
 */

describe("ERROR_CODE_BY_EXPENSE_CODE", () => {
  it("maps every domain code to a catalogue code", () => {
    const codes = Object.keys(ERROR_CODE_BY_EXPENSE_CODE) as ExpenseErrorCode[];
    expect(codes.sort()).toEqual([
      "approval_required",
      "category_has_expenses",
      "conflict",
      "forbidden",
      "idempotency_key_reuse",
      "invalid_transition",
      "invariant",
      "not_found",
      "paid_obligation",
      "split_mismatch",
      "unassigned_participants",
      "unknown",
      "validation",
      "version_mismatch",
      "void_due_state_unsupported",
      "void_reason_too_short",
    ]);
  });

  it("gives each one a status a client can act on", () => {
    // The statuses are the point: a conflict must not arrive as a 500, and a missing
    // membership must not arrive as a 403.
    expect(
      HTTP_STATUS_BY_ERROR_CODE[ERROR_CODE_BY_EXPENSE_CODE.validation],
    ).toBe(422);
    expect(
      HTTP_STATUS_BY_ERROR_CODE[ERROR_CODE_BY_EXPENSE_CODE.not_found],
    ).toBe(404);
    expect(
      HTTP_STATUS_BY_ERROR_CODE[ERROR_CODE_BY_EXPENSE_CODE.forbidden],
    ).toBe(403);
    expect(HTTP_STATUS_BY_ERROR_CODE[ERROR_CODE_BY_EXPENSE_CODE.conflict]).toBe(
      409,
    );
    // A referenced category is also a 409 — the payload was fine and the state refused
    // it — which keeps 422 meaning "fix a field".
    expect(
      HTTP_STATUS_BY_ERROR_CODE[
        ERROR_CODE_BY_EXPENSE_CODE.category_has_expenses
      ],
    ).toBe(409);
    expect(HTTP_STATUS_BY_ERROR_CODE[ERROR_CODE_BY_EXPENSE_CODE.unknown]).toBe(
      500,
    );
    // T065's optimistic lock: the catalogue already has VERSION_MISMATCH, and a
    // stale write is a conflict, not an internal failure.
    expect(
      HTTP_STATUS_BY_ERROR_CODE[ERROR_CODE_BY_EXPENSE_CODE.version_mismatch],
    ).toBe(409);
    // T066's retry key, reused for a different request: the catalogue's own 409.
    expect(
      HTTP_STATUS_BY_ERROR_CODE[
        ERROR_CODE_BY_EXPENSE_CODE.idempotency_key_reuse
      ],
    ).toBe(409);
    // T066's fail-closed refusal: well formed, incomplete state, so 422.
    expect(
      HTTP_STATUS_BY_ERROR_CODE[
        ERROR_CODE_BY_EXPENSE_CODE.unassigned_participants
      ],
    ).toBe(422);
    // T069's fail-closed void refusal (ADR-0010): the payload is well formed and
    // the *state* refuses it, so 409 — the same answer `paid_obligation` gets.
    expect(
      HTTP_STATUS_BY_ERROR_CODE[
        ERROR_CODE_BY_EXPENSE_CODE.void_due_state_unsupported
      ],
    ).toBe(409);
    // T070's approval gate (ADR-0011 D4): a well-formed publish of a high-value
    // expense that is not approved yet is a 409 conflict, never a 422 — the same
    // request succeeds once an Admin decides.
    expect(
      HTTP_STATUS_BY_ERROR_CODE[ERROR_CODE_BY_EXPENSE_CODE.approval_required],
    ).toBe(409);
  });

  it("keeps the lifecycle codes mapped for the routes that will reuse them", () => {
    expect(
      HTTP_STATUS_BY_ERROR_CODE[ERROR_CODE_BY_EXPENSE_CODE.invalid_transition],
    ).toBe(409);
    // The catalogue already fixed this one at 422: the allocations must add up to the
    // total, which is a field-level correction rather than a state that may change.
    expect(
      HTTP_STATUS_BY_ERROR_CODE[ERROR_CODE_BY_EXPENSE_CODE.split_mismatch],
    ).toBe(422);
    // Not input and not a state: allocations that did not sum to the total is a bug.
    expect(
      HTTP_STATUS_BY_ERROR_CODE[ERROR_CODE_BY_EXPENSE_CODE.invariant],
    ).toBe(500);
  });
});

describe("toAppError", () => {
  it("carries a validation failure's field so a form can highlight it", () => {
    const error = toAppError(
      expenseError("validation", "Enter a category name.", { field: "name" }),
    );

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.payload.field).toBe("name");
  });

  it("does not move a field the domain already named", () => {
    // A malformed colour carries `color`; the name-conflict fallback must not be
    // applied on top of it, or the error lands on the wrong input.
    const error = toAppError(
      expenseError("validation", "Colour must be a hex value.", {
        field: "color",
      }),
    );

    expect(error.payload.field).toBe("color");
  });

  it("reports a name conflict against `name`, with a code to branch on", () => {
    const error = toAppError(
      expenseError("conflict", "A category with that name already exists."),
    );

    expect(error.code).toBe("CONFLICT");
    expect(error.payload.field).toBe("name");
    expect(error.payload.details?.[0]?.code).toBe("CATEGORY_NAME_TAKEN");
    expect(error.payload.details?.[0]?.field).toBe("name");
  });

  it("reports a referenced category as a conflict with its own detail code and no field", () => {
    const error = toAppError(
      expenseError(
        "category_has_expenses",
        "3 expenses use this category. Deactivate it instead of deleting it.",
        { count: 3 },
      ),
    );

    expect(error.code).toBe("CONFLICT");
    expect(error.payload.details?.[0]?.code).toBe("CATEGORY_HAS_EXPENSES");
    // No field: there is nothing to correct on the category's own form — the action
    // the copy points at is a different one (deactivate).
    expect(error.payload.field).toBeUndefined();
  });

  it("keeps a domain code out of the top-level catalogue", () => {
    // `not_found` is the domain's word; `NOT_FOUND` is the wire's. A client switching
    // on the catalogue must never see the former.
    const error = toAppError(expenseError("not_found", "Not available."));

    expect(error.code).toBe("NOT_FOUND");
    expect(error.payload.details).toBeUndefined();
  });

  it("renders a version conflict in the SAD §7.11 shape", () => {
    const error = toAppError(
      expenseError(
        "version_mismatch",
        "This expense was changed by someone else. Reload it and try again.",
        { field: "expectedVersion", expectedVersion: 1, currentVersion: 3 },
      ),
    );

    expect(error.code).toBe("VERSION_MISMATCH");
    expect(error.payload.field).toBe("expectedVersion");
    expect(error.payload.details?.[0]).toMatchObject({
      field: "expectedVersion",
      code: "STALE",
      received: 1,
      current: 3,
    });
  });

  it("does not invent a field for a forbidden failure", () => {
    const error = toAppError(
      expenseError(
        "forbidden",
        "Only a society Admin or Treasurer can do this.",
      ),
    );

    expect(error.payload.field).toBeUndefined();
    expect(error.payload.details).toBeUndefined();
  });

  it("passes the developer-facing message through as the message", () => {
    const error = toAppError(
      expenseError("unknown", "Something went wrong. Please try again."),
    );

    expect(error.code).toBe("INTERNAL");
    expect(error.message).toBe("Something went wrong. Please try again.");
  });

  it("ignores a non-string or empty field rather than serialising it", () => {
    const numeric = toAppError(
      expenseError("validation", "Bad value.", { field: 7 }),
    );
    const blank = toAppError(
      expenseError("validation", "Bad value.", { field: "" }),
    );

    expect(numeric.payload.field).toBeUndefined();
    expect(blank.payload.field).toBeUndefined();
  });
});
