import { DomainError } from "../shared/errors";
import type { DomainErrorInit } from "../shared/errors";

/**
 * Society error codes (SAD §7: the API maps these onto HTTP — and to `404`
 * rather than `403` wherever a resource belongs to another tenant, so existence
 * is never leaked to a non-member, PRD §3.2 / T041).
 *
 * The `code` is the contract; the message is developer-facing. User-facing copy
 * is produced by the app, never by the domain.
 */
export const SOCIETY_ERROR_CODES = [
  "validation",
  "not_found",
  "forbidden",
  "join_code_invalid",
  "join_code_expired",
  "already_member",
  "sole_admin",
  "conflict",
  "unknown",
] as const;

export type SocietyErrorCode = (typeof SOCIETY_ERROR_CODES)[number];

/**
 * Extends the shared `DomainError` so generic middleware (an API exception
 * filter, a logging interceptor) can recognise every domain failure by one
 * `instanceof`, while society code keeps its narrower `code` union.
 */
export class SocietyError extends DomainError<SocietyErrorCode> {
  constructor(
    code: SocietyErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>> | undefined,
  ) {
    const init: DomainErrorInit<SocietyErrorCode> = { code, message, details };
    super(init);
    this.name = "SocietyError";
  }
}

export function isSocietyError(error: unknown): error is SocietyError {
  return error instanceof SocietyError;
}

/** Narrowing helper for `switch` exhaustiveness in use cases and services. */
export function societyErrorCode(error: unknown): SocietyErrorCode {
  return isSocietyError(error) ? error.code : "unknown";
}

/** Adapter throws → the error type every society use case promises. */
export function asSocietyError(error: unknown): SocietyError {
  if (isSocietyError(error)) return error;
  return new SocietyError(
    "unknown",
    "The society operation failed unexpectedly.",
  );
}

/** Shorthand used by the value objects and use cases. */
export function societyError(
  code: SocietyErrorCode,
  message: string,
  details?: Readonly<Record<string, unknown>> | undefined,
): SocietyError {
  return new SocietyError(code, message, details);
}
