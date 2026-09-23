import {
  DEFAULT_SOCIETY_SETTINGS,
  SocietyError,
  asMemberId,
  asSocietyId,
  asUserId,
  isSocietyType,
} from "@ses/domain";
import type {
  CreateSocietyInput,
  MemberRole,
  MembershipStatus,
  OccupancyType,
  Society,
  SocietyJoinPreview,
  SocietyMembership,
  SocietySettings,
  SubscriptionPlan,
  UpdateSocietyInput,
} from "@ses/domain";
import { z } from "zod";

/**
 * The database ⇄ domain boundary for the society module.
 *
 * Every enum mismatch, nullability difference and SQLSTATE the API can receive
 * is decided here, once, rather than across ten repository methods. Rows are
 * **validated, not trusted**: the RPCs return `jsonb`, which is untyped at the
 * driver, so a column rename or a new null must fail loudly here rather than
 * reach a use case as `undefined`.
 *
 * ## Why this reads like `apps/mobile/.../society.rows.ts`
 *
 * The mobile Supabase adapter solves the same problem from the other side of the
 * wire, and the two files share their navigation tables by necessity — the
 * database's vocabulary is not the domain's (`committee`/`committee_member`,
 * `owner_occupied`/`owner`, `premium`/`pro`). The API's copy is the one that will
 * survive: T028 moves the mobile client onto this API, at which point the
 * Supabase adapter is deleted rather than kept in step. Until then the risk is
 * real and deliberate — extracting a package to serve an adapter with a planned
 * end-of-life would add indirection to the code that outlives it.
 *
 * ## What differs from the mobile copy, and why
 *
 * - **`detail`, not `details`.** `postgres.js` surfaces Postgres's `DETAIL` field
 *   as `error.detail`; PostgREST renames it. Matching the wrong one silently
 *   loses every unique-violation discriminator (which column collided).
 * - **No `PGRST116`.** That code is PostgREST's "no rows" for a `.single()` read.
 *   Over a driver connection there is no such error: "no rows" is an empty result
 *   set, so the absence cases below are decided by row counts instead.
 * - **The write paths are one transaction each.** The mobile adapter needed two
 *   round trips for `join`; here the whole operation is inside the caller's
 *   already-open transaction.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One canonical timestamp shape.
 *
 * Three serialisations reach this function and all must become the same string:
 * `postgres.js` returns a `timestamptz` column as a JavaScript `Date`, `jsonb`
 * (every `society_snapshot()` field) carries the same instant as an ISO string,
 * and Postgres's own text form is `2026-09-20 10:00:00+00`. The domain compares
 * against `Date.parse` and renders through `Intl`, so normalising here is what
 * keeps `Society.createdAt` identical in shape to what the mobile mock and
 * `new Date().toISOString()` produce.
 *
 * This is the one place the driver's behaviour differs from PostgREST in a way
 * that would otherwise reach a screen: PostgREST always sends strings, so a copy
 * of this file written for the driver alone would silently produce `Date`
 * objects wherever a row is read directly rather than through a function.
 */
function toIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

/** An instant on a `NOT NULL` column: always an ISO string out. */
const timestampSchema = z
  .union([z.string(), z.date()])
  .transform((value) => toIso(value) ?? "");

/** An instant on a nullable column: `null` in means `null` out. */
const nullableTimestampSchema = z
  .union([z.string(), z.date(), z.null()])
  .transform((value) => toIso(value));

/** Bigint columns arrive as JSON numbers; coerced so a string never slips through. */
const paiseSchema = z.coerce.number().int().min(0);
const countSchema = z.coerce.number().int().min(0);

// ─────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `societies` row as `to_jsonb(societies)` renders it.
 *
 * Non-strict on purpose: the RPC returns every column, including ones the domain
 * does not model yet (`logo_key`, `plan_expires_at`), and a strict schema would
 * reject the whole payload over a field nobody reads.
 */
export const societyRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  society_type: z.string(),
  registration_no: z.string().nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  city: z.string(),
  state: z.string(),
  pincode: z.string().nullable(),
  country: z.string(),
  currency: z.string(),
  timezone: z.string(),
  join_code: z.string(),
  join_code_expires_at: nullableTimestampSchema,
  plan: z.string(),
  created_by: z.string(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  deleted_at: nullableTimestampSchema,
});
export type SocietyRow = z.infer<typeof societyRowSchema>;

