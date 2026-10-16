import type { AuditLogCursor } from "@ses/domain";
import { z } from "zod";

import { AppError } from "../../../common/errors/app-error";

/**
 * The audit list's opaque cursor — base64 of the sort tuple, SAD §7.4.
 *
 * The tuple is `(occurredAt, id)`, in that order, because that is the query's ordering
 * (`occurred_at DESC, id DESC`, the order `idx_audit_logs_society_occurred` provides)
 * and because `occurred_at` alone is not unique: a request that writes several entries
 * — a member import, a batch of flats — produces rows that share an instant, and a
 * cursor naming only the instant would either skip the rest of that millisecond or
 * repeat them.
 *
 * ## Why the decoder is strict, and where it is decoded
 *
 * `Buffer.from(value, "base64")` decodes whatever it is given and ignores the rest, so
 * the JSON parse and the schema check that follow are what turn a garbage cursor into a
 * refusal instead of a page starting somewhere unintended — the same three steps the
 * expense list's codec takes, and for the same reason: a client bug must not silently
 * become duplicated or skipped rows on a screen.
 *
 * The codec lives in the API's application layer rather than in `@ses/contracts` or
 * `@ses/domain` on purpose. The *wire* types the cursor as an opaque string (a
 * client never constructs one), the domain's port types the decoded tuple, and this
 * file is the only place that knows the two are the same thing — which is what keeps
 * changing the tuple a server-only edit.
 *
 * A malformed cursor is a `VALIDATION_ERROR` naming `cursor`: the value is present
 * and unusable, which is a 422 rather than the 400 an absent header gets (SAD §7.8's
 * syntactic-vs-value split).
 */

const cursorPayloadSchema = z.object({
  /** `z.iso.datetime()` accepts the column's own `toISOString()` spelling. */
  occurredAt: z.iso.datetime(),
  /** The row id, decimal — a `bigint` never becomes a JS `number` on the way. */
  id: z.string().regex(/^\d+$/),
});

/** The opaque cursor → the sort tuple, or a refusal naming `cursor`. */
export function decodeAuditCursor(cursor: string): AuditLogCursor {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
  } catch {
    throw invalidCursor();
  }

  const parsed = cursorPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalidCursor();
  }

  return { occurredAt: parsed.data.occurredAt, id: parsed.data.id };
}

/** The sort tuple → the opaque cursor. The client echoes it; it never builds one. */
export function encodeAuditCursor(cursor: AuditLogCursor): string {
  return Buffer.from(
    JSON.stringify({ occurredAt: cursor.occurredAt, id: cursor.id }),
    "utf8",
  ).toString("base64");
}

function invalidCursor(): AppError {
  return new AppError("VALIDATION_ERROR", "The cursor is not valid.", {
    field: "cursor",
  });
}
