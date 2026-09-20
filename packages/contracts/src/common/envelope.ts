import { z } from "zod";

/**
 * The API success envelope — SAD §7.9.
 *
 * Rules the shape encodes, rather than leaving to convention:
 *  - `data` is always present on success and is an object or array, never a bare
 *    scalar, so a field can be added later without a breaking change.
 *  - Money is always `*Paise` as an integer; timestamps are ISO-8601 UTC with
 *    milliseconds. Both are asserted here so a DTO cannot drift.
 *  - Nulls are explicit. A field is never omitted to mean null.
 */

/** SAD §7.9: ISO-8601 UTC with milliseconds — e.g. `2026-09-19T06:31:44.812Z`. */
export const isoDateTimeSchema = z.iso.datetime();
/** SAD §7.9/§18.1: dates without a time are `YYYY-MM-DD`. */
export const isoDateSchema = z.iso.date();
/** SAD §18.1: every money field is integer paise, suffixed `Paise`. Never a float. */
export const paiseValueSchema = z.number().int();

export const envelopeMetaSchema = z.object({
  /** Correlates to logs, traces and the audit trail (SAD §17.4). */
  requestId: z.string(),
  timestamp: isoDateTimeSchema,
});
export type EnvelopeMeta = z.infer<typeof envelopeMetaSchema>;

export const envelopeSchema = z.object({
  data: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]),
  meta: envelopeMetaSchema,
});
export type Envelope = z.infer<typeof envelopeSchema>;

/**
 * Types the `data` member of an envelope. Used by the API's envelope interceptor
 * (T020) and by client contract tests that assert unknown fields are ignored
 * (SAD §7.3).
 */
export function successEnvelopeSchema<T extends z.ZodType>(data: T) {
  return z.object({ data, meta: envelopeMetaSchema });
}
