/**
 * Typed domain errors (SAD §7: the API maps these codes onto HTTP — and to
 * `404` rather than `403` wherever a resource belongs to another tenant, so
 * existence is never leaked to a non-member, PRD §3.2 / T041).
 *
 * The `code` is the contract; the message is developer-facing. User-facing
 * copy is produced by the app (`toUserMessage`), never by the domain.
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

export class SocietyError extends Error {
  readonly code: SocietyErrorCode;

  constructor(code: SocietyErrorCode, message: string) {
    super(message);
    this.name = "SocietyError";
    this.code = code;
  }
}

export function isSocietyError(error: unknown): error is SocietyError {
  return error instanceof SocietyError;
}

/** Narrowing helper for `switch` exhaustiveness in services. */
export function societyErrorCode(error: unknown): SocietyErrorCode {
  return isSocietyError(error) ? error.code : "unknown";
}
