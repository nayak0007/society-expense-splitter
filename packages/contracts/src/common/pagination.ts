import { z } from "zod";

import { envelopeMetaSchema } from "./envelope";

/**
 * Cursor pagination — SAD §7.4.
 *
 * "Offset pagination is banned on any endpoint over a growing table: offsets
 * produce duplicates and gaps when rows are inserted mid-scroll, and
 * `OFFSET 10000` is a sequential scan."
 *
 * Two properties of the shape do real work:
 *
 *  - **The cursor is opaque.** It is base64 of the sort tuple
 *    (`{ expenseDate, id }`), which is what makes it stable against insertion.
 *    Clients treat it as a token and echo it back; nothing here parses it, and
 *    the schema deliberately types it as an unconstrained string rather than a
 *    structured object so that changing the sort tuple stays a server-only
 *    change — a structured type would make the tuple part of the contract and
 *    turn a query-plan tweak into a breaking API change.
 *  - **`total` is optional.** SAD §7.4 returns it "only when cheap (from a
 *    cached count)", so clients must render correctly without it. Making it
 *    required here would force a `COUNT(*)` on every list endpoint, which is the
 *    exact scan the cursor exists to avoid.
 */

/** SAD §7.4: "default 20, max 100". */
export const DEFAULT_PAGE_LIMIT = 20;
/** SAD §7.4: max for ordinary list endpoints. */
export const MAX_PAGE_LIMIT = 100;
/** SAD §7.4: `/sync/changes` is allowed a larger page than a user-facing list. */
export const MAX_SYNC_PAGE_LIMIT = 500;

/**
 * `limit`, clamped rather than validated on its upper bound.
 *
 * SAD §7.4: "Exceeding the max clamps silently rather than erroring." That
 * asymmetry is deliberate and is reproduced exactly — over-max is a client
 * asking for too much (safe to trim), while below 1 is a client that is confused
 * (better to fail loudly than to guess what `limit=0` meant).
 */
const limitSchema = z.coerce.number().int().min(1).default(DEFAULT_PAGE_LIMIT);

export const paginationQuerySchema = z.object({
  limit: limitSchema.transform((value) => Math.min(value, MAX_PAGE_LIMIT)),
  cursor: z.string().min(1).optional(),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/**
 * The `/sync/changes` variant (SAD §7.4, §7.11). Kept separate rather than
 * parameterised so the larger ceiling is visible at the call site — a bare
 * `limit` schema would make it easy to use the sync ceiling on a public list.
 */
export const syncPaginationQuerySchema = z.object({
  limit: limitSchema.transform((value) => Math.min(value, MAX_SYNC_PAGE_LIMIT)),
  cursor: z.string().min(1).optional(),
});
export type SyncPaginationQuery = z.infer<typeof syncPaginationQuerySchema>;

/** Page metadata: the envelope meta plus the two fields a cursor page adds. */
export const pageMetaSchema = envelopeMetaSchema.extend({
  /** Absent on the last page. */
  nextCursor: z.string().optional(),
  hasMore: z.boolean(),
  /** Present only when a cached count made it free (SAD §7.4). */
  total: z.number().int().nonnegative().optional(),
});
export type PageMeta = z.infer<typeof pageMetaSchema>;

/**
 * `data` is an array here, unlike the single-object success envelope (§7.9).
 * A page is always a collection, so there is no scalar case to guard against.
 */
export function cursorPageSchema<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), meta: pageMetaSchema });
}

/** The inferred page type, for handlers that need to name it. */
export type CursorPage<T> = {
  data: T[];
  meta: PageMeta;
};
