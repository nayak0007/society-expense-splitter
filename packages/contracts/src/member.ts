import {
  DEFAULT_MEMBER_PAGE_LIMIT,
  MAX_MEMBER_PAGE_LIMIT,
  MEMBER_EMAIL_MAX_LENGTH,
  MEMBER_NAME_MAX_LENGTH,
  MEMBER_OCCUPANCIES,
  MEMBER_ROLES,
  MEMBER_SEARCH_MAX_LENGTH,
  MEMBER_SORTS,
  MEMBER_STATUSES,
  REJECTION_REASON_MAX_LENGTH,
  REJECTION_REASON_MIN_LENGTH,
} from "@ses/domain";
import { z } from "zod";

/**
 * Member wire contract (SAD §7: DTOs are Zod schemas in `packages/contracts`,
 * validated identically by the client and the API — a rule can never drift between the
 * two, PRD §18.1).
 *
 * The enums and bounds are **imported from `@ses/domain`** rather than repeated, for the
 * reason `structure.ts` records in full: a `z.enum([...])` here and a `MEMBER_STATUSES`
 * there is two definitions of one rule, and the way it fails is asymmetric — the client
 * accepts a value the server refuses, and the user sees an error for a field the form
 * said was fine.
 *
 * Request bodies are strict and response schemas are not (SAD §7.8 stage 1): an unknown
 * inbound field is a caller mistake worth reporting, while an added outbound field must
 * not break a client that has not been rebuilt.
 *
 * ## What is deliberately *not* here
 *
 * `role`. The contract has no way to set one — `createMemberSchema` omits it entirely and
 * `updateMemberSchema` has no field for it — because role assignment is T046's operation,
 * runs through a guarded path and needs an audit entry. A field the API refuses is better
 * than a field it accepts and ignores.
 */

/** `YYYY-MM-DD`, the shape an HTML date input and a Postgres `date` both use. */
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date");

/**
 * The flat a member occupies, as the directory renders it (PRD §3.3: "flat number, role
 * badge, occupancy").
 *
 * The label travels with the member rather than the client joining two lists, because the
 * directory is paginated: a client holding page 2 of the members and page 1 of the flats
 * cannot label a row that belongs to a flat it never fetched.
 */
export const memberApartmentSchema = z.object({
  id: z.string(),
  number: z.string(),
  buildingId: z.string(),
  buildingName: z.string().nullable(),
  floor: z.number().int().nullable(),
});
export type MemberApartmentDto = z.infer<typeof memberApartmentSchema>;

/**
 * One member as a particular caller may see them.
 *
 * `contactVisible` is not decoration: `phone: null` alone is ambiguous between "nobody
 * recorded a number" and "this member has not consented, or you are not one of the people
 * who may see it" (PRD §3.3). A client that renders the two the same way tells the user
 * something false about their society's data.
 */
export const memberSchema = z.object({
  id: z.string(),
  societyId: z.string(),
  /** `null` = a shadow member: recorded by an Admin, no account until they sign up. */
  userId: z.string().nullable(),
  apartmentId: z.string().nullable(),
  apartment: memberApartmentSchema.nullable(),
  displayName: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  role: z.enum(MEMBER_ROLES),
  status: z.enum(MEMBER_STATUSES),
  occupancy: z.enum(MEMBER_OCCUPANCIES),
  isPrimary: z.boolean(),
  leaseStart: z.string().nullable(),
  leaseEnd: z.string().nullable(),
  shareContact: z.boolean(),
  joinedAt: z.string().nullable(),
  approvedBy: z.string().nullable(),
  removedAt: z.string().nullable(),
  removedBy: z.string().nullable(),
  /** The requester's note on their join request (T049), and its decision's history. */
  requestNote: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  rejectedAt: z.string().nullable(),
  rejectedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  contactVisible: z.boolean(),
});
export type MemberDto = z.infer<typeof memberSchema>;

export const memberListSchema = z.array(memberSchema);
export type MemberListDto = z.infer<typeof memberListSchema>;

