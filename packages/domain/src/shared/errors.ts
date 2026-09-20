/**
 * Domain error primitives (Roadmap T011: `packages/domain/src/shared/errors.ts`).
 *
 * A `DomainError` carries a **stable machine code** and a human message. The
 * code is the contract: the API maps it onto an HTTP status (`not_found` → 404,
 * never 403 for another tenant's row, SAD §7), the mobile app maps it onto copy,
 * and a test asserts on it. Message text is for developers and operators.
 */

export const DOMAIN_ERROR_CODES = [
  "validation",
  "invariant",
  "not_found",
  "forbidden",
  "conflict",
  "unknown",
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export interface DomainErrorInit<TCode extends string> {
  readonly code: TCode;
  readonly message: string;
  /** Field-level context for form errors; never secrets or PII. */
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

export class DomainError<TCode extends string = DomainErrorCode> extends Error {
  readonly code: TCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(init: DomainErrorInit<TCode>) {
    super(init.message);
    this.name = "DomainError";
    this.code = init.code;
    this.details = init.details;
  }
}

export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}

/**
 * Domain errors are also the boundary between "expected failure" (returned as a
 * `Result`) and "unexpected throw" (an adapter bug, a transport failure). This
 * guard is what lets a use case catch a thrown error and classify it without
 * losing the code it already carried.
 */
export function hasDomainErrorCode(value: unknown, code: string): boolean {
  return isDomainError(value) && value.code === code;
}
