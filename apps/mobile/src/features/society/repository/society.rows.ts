import {
  DEFAULT_SOCIETY_SETTINGS,
  SocietyError,
  asMemberId,
  asSocietyId,
  asUserId,
  isSocietyType,
} from '@ses/domain';
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
} from '@ses/domain';
import { z } from 'zod';

/**
 * The database ⇄ domain boundary for the society module: row schemas, mappers
 * and Postgres error classification.
 *
 * Kept apart from the repository itself because these are the parts worth
 * reading on their own — every enum mismatch, every nullability difference and
 * every error code the app can receive is decided here, once, instead of being
 * spread across nine query methods.
 *
 * TWO CONVENTIONS THIS FILE EXISTS TO ENFORCE
 *
 * 1. **Rows are validated, not trusted.** PostgREST data is untyped without
 *    generated database types, so every payload is parsed with Zod before it
 *    becomes a domain object. A column rename or a nullable surprise then fails
 *    loudly here rather than reaching a screen as `undefined`.
 *
 * 2. **The database's vocabulary is not the domain's.** The SQL schema follows
 *    the PRD §7 DDL, which spells several values differently from the domain's
 *    unions (`committee`/`committee_member`, `owner_occupied`/`owner`,
 *    `premium`/`pro`) and has states the domain does not model at all
 *    (`member_status.inactive`/`rejected`). The mappers below are the only place
 *    that translation happens, and each one documents its lossy direction. They
 *    can be deleted the day the two vocabularies converge — see the module's
 *    report note; until then they are load-bearing.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Timestamps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One canonical timestamp shape. Postgres renders `timestamptz` as
 * `2026-09-20 10:00:00+00` from a direct query and as an ISO string from
 * `jsonb`, and the domain compares against `Date.parse` and renders through
 * `Intl`. Normalising to ISO-8601 UTC here keeps `Society.createdAt` identical
 * in shape to what `new Date().toISOString()` produces in the mock repository,
 * so nothing downstream can tell the two apart.
 */
function toIso(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/** Bigint columns arrive as JSON numbers; coerced so a string never slips through. */
const paiseSchema = z.coerce.number().int().min(0);
const countSchema = z.coerce.number().int().min(0);

// ─────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `societies` row, exactly as `to_jsonb(societies)` renders it.
 *
 * Non-strict on purpose: the RPC returns every column, including ones the
 * domain does not model yet (`logo_key`, `plan_expires_at`), and a strict schema
 * would reject them. Unknown keys are stripped.
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
  join_code_expires_at: z.string().nullable(),
  plan: z.string(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z.string().nullable(),
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
  // NULL = shadow member (an occupant recorded before they had an account,
  // PRD §3.2).
  user_id: z.string().nullable(),
  role: z.string(),
  status: z.string(),
  occupancy: z.string(),
  joined_at: z.string().nullable(),
});
export type MemberRow = z.infer<typeof memberRowSchema>;

export const memberRowListSchema = z.array(memberRowSchema);

/**
 * What `public.society_snapshot()` returns: the row, its settings, the caller's
 * own membership and the real member count.
 */
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
  joinCodeExpiresAt: z.string().nullable().optional(),
});
export type JoinPreviewPayload = z.infer<typeof joinPreviewSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Enum translation
// ─────────────────────────────────────────────────────────────────────────────

const ROLE_FROM_ROW: Readonly<Record<string, MemberRole>> = {
  admin: 'admin',
  treasurer: 'treasurer',
  // PRD §7 spells the role `committee`; the domain spells it `committee_member`.
  committee: 'committee_member',
  committee_member: 'committee_member',
  resident: 'resident',
  tenant: 'tenant',
  guest: 'guest',
};

const OCCUPANCY_FROM_ROW: Readonly<Record<string, OccupancyType>> = {
  owner_occupied: 'owner',
  // A vacant owner is still an owner; the domain has no separate state for it.
  vacant_owner: 'owner',
  tenant: 'tenant',
  family_member: 'family_member',
  owner: 'owner',
};

const PLAN_FROM_ROW: Readonly<Record<string, SubscriptionPlan>> = {
  free: 'free',
  // The PRD distinguishes `premium` from `society_pro`; the domain has one paid
  // residential tier. Lossy by design — and safe, because `plan` is never written
  // by this adapter (billing is server-side), so no round trip can corrupt it.
  premium: 'pro',
  society_pro: 'pro',
  pro: 'pro',
  enterprise: 'enterprise',
};

/**
 * The domain models three membership states; the database has five. The two
 * extras collapse onto `removed`, which is the honest answer for both: an
 * `inactive` member and a `rejected` applicant can each do nothing in the
 * society, and the domain's capability rules only ever ask "can this membership
 * act?".
 */
