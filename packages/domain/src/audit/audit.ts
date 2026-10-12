import type { MemberRole } from "../society/society";

/**
 * The audit vocabulary — Roadmap T050, ADR-0014.
 *
 * Pure data and pure rules only: no Nest, no Drizzle, no request objects. The API
 * layer assembles an `AuditEntry` from these types plus trusted request context
 * (`apps/api/src/common/audit/`), and the database is the persistence authority
 * (`supabase/migrations/*_audit_logs.sql`). Keeping the vocabulary here means the
 * redaction rule has exactly one implementation and is unit-testable without a
 * database or a framework — the same reason every other domain rule lives in this
 * package.
 */

/**
 * The two audit categories the permission matrix knows about.
 *
 * `financial` is the one a Treasurer's `audit.view` narrows to
 * (`packages/domain/src/member/resource-authorization.ts`: "Treasurer: 🟡 financial
 * only"), so the split is a product rule and not a display concern.
 */
export const AUDIT_CATEGORIES = ["financial", "other"] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/**
 * The actions a Stage A call site may record.
 *
 * A TypeScript union rather than a free string, so a typo is a compile error at
 * the call site. It is deliberately **not** mirrored as a database enum: the
 * migration constrains `action` with a shape regex
 * (`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`), so a later task can record a new
 * action without a schema change while still being unable to write an arbitrary
 * string. The union is the developer-facing contract; the regex is the database's.
 */
export const AUDIT_ACTIONS = [
  "expense.created",
  "expense.updated",
  "expense.deleted",
  "expense.published",
  "expense.voided",
  "expense.recalculated",
  "expense.approved",
  "expense.rejected",
  "member.created",
  "member.updated",
  "member.role_assigned",
  "member.role_revoked",
  "member.suspended",
  "member.reactivated",
  "member.removed",
  "member.join_approved",
  "member.join_rejected",
  "invitation.created",
  "invitation.accepted",
  "invitation.revoked",
  "society.updated",
  "society.join_code_rotated",
  "building.created",
  "building.updated",
  "building.deleted",
  "apartment.created",
  "apartment.updated",
  "apartment.deleted",
  "expense.category_created",
  "expense.category_updated",
  "expense.category_deleted",
  "expense.comment_added",
  "expense.comment_deleted",
  "expense.gst_updated",
  "attachment.created",
  "attachment.completed",
  "attachment.deleted",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * A JSON value after redaction — the shape `before`/`after`/`metadata` are
 * persisted as. Spelled out rather than `unknown` so the writer's boundary is a
 * type and not a comment: once a payload has been through `redactAuditPayload` it
 * contains no `undefined`, no `Date` and nothing JSON cannot carry.
 */
export type AuditJson =
  | null
  | boolean
  | number
  | string
  | readonly AuditJson[]
  | { readonly [key: string]: AuditJson };

/** The value a redacted field is replaced with. Never the original. */
export const AUDIT_REDACTED = "[redacted]";

/** Beyond this nesting depth a payload is replaced rather than walked further. */
export const AUDIT_MAX_DEPTH = 8;

/**
 * Key names (whole segments, not substrings) whose value must never be persisted.
 *
 * SAD §13.7's deny-list plus the auth vocabulary T050's acceptance names
 * ("Confirm redaction of phone and token fields"). Matching is on **segments**
 * rather than substrings, which is what keeps `secretaryName` untouched while
 * `secretReference` is redacted — `secret` is a segment of the second and not of
 * the first.
 */
export const AUDIT_SENSITIVE_KEY_SEGMENTS: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "authorization",
  "cookie",
  "otp",
  "phone",
  "mobile",
  "email",
  "signature",
  "cvv",
  "jwt",
  "credential",
  "credentials",
  "session",
  // Compound keys whose words carry no signal apart, spelled joined as well as
  // segmented: `apiKey` → `["api", "key"]` and `api_key` → the same, so neither
  // segment alone would catch them, while the joined form catches both.
  "apikey",
  "cardnumber",
];

const SENSITIVE_SEGMENTS = new Set(AUDIT_SENSITIVE_KEY_SEGMENTS);

/**
 * Splits a key into lowercase word segments across camelCase, snake_case and
 * kebab-case, so `phoneNumber`, `phone_number` and `phone-number` all answer the
 * same. Exported because it is the rule the redaction tests name.
 */