const settingsRowSchema = z.object({
  billing_day: z.coerce.number().int(),
  due_day: z.coerce.number().int(),
  grace_days: z.coerce.number().int(),
  approval_threshold_paise: paiseSchema,
  bill_vacant_flats: z.boolean(),
  allow_partial_payments: z.boolean(),
  defaulter_list_public: z.boolean(),
  financial_year_start_month: z.coerce.number().int(),
});
export type SocietySettingsRow = z.infer<typeof settingsRowSchema>;

export const memberRowSchema = z.object({
  id: z.string(),
  society_id: z.string(),
  /** `null` = shadow member (an occupant recorded before they had an account). */
  user_id: z.string().nullable(),
  role: z.string(),
  status: z.string(),
  occupancy: z.string(),
  joined_at: nullableTimestampSchema,
});
export type MemberRow = z.infer<typeof memberRowSchema>;

export const memberRowListSchema = z.array(memberRowSchema);

/** What `public.society_snapshot()` returns. */
export const societySnapshotSchema = z.object({
  society: societyRowSchema,
  settings: settingsRowSchema.nullable(),
  membership: memberRowSchema.nullable(),
  memberCount: countSchema,
});
export type SocietySnapshot = z.infer<typeof societySnapshotSchema>;

/** What `public.society_join_preview()` returns — camelCase, it is not a row. */
export const joinPreviewSchema = z.object({
  id: z.string(),
  name: z.string(),
  city: z.string(),
  state: z.string(),
  type: z.string(),
  memberCount: countSchema,
  joinCodeExpiresAt: nullableTimestampSchema.optional(),
});
export type JoinPreviewPayload = z.infer<typeof joinPreviewSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Enum translation
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_FROM_ROW: Readonly<Record<string, MemberRole>> = {
  admin: "admin",
  treasurer: "treasurer",
  // PRD §7 spells the role `committee`; the domain spells it `committee_member`.
  committee: "committee_member",
  committee_member: "committee_member",
  resident: "resident",
  tenant: "tenant",
  guest: "guest",
};

const OCCUPANCY_FROM_ROW: Readonly<Record<string, OccupancyType>> = {
  owner_occupied: "owner",
  // A vacant owner is still an owner; the domain has no separate state for it.
  vacant_owner: "owner",
  tenant: "tenant",
  family_member: "family_member",
  owner: "owner",
};

const PLAN_FROM_ROW: Readonly<Record<string, SubscriptionPlan>> = {
  free: "free",
  // The PRD distinguishes `premium` from `society_pro`; the domain has one paid
  // residential tier. Lossy by design, and safe: `plan` is never written from
  // this side (billing is server-side), so no round trip can corrupt it.
  premium: "pro",
  society_pro: "pro",
  pro: "pro",
  enterprise: "enterprise",
};

/**
 * The domain models three membership states; the database has five. The two
 * extras collapse onto `removed`, which is the honest answer for both: an
 * `inactive` member and a `rejected` applicant can each do nothing, and the
 * domain's capability rules only ever ask "can this membership act?".
 */
const STATUS_FROM_ROW: Readonly<Record<string, MembershipStatus>> = {
  pending: "pending",
  active: "active",
  removed: "removed",
  inactive: "removed",
  rejected: "removed",
};

/**
 * Unknown values degrade to the *least* privileged option rather than throwing.
 * A role the API does not recognise must never become `admin`, and a status it
 * cannot place must never become `active` — a forward-compatible database (a new
 * role added by T046) would otherwise silently grant access.
 */
function roleFromRow(value: string): MemberRole {
  return ROLE_FROM_ROW[value] ?? "guest";
}

function occupancyFromRow(value: string): OccupancyType {
  return OCCUPANCY_FROM_ROW[value] ?? "family_member";
}

function planFromRow(value: string): SubscriptionPlan {
  return PLAN_FROM_ROW[value] ?? "free";
}

function statusFromRow(value: string): MembershipStatus {
  return STATUS_FROM_ROW[value] ?? "removed";
}