/**
 * What every member response carries about the caller.
 *
 * Six capability flags rather than a role, so a screen decides what to render from one
 * evaluation the domain computed against the same matrix the API's `PermissionGuard` and
 * the RLS policies use (SAD §9.3): a hidden button and a refused request cannot disagree.
 */
export const memberCapabilitiesSchema = z.object({
  canView: z.boolean(),
  canAdd: z.boolean(),
  canEdit: z.boolean(),
  canSuspend: z.boolean(),
  canRemove: z.boolean(),
  /** T046: assign, change or revoke a role — Admin only (`member.role_change`). */
  canChangeRoles: z.boolean(),
  /** T049: decide the join queue — approve or reject (`member.approve`, Admin and Treasurer). */
  canApprove: z.boolean(),
});
export type MemberCapabilitiesDto = z.infer<typeof memberCapabilitiesSchema>;

/**
 * The direct-add body (PRD §3.3: "name + phone, creates a *shadow member*").
 *
 * The phone is required and only *loosely* bounded, which is the interesting decision: the
 * user types `98765 43210` or `+91-98765-43210` and the domain normalises it to E.164
 * (`createPhone`). Constraining the raw shape here would refuse the spaces and dashes that
 * people actually type, so the bound is only "long enough to hold any formatted number",
 * and the rule that matters is enforced where the normalisation happens.
 */
const createMemberShape = {
  displayName: z
    .string()
    .trim()
    .min(1, "Enter a name")
    .max(
      MEMBER_NAME_MAX_LENGTH,
      `Name must be ${MEMBER_NAME_MAX_LENGTH} characters or fewer`,
    ),
  phone: z.string().trim().min(1, "Enter a phone number").max(24),
  email: z.string().trim().max(MEMBER_EMAIL_MAX_LENGTH).optional(),
  occupancy: z.enum(MEMBER_OCCUPANCIES).optional(),
  apartmentId: z.uuid().optional(),
  isPrimary: z.boolean().optional(),
  leaseStart: dateString.optional(),
  leaseEnd: dateString.optional(),
  shareContact: z.boolean().optional(),
} as const;

/** A lease that ends before it starts is a typo with a billing consequence. */
function leaseOrderingIsSane(values: {
  readonly leaseStart?: string | null | undefined;
  readonly leaseEnd?: string | null | undefined;
}): boolean {
  const { leaseStart, leaseEnd } = values;
  if (leaseStart === undefined || leaseStart === null || leaseStart === "")
    return true;
  if (leaseEnd === undefined || leaseEnd === null || leaseEnd === "")
    return true;
  return leaseEnd >= leaseStart;
}

/**
 * The primary claim needs a flat — the same pairing rule the domain's
 * `createPrimaryClaim` enforces and the database's `chk_members_primary_requires_apartment`
 * backstops.
 *
 * Two fields, one rule, and it is stated here as well as in the domain because the two
 * failures are different experiences: this one arrives before a request is sent, under the
 * input the user is looking at, while the domain's is the one that holds when a client
 * bypasses the form.
 */
function primaryClaimHasAFlat(values: {
  readonly isPrimary?: boolean | undefined;
  readonly apartmentId?: string | null | undefined;
}): boolean {
  if (values.isPrimary !== true) return true;
  return values.apartmentId !== undefined && values.apartmentId !== null;
}

export const createMemberSchema = z
  .strictObject(createMemberShape)
  .refine(leaseOrderingIsSane, {
    message: "Lease end cannot be before the lease start",
    path: ["leaseEnd"],
  })
  .refine(primaryClaimHasAFlat, {
    message: "Choose the flat this member is the primary occupant of",
    path: ["apartmentId"],
  });
export type CreateMemberPayload = z.infer<typeof createMemberSchema>;

/**
 * Update: every field optional, at least one present.
 *
 * **`null` means clear**, and only here — the three fields a society may need to retract
 * (`phone`, `email`, `apartmentId`, plus the two lease dates) accept `null` on this schema
 * and not on the create one. That asymmetry is the same one `updateApartmentSchema` has,
 * and it exists because the two operations ask different questions: creating cannot
 * un-record what was never recorded, while an edit has to be able to say "we had this
 * wrong, take it off". A shadow member's phone is their only identifier
 * (`uq_members_shadow_phone`), so "clear it" is not a nicety there.
 */