export function auditKeySegments(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment.length > 0);
}

/**
 * True when the key is on the deny-list — as a whole segment, or as a joined
 * compound. Matching on segments is what keeps `secretaryName` untouched while
 * `secretReference` is redacted; matching the joined form too is what catches
 * `apiKey`/`api_key`, whose two words say nothing on their own.
 */
export function isSensitiveAuditKey(key: string): boolean {
  const segments = auditKeySegments(key);
  return (
    SENSITIVE_SEGMENTS.has(segments.join("")) ||
    segments.some((segment) => SENSITIVE_SEGMENTS.has(segment))
  );
}

/**
 * Recursively redacts a value for storage: every object key whose segments hit the
 * deny-list is replaced wholesale, and every **value** of such a key is replaced
 * with `AUDIT_REDACTED` rather than descended into. That second part is the point
 * — a token nested under `auth.token.value` is still a token, and a walk that only
 * checked top-level keys would persist it.
 *
 * Non-JSON shapes are normalised rather than refused: `undefined` and functions
 * become `null` (a JSON `null` is honest about "not captured"), a `Date` becomes
 * its ISO string, and a value nested deeper than `AUDIT_MAX_DEPTH` is replaced
 * with the redaction marker so a cyclic or pathological payload cannot be walked
 * forever.
 */
export function redactAuditPayload(value: unknown, depth = 0): AuditJson {
  if (value === null || value === undefined) {
    return null;
  }

  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") {
    return value as string | number | boolean;
  }
  if (kind === "bigint") {
    return (value as bigint).toString();
  }
  if (kind === "function" || kind === "symbol") {
    return null;
  }

  if (depth >= AUDIT_MAX_DEPTH) {
    return AUDIT_REDACTED;
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactAuditPayload(item, depth + 1));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  const redacted: Record<string, AuditJson> = {};
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    redacted[key] = isSensitiveAuditKey(key)
      ? AUDIT_REDACTED
      : redactAuditPayload(nested, depth + 1);
  }
  return redacted;
}

/**
 * The persisted audit record, before it reaches the writer.
 *
 * `before`/`after`/`metadata` are typed as `AuditJson` — i.e. already redacted —
 * so a call site cannot hand the writer an unredacted object without going through
 * `redactAuditPayload` first.
 */
export interface AuditEntry {
  /**
   * Idempotency key for this operation. **Not** optional at the boundary: the
   * `audit_logs.operation_id` unique constraint makes a replay fail closed rather
   * than silently dedupe (ADR-0014 D4).
   */
  readonly operationId: string;
  readonly societyId: string;
  readonly actorUserId: string | null;
  readonly actorRole: MemberRole | null;
  readonly category: AuditCategory;
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly before: AuditJson;
  readonly after: AuditJson;
  readonly metadata: { readonly [key: string]: AuditJson };
}

/**
 * Re-applies redaction to a fully-formed entry.
 *
 * `buildAuditEntry` already redacts, and the returned type says so — but a type is
 * not a runtime control, and an entry can also be assembled by hand. So the
 * transaction boundary calls this before persisting, which makes "a secret reaches
 * `audit_logs`" impossible rather than merely discouraged. Redaction is idempotent,
 * so running it twice costs a walk and changes nothing.
 */
export function redactAuditEntry(entry: AuditEntry): AuditEntry {
  return {
    ...entry,
    before: redactAuditPayload(entry.before),
    after: redactAuditPayload(entry.after),
    metadata: redactAuditPayload(entry.metadata) as {
      readonly [key: string]: AuditJson;
    },
  };
}

/**
 * What a call site supplies. Everything the caller *cannot* be trusted to invent
 * — the actor, the request id, the IP and the user agent — is absent here on
 * purpose: the API layer fills those from the server-side request context, never
 * from a request body (ADR-0014 D5).
 */
export interface AuditDescriptor {
  readonly societyId: string;
  readonly category: AuditCategory;
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId?: string | null | undefined;
  readonly before?: unknown;
  readonly after?: unknown;
  /** Overrides the generated id, for a caller replaying a known operation. */
  readonly operationId?: string | undefined;
  /** Non-authoritative, caller-supplied facts; merged into `metadata` and redacted. */
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}