const STATUS_FROM_ROW: Readonly<Record<string, MembershipStatus>> = {
  pending: 'pending',
  active: 'active',
  removed: 'removed',
  inactive: 'removed',
  rejected: 'removed',
};

/**
 * Unknown values degrade to the *least* privileged option rather than throwing.
 * A role the client does not recognise must never become `admin`, and a status it
 * cannot place must never become `active` — a forward-compatible database (a new
 * role added by T046) would otherwise silently grant access.
 */
function roleFromRow(value: string): MemberRole {
  return ROLE_FROM_ROW[value] ?? 'guest';
}

function occupancyFromRow(value: string): OccupancyType {
  return OCCUPANCY_FROM_ROW[value] ?? 'family_member';
}

function planFromRow(value: string): SubscriptionPlan {
  return PLAN_FROM_ROW[value] ?? 'free';
}

function statusFromRow(value: string): MembershipStatus {
  return STATUS_FROM_ROW[value] ?? 'removed';
}

/** Domain → row, for the one write path that sends an occupancy (a join). */
export function occupancyToRow(occupancy: OccupancyType): string {
  return occupancy === 'owner' ? 'owner_occupied' : occupancy;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mappers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Settings are split across two tables in SQL (`societies.timezone` and
 * `societies.currency` live on the society; the rest on `society_settings`)
 * because that is where the PRD puts them. The domain keeps one `SocietySettings`
 * object, so the mapper merges them.
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
    currency: 'INR',
  };
}

export function societyFromSnapshot(snapshot: SocietySnapshot, memberCount: number): Society {
  const row = snapshot.society;
  return {
    id: asSocietyId(row.id),
    name: row.name,
    slug: row.slug,
    // The column is CHECK-constrained to the same five values; `other` keeps a
    // future value from crashing a screen while the domain catches up.
    type: isSocietyType(row.society_type) ? row.society_type : 'other',
    registrationNumber: row.registration_no,
    addressLine1: row.address_line1,
    addressLine2: row.address_line2,
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    country: 'IN',
    currency: 'INR',
    timezone: row.timezone,
    joinCode: row.join_code,
    joinCodeExpiresAt: toIso(row.join_code_expires_at),
    plan: planFromRow(row.plan),
    createdBy: asUserId(row.created_by),
    createdAt: toIso(row.created_at) ?? row.created_at,
    updatedAt: toIso(row.updated_at) ?? row.updated_at,
    deletedAt: toIso(row.deleted_at),
    settings: settingsFromRow(row, snapshot.settings),
    memberCount,
  };
}

/**
 * One membership row → the domain's view of it.
 *
 * Shadow members (no `user_id` yet) are the caller's problem: the domain's
 * `SocietyMembership` requires a `UserId`, so they are filtered out by the
 * repository's roster read rather than invented here. The members module (T045)
 * is where they get their own representation.
 */
export function membershipFromRow(row: MemberRow): SocietyMembership {
  if (row.user_id === null) {
    throw new SocietyError(
      'unknown',
      'A membership without a user account cannot be represented yet.',
    );
  }
  return {
    id: asMemberId(row.id),
    societyId: asSocietyId(row.society_id),
    userId: asUserId(row.user_id),
    role: roleFromRow(row.role),
    status: statusFromRow(row.status),
    occupancyType: occupancyFromRow(row.occupancy),
    joinedAt: toIso(row.joined_at),
  };
}