const updateMemberShape = {
  displayName: z
    .string()
    .trim()
    .min(1, "Enter a name")
    .max(MEMBER_NAME_MAX_LENGTH)
    .optional(),
  phone: z.string().trim().max(24).nullable().optional(),
  email: z.string().trim().max(MEMBER_EMAIL_MAX_LENGTH).nullable().optional(),
  occupancy: z.enum(MEMBER_OCCUPANCIES).optional(),
  apartmentId: z.uuid().nullable().optional(),
  isPrimary: z.boolean().optional(),
  leaseStart: dateString.nullable().optional(),
  leaseEnd: dateString.nullable().optional(),
  shareContact: z.boolean().optional(),
} as const;

export const updateMemberSchema = z
  .strictObject(updateMemberShape)
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Nothing to update",
  })
  .refine(leaseOrderingIsSane, {
    message: "Lease end cannot be before the lease start",
    path: ["leaseEnd"],
  });
export type UpdateMemberPayload = z.infer<typeof updateMemberSchema>;

/**
 * The directory query — filters, search, order and page (PRD §3.3's "searchable list with
 * flat number, role badge, occupancy" and the Roadmap's "listing filters by role, status,
 * building and occupancy").
 *
 * Every value arrives as a string off the query string, so the numbers are coerced and the
 * enums are matched rather than cast: a `status=actve` typo is a `400` naming the field,
 * not a filter silently ignored.
 */
export const memberListQuerySchema = z.object({
  role: z.enum(MEMBER_ROLES).optional(),
  status: z.enum(MEMBER_STATUSES).optional(),
  occupancy: z.enum(MEMBER_OCCUPANCIES).optional(),
  buildingId: z.uuid().optional(),
  apartmentId: z.uuid().optional(),
  q: z.string().trim().max(MEMBER_SEARCH_MAX_LENGTH).optional(),
  sort: z.enum(MEMBER_SORTS).optional(),
  /**
   * Clamped, not validated at the top: asking for more than the ceiling is a client asking
   * for too much (safe to trim, exactly as `common/pagination.ts` argues), while below 1 is
   * a client that is confused. `offset` is used rather than the SAD's cursor because this
   * list is ordered by name and read by scrolling; the cursor argument (§7.4) is about
   * growth and drift on an append-only financial table, and the directory's total is
   * computed in the same statement as the page.
   */
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_MEMBER_PAGE_LIMIT)
    .transform((value) => Math.min(value, MAX_MEMBER_PAGE_LIMIT)),
  offset: z.coerce.number().int().min(0).default(0),
});
export type MemberListQuery = z.infer<typeof memberListQuerySchema>;

/** `POST /members` and `PATCH /members/:memberId` — the member alone. */
export const memberResponseSchema = z.object({
  member: memberSchema,
});
export type MemberResponseDto = z.infer<typeof memberResponseSchema>;

/** `GET /members/:memberId` — one member and the caller's capabilities. */
export const memberDetailResponseSchema = z.object({
  member: memberSchema,
  capabilities: memberCapabilitiesSchema,
});
export type MemberDetailResponseDto = z.infer<
  typeof memberDetailResponseSchema
>;

/**
 * `GET /members` — one page, the total the filters produced, and the request's own paging.
 *
 * `total` travels as its own field rather than only in the page metadata because the
 * directory's only use for it is "showing 50 of 340", and echoing `limit`/`offset` back is
 * what lets the client render the right page after a filter change without keeping a
 * parallel copy of what it asked for.
 */
export const memberListResponseSchema = z.object({
  members: memberListSchema,
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  capabilities: memberCapabilitiesSchema,
});
export type MemberListResponseDto = z.infer<typeof memberListResponseSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Join requests (T049)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A join request *is* a pending membership row, so the wire shape reuses `memberSchema`
 * rather than inventing a near-copy of it (see `@ses/domain`'s `join-requests.ts` for the
 * decision). What the request adds is `claims`.
 *
 * `claims` is the PRD §3.2 rule made visible — "If someone claims an already-claimed flat,
 * route it to the Admin with both claims visible — do not auto-reject". Every live
 * membership naming the same flat, this request included; empty when the requester picked
 * no flat. A queue that showed only the requester would leave the Admin to discover the
 * collision by opening the flat's page, and the two rows would look like two unrelated
 * requests.
 */
