import { z } from "zod";

/**
 * The API error contract — SAD §7.10.
 *
 * Lives in `@ses/contracts` (not the API) because the mobile client branches on
 * `error.code`, so the catalogue is a shared vocabulary: a code that exists on
 * one side and not the other is a silent mis-branch rather than a type error.
 *
 * WHY THIS FILE EXISTS NOW: Roadmap T010 is marked complete but the `common/`
 * deliverables it names — the envelope and error schemas — were never written,
 * and the API's validation pipe cannot report `VALIDATION_ERROR` without the
 * catalogue. This closes that gap rather than defining a second, local list.
 */

/**
 * Stable machine-readable codes. Clients branch on `code`, never on `message`
 * (SAD §7.10) — which is why `message` is the localisable field and this list is
 * the exhaustive enum, verbatim from the SAD.
 */
export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "TOKEN_EXPIRED",
  "TOKEN_REUSED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "CONFLICT",
  "VERSION_MISMATCH",
  "DUPLICATE_RESOURCE",
  "IDEMPOTENCY_KEY_REUSE",
  "RATE_LIMITED",
  "PLAN_LIMIT_EXCEEDED",
  "PAYMENT_FAILED",
  "PAYMENT_ALREADY_VERIFIED",
  "SIGNATURE_INVALID",
  "SPLIT_MISMATCH",
  "INVALID_TRANSITION",
  "UNSETTLED_DUES",
  "CYCLE_ALREADY_PUBLISHED",
  "SOCIETY_ADMIN_REQUIRED",
  "MEMBER_INACTIVE",
  "UPGRADE_REQUIRED",
  "DEPENDENCY_UNAVAILABLE",
  "INTERNAL",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * One field-level problem. `details` is present only for multi-field validation
 * failures (SAD §7.10); `received` / `limit` / `current` are the three extra
 * context fields the SAD's own examples use.
 */
export const errorDetailSchema = z.object({
  field: z.string(),
  code: z.string(),
  message: z.string(),
  received: z.unknown().optional(),
  limit: z.unknown().optional(),
  current: z.unknown().optional(),
});
export type ErrorDetail = z.infer<typeof errorDetailSchema>;

/**
 * `docs` is derived from the code rather than stored, so a new code cannot ship
 * with a broken documentation link.
 */
export const errorBodySchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  field: z.string().optional(),
  details: z.array(errorDetailSchema).optional(),
  requestId: z.string(),
  timestamp: z.string(),
  docs: z.string().optional(),
});
export type ErrorBody = z.infer<typeof errorBodySchema>;

export const errorEnvelopeSchema = z.object({
  error: errorBodySchema,
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** SAD §7.10: `https://docs.societysplit.in/errors/<CODE>`. */
export function errorDocsUrl(code: ErrorCode): string {
  return `https://docs.societysplit.in/errors/${code}`;
}

export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value);
}