export function joinPreviewFromPayload(payload: JoinPreviewPayload): SocietyJoinPreview {
  return {
    id: asSocietyId(payload.id),
    name: payload.name,
    city: payload.city,
    state: payload.state,
    type: isSocietyType(payload.type) ? payload.type : 'other',
    memberCount: payload.memberCount,
    joinCodeExpiresAt: toIso(payload.joinCodeExpiresAt ?? null),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Request payloads
// ─────────────────────────────────────────────────────────────────────────────

/** The `society_create()` argument: what the wizard collected, nothing derived. */
export function createPayload(input: CreateSocietyInput): Record<string, unknown> {
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
 * this optional field" as a key that is *present and `undefined`*
 * (`update-society.ts`: `patch.registrationNumber = … ?? undefined`), and
 * `JSON.stringify` drops such keys — so a naive spread would turn "clear the
 * registration number" into "leave it alone". Translating `undefined` to an
 * explicit `null` preserves the distinction, and the RPC reads `null` on a
 * nullable column as a clear.
 */
export function updatePayload(input: UpdateSocietyInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    payload[key] = value ?? null;
  }
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

interface PostgrestErrorLike {
  readonly code?: string;
  readonly message?: string;
  readonly details?: string;
  readonly hint?: string;
}

/** Codes raised by the migrations' own functions (see the RPC migration header). */
export const SQLSTATE = {
  raised: 'P0001',
  societyNotFound: 'P0002',
  societyForbidden: 'P0003',
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  insufficientPrivilege: '42501',
  undefinedTable: '42P01',
  noRows: 'PGRST116',
} as const;

/**
 * The named exceptions the migrations raise. They travel as `P0001` with the name
 * in the message, so they are matched by name rather than by code — which is why
 * every one of them is listed here instead of inline: adding a `RAISE EXCEPTION`
 * to the SQL without adding it here would silently become "unknown", and this
 * list is what makes that omission visible in review.
 */
export const RAISED_EXCEPTION = {
  societyNotFound: 'SOCIETY_NOT_FOUND',
  societyForbidden: 'SOCIETY_FORBIDDEN',
  societyAdminRequired: 'SOCIETY_ADMIN_REQUIRED',
  memberStatusChangeForbidden: 'MEMBER_STATUS_CHANGE_FORBIDDEN',
  memberRoleChangeForbidden: 'MEMBER_ROLE_CHANGE_FORBIDDEN',
  memberUserImmutable: 'MEMBER_USER_IMMUTABLE',
  memberSocietyImmutable: 'MEMBER_SOCIETY_IMMUTABLE',
  emptyPatch: 'EMPTY_PATCH',
  emptyPayload: 'EMPTY_PAYLOAD',
  notAuthenticated: 'NOT_AUTHENTICATED',
} as const;

/**
 * A payload that did not match its row schema. Always a bug on one side of the
 * boundary (a renamed column, a new nullable field), never something the user
 * did — so the copy is generic and the real message goes to the developer
 * channel in `details`.
 */
export function unexpectedShapeError(what: string): SocietyError {
  return new SocietyError('unknown', 'Something went wrong. Please try again.', {
    hint: `Unexpected ${what} shape returned by Supabase.`,
  });
}

function asErrorLike(error: unknown): PostgrestErrorLike {
  return (error ?? {}) as PostgrestErrorLike;
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
    /join_code/i.test(`${candidate.message ?? ''} ${candidate.details ?? ''}`)
  );
}

/**
 * Postgres/PostgREST failure → the domain's error vocabulary.
 *
 * `context` matters for exactly one case and it is the important one: RLS reports
 * the same `42501` for "you are not in this tenant" and for "your role is not
 * enough". On a **read** that must be `not_found` (PRD T041: a non-member cannot
 * tell a foreign society from a non-existent one). On a **write** the RPC has
 * already run the membership check, so the caller is a member who lacks the role
 * — `forbidden`, and the user is told why. Guessing the other way round would
 * either leak existence or leave a Treasurer staring at "not found" for their own
 * society.
 *
 * The Postgres `details` field is deliberately NOT copied into the error: it can
 * contain column values (a join code, an email) and these objects travel toward
 * the UI.
 */
export function societyErrorFromPostgrest(error: unknown, context: 'read' | 'write'): SocietyError {
  const candidate = asErrorLike(error);
  const code = candidate.code ?? '';
  const message = candidate.message ?? '';
  const hint = candidate.hint;
  const haystack = `${message} ${candidate.details ?? ''}`;

  const withHint = (details?: Record<string, unknown>) => ({
    code: candidate.code,
    ...(hint === undefined ? {} : { hint }),
    ...details,
  });

  switch (code) {
    case SQLSTATE.noRows:
    case SQLSTATE.societyNotFound:
      return new SocietyError('not_found', 'That society is not available to you.', withHint());

    case SQLSTATE.societyForbidden:
      return new SocietyError(
        'forbidden',
        hint ?? 'Only a society Admin can change society details.',
        withHint(),
      );

    case SQLSTATE.raised:
      return raisedError(message, hint, withHint());

    case SQLSTATE.insufficientPrivilege:
      // Two very different failures share this code, and the message is what
      // separates them:
      //   "permission denied for table …"  — the role itself has no grant, which
      //      for this app means no session (a request without a JWT arrives as
      //      `anon`, and nothing is granted to it). An auth problem, not a
      //      tenancy one.
      //   "new row violates row-level security policy" — a policy rejected the
      //      row. On a write that is the role/membership case; note that on a
      //      SELECT it never appears, because RLS *filters* reads instead of
      //      raising, so an empty result is how a non-member is answered.
      if (/permission denied for table/i.test(message)) {
        return new SocietyError(
          'forbidden',
          'Your session expired. Please sign in again.',
          withHint(),
        );
      }
      return context === 'read'
        ? new SocietyError('not_found', 'That society is not available to you.', withHint())
        : new SocietyError(
            'forbidden',
            'Only a society Admin can change society details.',
            withHint(),
          );

    case SQLSTATE.uniqueViolation:
      if (/user_id|society_id, user_id/i.test(haystack)) {
        return new SocietyError(
          'already_member',
          'You are already a member of this society.',
          withHint(),
        );
      }
      if (/join_code/i.test(haystack)) {
        return new SocietyError(
          'conflict',
          'Could not reserve a join code. Please try again.',
          withHint(),
        );
      }
      if (/slug/i.test(haystack)) {
        return new SocietyError(
          'conflict',
          'A society with a very similar name already exists.',
          withHint(),
        );
      }
      return new SocietyError(
        'conflict',
        'That change conflicts with an existing record.',
        withHint(),
      );

    case SQLSTATE.checkViolation:
      return new SocietyError('validation', checkViolationMessage(haystack), withHint());

    case SQLSTATE.foreignKeyViolation:
      // The referenced society or account does not exist (any more).
      return new SocietyError('not_found', 'That society is not available to you.', withHint());

    case SQLSTATE.undefinedTable:
      return missingSchemaError(withHint());

    default:
      break;
  }

  if (/row-level security|permission denied/i.test(message)) {
    return context === 'read'
      ? new SocietyError('not_found', 'That society is not available to you.', withHint())
      : new SocietyError(
          'forbidden',
          'Only a society Admin can change society details.',
          withHint(),
        );
  }

  // PostgREST reports "no such table/function" as a schema-cache miss rather
  // than a Postgres error, and the cause is nearly always the same.
  if (/schema cache/i.test(message) && /societ/i.test(message)) {
    return missingSchemaError(withHint());
  }

  return new SocietyError('unknown', 'Something went wrong. Please try again.', {
    code,
    ...(hint === undefined ? {} : { hint }),
  });
}

function raisedError(
  message: string,
  hint: string | undefined,
  base: Record<string, unknown>,
): SocietyError {
  if (message.includes(RAISED_EXCEPTION.societyAdminRequired)) {
    return new SocietyError(
      'sole_admin',
      hint ?? 'You are the only Admin. Promote another member to Admin first.',
      base,
    );
  }
  if (message.includes(RAISED_EXCEPTION.memberStatusChangeForbidden)) {
    return new SocietyError(
      'forbidden',
      hint ?? 'Joining a society needs an Admin to approve it.',
      base,
    );
  }
  if (message.includes(RAISED_EXCEPTION.memberRoleChangeForbidden)) {
    return new SocietyError('forbidden', hint ?? 'Only a society Admin can change roles.', base);
  }
  if (
    message.includes(RAISED_EXCEPTION.memberUserImmutable) ||
    message.includes(RAISED_EXCEPTION.memberSocietyImmutable)
  ) {
    return new SocietyError('forbidden', 'That membership cannot be changed.', base);
  }
  if (
    message.includes(RAISED_EXCEPTION.emptyPatch) ||
    message.includes(RAISED_EXCEPTION.emptyPayload)
  ) {
    return new SocietyError('validation', 'Nothing to update.', base);
  }
  if (message.includes(RAISED_EXCEPTION.notAuthenticated)) {
    return new SocietyError('forbidden', 'Your session expired. Please sign in again.', base);
  }
  return new SocietyError('unknown', 'Something went wrong. Please try again.', base);
}

function checkViolationMessage(haystack: string): string {
  if (/society_type/i.test(haystack)) return 'Choose a society type.';
  if (/pincode/i.test(haystack)) return 'Enter a 6-digit PIN code.';
  if (/join_code/i.test(haystack)) return 'That join code is not valid.';
  if (/billing_day|due_day/i.test(haystack)) return 'Choose a day between 1 and 28.';
  if (/financial_year_start_month/i.test(haystack)) return 'Choose a month between 1 and 12.';
  return 'Please check the details and try again.';
}

/**
 * A missing migration is a developer error, not a user one — so the message stays
 * generic (it can surface in the UI through `societyErrorMessage`) while the
 * actionable part travels in `details`, which the UI never renders.
 */
function missingSchemaError(base: Record<string, unknown>): SocietyError {
  return new SocietyError(
    'unknown',
    'This part of the app is not available yet. Please try again later.',
    {
      ...base,
      hint: 'The society tables are missing. Apply supabase/migrations/20260920130*.sql.',
    },
  );
}