export const joinRequestSchema = z.object({
  member: memberSchema,
  claims: z.array(memberSchema),
});
export type JoinRequestDto = z.infer<typeof joinRequestSchema>;

/**
 * The queue's query.
 *
 * Paging only — the queue is "this society's pending rows", and every filter somebody might
 * want (a building, an occupancy) is a narrowing the client can do on a page it already
 * holds. `limit` is clamped rather than validated at the top, exactly as the directory's is.
 */
export const joinRequestListQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_MEMBER_PAGE_LIMIT)
    .transform((value) => Math.min(value, MAX_MEMBER_PAGE_LIMIT)),
  offset: z.coerce.number().int().min(0).default(0),
});
export type JoinRequestListQuery = z.infer<typeof joinRequestListQuerySchema>;

/** `GET /members/join-requests` — one page, the total, and what the caller may do. */
export const joinRequestListResponseSchema = z.object({
  requests: z.array(joinRequestSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  capabilities: memberCapabilitiesSchema,
});
export type JoinRequestListResponseDto = z.infer<
  typeof joinRequestListResponseSchema
>;

/** `POST /members/join-requests/:memberId/approve` — the response is the admitted member. */
export const joinRequestResponseSchema = z.object({
  member: memberSchema,
  capabilities: memberCapabilitiesSchema,
});
export type JoinRequestResponseDto = z.infer<typeof joinRequestResponseSchema>;

/**
 * What an approval may settle.
 *
 * Every field is optional, and **absent means "as requested"** — the requester already
 * declared an occupancy and (T049) a flat, so an approver who agrees with all of it sends
 * `{}`. The three things they may correct are the things the requester could not know: the
 * flat (nullable, because clearing a wrong one is a real correction), the occupancy the
 * society records for billing, and the role — which only an Admin may set above Resident
 * (`member.role_change`), the same asymmetry the invitation path enforces.
 *
 * There is deliberately no `status` field: the operation *is* the status, and a body that
 * could name one would let a caller spell "approve" as "set active" and skip the queue's
 * rules.
 */
export const approveJoinRequestSchema = z.strictObject({
  role: z.enum(MEMBER_ROLES).optional(),
  occupancy: z.enum(MEMBER_OCCUPANCIES).optional(),
  apartmentId: z.uuid().nullable().optional(),
  isPrimary: z.boolean().optional(),
});
export type ApproveJoinRequestPayload = z.infer<
  typeof approveJoinRequestSchema
>;

/**
 * A rejection, and its reason.
 *
 * Required, and bounded at both ends: the requester is a person waiting for an answer, so
 * "no" is not a reason and a paragraph is not one either. The same bounds the domain's
 * `createRejectionReason` and the database's `chk_members_rejection_reason` enforce, read
 * from one place so a form, the API and the row cannot disagree.
 */
export const rejectJoinRequestSchema = z.strictObject({
  reason: z
    .string()
    .trim()
    .min(REJECTION_REASON_MIN_LENGTH, "Give a reason the requester can act on")
    .max(REJECTION_REASON_MAX_LENGTH),
});
export type RejectJoinRequestPayload = z.infer<typeof rejectJoinRequestSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Bulk CSV import (T048)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The wire shapes for the bulk import. The *grammar* — headers, field rules, the row
 * cap, the formula guard — lives in `@ses/domain`'s `csv-import.ts` and is shared by
 * both consumers; what a contract needs here is only what crosses the wire:
 *
 *  - the request carries the whole file as UTF-8 text (`csv`) — the API is Fastify with
 *    no multipart surface, and the server must parse text either way, so a file wrapper
 *    would add a dependency without adding a decision;
 *  - a row outcome is a discriminated union (`valid | invalid | conflict`) so a client
 *    renders three visibly different things instead of re-deriving them from nulls;
 *  - the summary's arithmetic (`total = imported + invalid + conflicts`) is the
 *    Roadmap's "nothing silently dropped", stated as a schema.
 */

export const csvImportRequestSchema = z.strictObject({
  /** The whole CSV file as UTF-8 text, header row required (see `@ses/domain`). */
  csv: z.string().min(1, "Attach a CSV file").max(
    // ~1 MB: the row cap (1,000) at a generous 4 KB/row is 4,000,000, but 1 MB covers
    // any realistic member sheet with room for quoted cells; the row cap is the real
    // limit and this is the transport guard.
    1_000_000,
    "That file is too large — split it into batches of up to 1,000 rows",
  ),
});
export type CsvImportRequest = z.infer<typeof csvImportRequestSchema>;

export const csvRowErrorCodeSchema = z.enum([
  "EMPTY_FILE",
  "MISSING_HEADER",
  "UNKNOWN_COLUMN",
  "DUPLICATE_COLUMN",
  "TOO_MANY_ROWS",
  "RAGGED_ROW",
  "UNTERMINATED_QUOTE",
  "MISSING_NAME",
  "INVALID_NAME",
  "MISSING_PHONE",
  "INVALID_PHONE",
  "INVALID_EMAIL",
  "INVALID_OCCUPANCY",
  "FORMULA_LIKE_NAME",
  "FORMULA_LIKE_EMAIL",
  "APARTMENT_NOT_FOUND",
  "APARTMENT_CLAIM_CONFLICT",
  "DUPLICATE_IN_FILE",
  "ALREADY_MEMBER",
  "INVITATION_PENDING",
  "IMPORT_ROW_FAILED",
]);
export type CsvRowErrorCodeDto = z.infer<typeof csvRowErrorCodeSchema>;

/** One row's problem, addressed by its 1-based file line. */
export const csvRowErrorSchema = z.object({
  line: z.number().int().positive(),
  field: z.enum(["flat_no", "name", "phone", "email", "occupancy_type", "row"]),
  code: csvRowErrorCodeSchema,
  message: z.string(),
});
export type CsvRowErrorDto = z.infer<typeof csvRowErrorSchema>;

/** A valid row, as it will be (or was) written. */
export const csvRowValidSchema = z.object({
  status: z.literal("valid"),
  line: z.number().int().positive(),
  displayName: z.string(),
  phone: z.string(),
  email: z.string().nullable(),
  apartmentNumber: z.string().nullable(),
  apartmentId: z.string().nullable(),
  occupancy: z.enum(MEMBER_OCCUPANCIES),
});

/** An invalid or conflicted row, with the reason. */
export const csvRowProblemSchema = z.object({
  status: z.enum(["invalid", "conflict"]),
  line: z.number().int().positive(),
  error: csvRowErrorSchema,
});

export const csvRowOutcomeSchema = z.discriminatedUnion("status", [
  csvRowValidSchema,
  csvRowProblemSchema,
]);
export type CsvRowOutcomeDto = z.infer<typeof csvRowOutcomeSchema>;

/** The six counters, in the order the preview screen reads them. */
export const csvImportSummarySchema = z.object({
  totalRows: z.number().int().nonnegative(),
  validRows: z.number().int().nonnegative(),
  invalidRows: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
});
export type CsvImportSummaryDto = z.infer<typeof csvImportSummarySchema>;

/** `POST /members/import/preview` — no write has happened. */
export const csvImportPreviewResponseSchema = z.object({
  rows: z.array(csvRowOutcomeSchema),
  summary: csvImportSummarySchema,
  capabilities: memberCapabilitiesSchema,
});
export type CsvImportPreviewResponseDto = z.infer<
  typeof csvImportPreviewResponseSchema
>;

/** `POST /members/import` — what happened, per row. */
export const csvImportResultResponseSchema = z.object({
  summary: csvImportSummarySchema,
  imported: z.array(memberSchema),
  failed: z.array(
    z.object({ line: z.number().int().positive(), error: csvRowErrorSchema }),
  ),
  capabilities: memberCapabilitiesSchema,
});
export type CsvImportResultResponseDto = z.infer<
  typeof csvImportResultResponseSchema
>;
