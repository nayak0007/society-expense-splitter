/**
 * The `Idempotency-Key` header's shape — SAD §7.7.
 *
 * > "Mandatory on every POST that moves money or creates a billing artefact:
 * > `/payments/intent`, `/payments/verify`, `/payments/offline`, `/expenses`,
 * > `/expenses/:id/publish`, `/cycles/:id/publish`, `/sync/batch`."
 *
 * The key is **opaque** to the server: the document's example is a UUID and the
 * mobile outbox's `opId` will be one too, but nothing in the protocol requires that
 * shape — a client that mints `expense-9f2c…` is making the same promise. What the
 * server does require is that the value is a *usable* registry key: non-blank, and
 * bounded so a hostile caller cannot store a megabyte per request in the durable
 * record.
 *
 * The bounds live here rather than in a contract or a migration for the reason
 * every bound in this package does: the wire schema, the use case's own check and
 * (later) the payments module's key all have to agree about where the limit is, and
 * three copies of `8`/`128` is three chances for one of them to move.
 */

/** Eight characters is the shortest value no client would mint by accident. */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;

/** The column is `text`, so this is a policy bound rather than a storage one. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/**
 * Whether a raw header value may be used as an idempotency key.
 *
 * It trims first, because a header value can arrive with surrounding whitespace and
 * `" abcdefgh "` is the same promise as `"abcdefgh"`; a *blank* value is refused
 * rather than normalised, because "no key" is a fact a caller must not be able to
 * smuggle past `required`.
 *
 * The parameter admits `undefined`/`null` deliberately. The HTTP route validates the
 * header with a pipe before the handler runs, so on that path a missing key is
 * already a `400` — but the use case is also called directly (unit tests, a job, a
 * future internal publisher) and its own guard is the one place "there is no usable
 * key" becomes a typed refusal. A non-total `isUsableIdempotencyKey` would turn a
 * missing value into a `TypeError` on `.trim()`, i.e. a `500` where a `422` belongs.
 */
export function isUsableIdempotencyKey(
  value: string | null | undefined,
): boolean {
  if (typeof value !== "string") {
    return false;
  }
  const trimmed = value.trim();
  return (
    trimmed.length >= IDEMPOTENCY_KEY_MIN_LENGTH &&
    trimmed.length <= IDEMPOTENCY_KEY_MAX_LENGTH
  );
}

/** The canonical form stored and compared — trimmed, never otherwise rewritten. */
export function normaliseIdempotencyKey(value: string): string {
  return value.trim();
}