/** Domain → row, for the one write path that sends an occupancy (a join). */
export function occupancyToRow(occupancy: OccupancyType): string {
  return occupancy === "owner" ? "owner_occupied" : occupancy;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mappers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Settings are split across two tables in SQL (`societies.timezone` and
 * `societies.currency` live on the society) because that is where the PRD puts
 * them; the domain keeps one `SocietySettings`, so the mapper merges them.
 *
 * A missing settings row falls back to the documented defaults rather than
 * failing: `seed_society()` guarantees it exists, so reaching the fallback means
 * something is already wrong server-side, and a society that cannot be rendered
 * at all is a worse outcome than one showing default billing days.
 */
export function settingsFromRow(
  society: SocietyRow,
  settings: SocietySettingsRow | null,
): SocietySettings {
  if (settings === null) {
    return { ...DEFAULT_SOCIETY_SETTINGS, timezone: society.timezone };
  }
  return {
    billingDay: settings.billing_day,
    dueDay: settings.due_day,
    graceDays: settings.grace_days,
    approvalThresholdPaise: settings.approval_threshold_paise,
    billVacantFlats: settings.bill_vacant_flats,
    allowPartialPayments: settings.allow_partial_payments,
    defaulterListPublic: settings.defaulter_list_public,
    financialYearStartMonth: settings.financial_year_start_month,
    timezone: society.timezone,
    // Not a default: the only supported currency (PRD §3.2 step 1).
    currency: "INR",
  };
}

export function societyFromSnapshot(snapshot: SocietySnapshot): Society {
  const row = snapshot.society;
  return {
    id: asSocietyId(row.id),
    name: row.name,
    slug: row.slug,
    // The column is CHECK-constrained to the same five values; `other` keeps a
    // future value from crashing a route while the domain catches up.
    type: isSocietyType(row.society_type) ? row.society_type : "other",
    registrationNumber: row.registration_no,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    country: "IN",
    currency: "INR",
    timezone: row.timezone,
    joinCode: row.join_code,
    joinCodeExpiresAt: row.join_code_expires_at,
    plan: planFromRow(row.plan),
    createdBy: asUserId(row.created_by),
    // Already normalised by the row schema's transform — normalising twice here
    // would be harmless and quietly hide a schema that stopped doing it.
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    settings: settingsFromRow(row, snapshot.settings),
    memberCount: snapshot.memberCount,
  };
}

/**
 * One membership row → the domain's view of it.
 *
 * Shadow members (no `user_id` yet) are the caller's problem: the domain's
 * `SocietyMembership` requires a `UserId`, so they are filtered out by the
 * roster read rather than invented here. The members module (T045) is where they
 * get their own representation.
 */
export function membershipFromRow(row: MemberRow): SocietyMembership {
  if (row.user_id === null) {
    throw new SocietyError(
      "unknown",
      "A membership without a user account cannot be represented yet.",
    );
  }
  return {
    id: asMemberId(row.id),
    societyId: asSocietyId(row.society_id),
    userId: asUserId(row.user_id),
    role: roleFromRow(row.role),
    status: statusFromRow(row.status),
    occupancyType: occupancyFromRow(row.occupancy),
    joinedAt: row.joined_at,
  };
}

export function joinPreviewFromPayload(
  payload: JoinPreviewPayload,
): SocietyJoinPreview {
  return {
    id: asSocietyId(payload.id),
    name: payload.name,
    city: payload.city,
    state: payload.state,
    type: isSocietyType(payload.type) ? payload.type : "other",
    memberCount: payload.memberCount,
    joinCodeExpiresAt: payload.joinCodeExpiresAt ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Request payloads
// ─────────────────────────────────────────────────────────────────────────────

/** The `society_create()` argument: what the wizard collected, nothing derived. */
export function createPayload(
  input: CreateSocietyInput,
): Record<string, unknown> {
  return {
    name: input.name,
    type: input.type,
    registrationNumber: input.registrationNumber ?? null,
    addressLine1: input.addressLine1 ?? null,
    addressLine2: input.addressLine2 ?? null,
    city: input.city,
    state: input.state,
    pincode: input.pincode ?? null,
    billingDay: input.billingDay,
    dueDay: input.dueDay,
    approvalThresholdPaise: input.approvalThresholdPaise,
  };
}

/**
 * The `society_update()` argument.
 *
 * **Key presence is the signal, not the value.** The domain expresses "cleared
 * this optional field" as a key that is present and `undefined`
 * (`update-society.ts`), and `JSON.stringify` drops such keys — so a naive spread
 * would turn "clear the registration number" into "leave it alone". Translating
 * `undefined` to an explicit `null` preserves the distinction, and the RPC reads
 * `null` on a nullable column as a clear.
 */
export function updatePayload(
  input: UpdateSocietyInput,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    payload[key] = value ?? null;
  }
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `postgres.js` error, narrowed.
 *
 * Field names are the driver's: Postgres's `DETAIL` arrives as `detail` and
 * `HINT` as `hint`. Only `code` and `message` are guaranteed; the rest are
 * present when the server sent them.
 */
interface PostgresErrorLike {
  readonly code?: string;
  readonly message?: string;
  readonly detail?: string;
  readonly hint?: string;
  readonly constraint_name?: string;
}

/** SQLSTATE codes raised by the migrations' own functions (see the RPC header). */
export const SQLSTATE = {
  raised: "P0001",
  societyNotFound: "P0002",
  societyForbidden: "P0003",
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  insufficientPrivilege: "42501",
  undefinedTable: "42P01",
} as const;

/**
 * The named exceptions the migrations raise. They travel as `P0001` with the
 * name in the message, so they are matched by name rather than by code — which
 * is why every one of them is listed here instead of inline: adding a
 * `RAISE EXCEPTION` to the SQL without adding it here would silently become
 * `unknown`, and this list is what makes that omission visible in review.
 */
export const RAISED_EXCEPTION = {
  societyNotFound: "SOCIETY_NOT_FOUND",
  societyForbidden: "SOCIETY_FORBIDDEN",
  societyAdminRequired: "SOCIETY_ADMIN_REQUIRED",
  memberStatusChangeForbidden: "MEMBER_STATUS_CHANGE_FORBIDDEN",
  memberRoleChangeForbidden: "MEMBER_ROLE_CHANGE_FORBIDDEN",
  emptyPatch: "EMPTY_PATCH",
  emptyPayload: "EMPTY_PAYLOAD",
  notAuthenticated: "NOT_AUTHENTICATED",
} as const;

/**
 * A payload that did not match its row schema. Always a bug on one side of the
 * boundary (a renamed column, a new nullable field), never something the user
 * did — so the copy stays generic and the actionable part is a hint for the
 * operator.
 */
export function unexpectedShapeError(what: string): SocietyError {
  return new SocietyError(
    "unknown",
    "Something went wrong. Please try again.",
    {
      hint: `Unexpected ${what} shape returned by the database.`,
    },
  );
}

function asErrorLike(error: unknown): PostgresErrorLike {
  return (error ?? {}) as PostgresErrorLike;
}

/**
 * True when the failure was a join-code collision — the one unique violation
 * worth retrying, because the database mints the code and re-running the insert
 * simply mints another (PRD T040: "Join-code collision retries and succeeds").
 */
export function isJoinCodeCollision(error: unknown): boolean {
  const candidate = asErrorLike(error);
  return (
    candidate.code === SQLSTATE.uniqueViolation &&
    /join_code/i.test(`${candidate.message ?? ""} ${candidate.detail ?? ""}`)
  );
}

/**
 * Postgres failure → the domain's error vocabulary.
 *
 * `context` matters for exactly one case and it is the important one: `42501`
 * covers both "you are not in this tenant" and "your role is not enough". On a
 * **read** that must be `not_found` (PRD T041: a non-member cannot tell a
 * foreign society from a non-existent one). On a **write** the RPC has already
 * run its membership check, so the caller is a member who lacks the role —
 * `forbidden`, and the user is told why. Guessing the other way round would
 * either leak existence or leave a Treasurer staring at "not found" for their
 * own society.
 *
 * Postgres's `detail` is deliberately NOT copied into the error: it can contain
 * column values (a join code, an email) and these objects travel toward the UI.
 */
export function societyErrorFromPostgres(
  error: unknown,
  context: "read" | "write",
): SocietyError {
  const candidate = asErrorLike(error);
  const code = candidate.code ?? "";
  const message = candidate.message ?? "";
  const hint = candidate.hint;
  const haystack = `${message} ${candidate.detail ?? ""}`;

  const withHint = (): Record<string, unknown> => ({
    code: candidate.code,
    ...(hint === undefined ? {} : { hint }),
  });

  switch (code) {
    case SQLSTATE.societyNotFound:
      return new SocietyError(
        "not_found",
        "That society is not available to you.",
        withHint(),
      );

    case SQLSTATE.societyForbidden:
      return new SocietyError(
        "forbidden",
        hint ?? "Only a society Admin can change society details.",
        withHint(),
      );

    case SQLSTATE.raised:
      return raisedError(message, hint, withHint());

    case SQLSTATE.insufficientPrivilege:
      if (/permission denied for table/i.test(message)) {
        // The role itself has no grant, which for this app means the request
        // arrived without a usable identity: nothing is granted to `anon`.
        return new SocietyError(
          "forbidden",
          "Your session expired. Please sign in again.",
          withHint(),
        );
      }
      return context === "read"
        ? new SocietyError(
            "not_found",
            "That society is not available to you.",
            withHint(),
          )
        : new SocietyError(
            "forbidden",
            "Only a society Admin can change society details.",
            withHint(),
          );

    case SQLSTATE.uniqueViolation:
      if (/user_id|society_id, user_id/i.test(haystack)) {
        return new SocietyError(
          "already_member",
          "You are already a member of this society.",
          withHint(),
        );
      }
      if (/join_code/i.test(haystack)) {
        return new SocietyError(
          "conflict",
          "Could not reserve a join code. Please try again.",
          withHint(),
        );
      }
      if (/slug/i.test(haystack)) {
        return new SocietyError(
          "conflict",
          "A society with a very similar name already exists.",
          withHint(),
        );
      }
      return new SocietyError(
        "conflict",
        "That change conflicts with an existing record.",
        withHint(),
      );

    case SQLSTATE.checkViolation:
      return new SocietyError(
        "validation",
        checkViolationMessage(haystack),
        withHint(),
      );

    case SQLSTATE.foreignKeyViolation:
      return new SocietyError(
        "not_found",
        "That society is not available to you.",
        withHint(),
      );

    case SQLSTATE.undefinedTable:
      return missingSchemaError(withHint());

    default:
      break;
  }

  if (/row-level security|permission denied/i.test(message)) {
    return context === "read"
      ? new SocietyError(
          "not_found",
          "That society is not available to you.",
          withHint(),
        )
      : new SocietyError(
          "forbidden",
          "Only a society Admin can change society details.",
          withHint(),
        );
  }

  return new SocietyError(
    "unknown",
    "Something went wrong. Please try again.",
    {
      code,
      ...(hint === undefined ? {} : { hint }),
    },
  );
}

function raisedError(
  message: string,
  hint: string | undefined,
  base: Record<string, unknown>,
): SocietyError {
  if (message.includes(RAISED_EXCEPTION.societyAdminRequired)) {
    return new SocietyError(
      "sole_admin",
      hint ?? "You are the only Admin. Promote another member to Admin first.",
      base,
    );
  }
  if (message.includes(RAISED_EXCEPTION.memberStatusChangeForbidden)) {
    return new SocietyError(
      "forbidden",
      hint ?? "Joining a society needs an Admin to approve it.",
      base,
    );
  }
  if (message.includes(RAISED_EXCEPTION.memberRoleChangeForbidden)) {
    return new SocietyError(
      "forbidden",
      hint ?? "Only a society Admin can change roles.",
      base,
    );
  }
  if (
    message.includes(RAISED_EXCEPTION.emptyPatch) ||
    message.includes(RAISED_EXCEPTION.emptyPayload)
  ) {
    return new SocietyError("validation", "Nothing to update.", base);
  }
  if (message.includes(RAISED_EXCEPTION.notAuthenticated)) {
    return new SocietyError(
      "forbidden",
      "Your session expired. Please sign in again.",
      base,
    );
  }
  if (message.includes(RAISED_EXCEPTION.societyNotFound)) {
    return new SocietyError(
      "not_found",
      "That society is not available to you.",
      base,
    );
  }
  if (message.includes(RAISED_EXCEPTION.societyForbidden)) {
    return new SocietyError(
      "forbidden",
      "Only a society Admin can change society details.",
      base,
    );
  }
  return new SocietyError(
    "unknown",
    "Something went wrong. Please try again.",
    base,
  );
}

function checkViolationMessage(haystack: string): string {
  if (/society_type/i.test(haystack)) return "Choose a society type.";
  if (/pincode/i.test(haystack)) return "Enter a 6-digit PIN code.";
  if (/join_code/i.test(haystack)) return "That join code is not valid.";
  if (/billing_day|due_day/i.test(haystack))
    return "Choose a day between 1 and 28.";
  if (/financial_year_start_month/i.test(haystack))
    return "Choose a month between 1 and 12.";
  return "Please check the details and try again.";
}

/**
 * A missing migration is a developer error, not a user one — so the message
 * stays generic (it can surface in a response through the error mapper) while
 * the actionable part travels in `details`, which the UI never renders.
 */
function missingSchemaError(base: Record<string, unknown>): SocietyError {
  return new SocietyError(
    "unknown",
    "This part of the app is not available yet. Please try again later.",
    {
      ...base,
      hint: "The society tables are missing. Apply supabase/migrations/20260920130*.sql.",
    },
  );
}
