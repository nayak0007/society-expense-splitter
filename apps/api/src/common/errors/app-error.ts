import {
  errorDocsUrl,
  isErrorCode,
  type ErrorBody,
  type ErrorCode,
  type ErrorDetail,
} from "@ses/contracts";

/**
 * The single place an `ErrorCode` becomes an HTTP status.
 *
 * Declarative rather than a `switch` at each call site, because the SAD's
 * catalogue (SAD §7.10) and the status it maps to are two halves of one decision:
 * a code handled in one place with a hard-coded status and in another with a
 * different one is how clients that branch on `code` start seeing contradictory
 * behaviour. `Record<ErrorCode, number>` makes the mapping exhaustive — adding a
 * code to the catalogue fails the build here until its status is chosen.
 */
export const HTTP_STATUS_BY_ERROR_CODE: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_REUSED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 422,
  CONFLICT: 409,
  VERSION_MISMATCH: 409,
  DUPLICATE_RESOURCE: 409,
  IDEMPOTENCY_KEY_REUSE: 409,
  RATE_LIMITED: 429,
  PLAN_LIMIT_EXCEEDED: 402,
  PAYMENT_FAILED: 402,
  PAYMENT_ALREADY_VERIFIED: 409,
  SIGNATURE_INVALID: 400,
  SPLIT_MISMATCH: 422,
  INVALID_TRANSITION: 409,
  UNSETTLED_DUES: 409,
  CYCLE_ALREADY_PUBLISHED: 409,
  SOCIETY_ADMIN_REQUIRED: 403,
  MEMBER_INACTIVE: 403,
  UPGRADE_REQUIRED: 426,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL: 500,
};

/**
 * An error body before the framework adds the request-scoped fields.
 *
 * The split exists so producers (a validation pipe, a use case) never have to
 * know the request id, while consumers always receive the complete SAD §7.10
 * shape. `docs` is derived from the code, never stored.
 */
export type ErrorPayload = Omit<ErrorBody, "requestId" | "timestamp" | "docs">;

export function buildErrorPayload(
  code: ErrorCode,
  message: string,
  extras: { field?: string; details?: readonly ErrorDetail[] } = {},
): ErrorPayload {
  const payload: ErrorPayload = { code, message };
  if (extras.field !== undefined) {
    payload.field = extras.field;
  }
  if (extras.details !== undefined && extras.details.length > 0) {
    payload.details = [...extras.details];
  }
  return payload;
}

/** Completes a payload into the wire shape. `now` is injectable for tests only. */
export function completeErrorBody(
  payload: ErrorPayload,
  requestId: string,
  now: Date = new Date(),
): ErrorBody {
  return {
    ...payload,
    requestId,
    timestamp: now.toISOString(),
    docs: errorDocsUrl(payload.code),
  };
}

/** Narrows an arbitrary thrown response body to a payload this API produced. */
export function isErrorPayload(value: unknown): value is ErrorPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { code?: unknown; message?: unknown };
  return (
    typeof candidate.code === "string" &&
    isErrorCode(candidate.code) &&
    typeof candidate.message === "string"
  );
}

/**
 * A domain failure carrying a catalogue code.
 *
 * Use cases return `Result`, so this is what a presentation-layer boundary
 * throws once a `Result` is unwrapped — it keeps the code, the message and the
 * status decision in one object, and the exception filter renders it without
 * knowing which use case produced it.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly payload: ErrorPayload;

  /** Optional override; the catalogue's status is the default. */
  private readonly statusOverride?: number;

  constructor(
    code: ErrorCode,
    message: string,
    extras: {
      field?: string;
      details?: readonly ErrorDetail[];
      status?: number;
    } = {},
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.payload = buildErrorPayload(code, message, extras);
    if (extras.status !== undefined) {
      this.statusOverride = extras.status;
    }
  }

  get status(): number {
    return this.statusOverride ?? HTTP_STATUS_BY_ERROR_CODE[this.code];
  }

  static notFound(message: string): AppError {
    return new AppError("NOT_FOUND", message);
  }

  static forbidden(message: string): AppError {
    return new AppError("FORBIDDEN", message);
  }

  static conflict(message: string): AppError {
    return new AppError("CONFLICT", message);
  }

  static internal(message: string): AppError {
    return new AppError("INTERNAL", message);
  }
}
