import { DomainError } from "../shared/errors";
import type { DomainErrorInit } from "../shared/errors";

/**
 * Structure error codes — the building module's failure vocabulary.
 *
 * Deliberately a **separate** union from `SocietyErrorCode` rather than shared
 * with it. The two modules fail differently (a society has join codes and a
 * sole-admin invariant; a building has a display order and a name clash) and a
 * merged union would let a use case emit a code its own module has no meaning
 * for. The API maps each union onto the SAD §7.10 catalogue separately, which is
 * where they meet.
 *
 * Codes here are rules, not transports: `not_found` means "the caller may not
 * know this building exists", which the API renders as `404` — never `403`, since
 * a distinguishable answer lets a caller enumerate another tenant's structure
 * (SAD §7.2, PRD T041).
 */
export const STRUCTURE_ERROR_CODES = [
  "validation",
  "not_found",
  "forbidden",
  "conflict",
  /**
   * A building that still contains live apartments cannot be removed.
   *
   * A code of its own rather than a `conflict`, because the two say different
   * things to the user and need different copy: a `conflict` here is a duplicate
   * name the form can fix, while this is a structural refusal that names a
   * *different entity* as the reason. Collapsing them would force the UI to match
   * on a message string to tell "rename it" from "empty it first".
   *
   * The rule is enforced twice — `deleteBuilding` in `@ses/application` (which is
   * what produces the message, without a round trip) and
   * `building_soft_delete()` in the database (which is the line no writer can
   * bypass).
   */
  "building_has_apartments",
  "unknown",
] as const;

export type StructureErrorCode = (typeof STRUCTURE_ERROR_CODES)[number];

/**
 * Extends the shared `DomainError` so generic middleware (the API's exception
 * filter, a logging interceptor) recognises every domain failure by one
 * `instanceof`, while structure code keeps its narrower `code` union.
 */
export class StructureError extends DomainError<StructureErrorCode> {
  constructor(
    code: StructureErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>> | undefined,
  ) {
    const init: DomainErrorInit<StructureErrorCode> = {
      code,
      message,
      details,
    };
    super(init);
    this.name = "StructureError";
  }
}

export function isStructureError(error: unknown): error is StructureError {
  return error instanceof StructureError;
}

/** Narrowing helper for `switch` exhaustiveness in use cases and adapters. */
export function structureErrorCode(error: unknown): StructureErrorCode {
  return isStructureError(error) ? error.code : "unknown";
}

/**
 * Adapter throws → the error type every structure use case promises.
 *
 * Anything that is not already a `StructureError` is reported as `unknown`: the
 * adapter is expected to classify its own failures (see `building.rows.ts` on the
 * API side), and a second guess here would replace a precise `forbidden` with a
 * generic message.
 */
export function asStructureError(error: unknown): StructureError {
  if (isStructureError(error)) return error;
  return new StructureError(
    "unknown",
    "The building operation failed unexpectedly.",
  );
}

/** Shorthand used by the value objects and use cases. */
export function structureError(
  code: StructureErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>> | undefined,
): StructureError {
  return new StructureError(code, message, details);
}
