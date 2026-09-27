import {
  DEFAULT_MEMBER_OCCUPANCY,
  DEFAULT_MEMBER_ROLE,
  MemberError,
  asApartmentId,
  asBuildingId,
  asMemberId,
  asSocietyId,
  asUserId,
  isMemberOccupancy,
  isMemberStatus,
} from "@ses/domain";
import type { JoinRequest, Member, MemberRole } from "@ses/domain";
import { z } from "zod";

import {
  asErrorLike,
  SQLSTATE,
} from "../../../common/database/postgres-errors";
import {
  nullableTimestampSchema,
  timestampSchema,
  toIso,
} from "../../../common/database/postgres-rows";

/**
 * The database ⇄ domain boundary for the members module.
 *
 * Every nullability difference, enum translation and SQLSTATE this module can receive is
 * decided here, once, rather than across eight repository methods. Rows are **validated, not
 * trusted**: a column rename or a new `NOT NULL` must fail loudly here rather than reach a
 * use case as `undefined`.
 *
 * ## The one translation this file *does* need, and the one it does not
 *
 * Almost none: `member_status` and `occupancy_type` are the same five and four values in
 * `@ses/domain` as in `20260920130000_society_core.sql`. That is the deliberate result of the
 * T045 decision to reuse the shipped enums rather than rename them (see `member.ts`).
 *
 * `member_role` is the exception, and it is one spelling: the database says `committee`, the
 * domain says `committee_member`. Both directions live here — `roleFromRow` for reads,
 * `roleToDatabase` for writes and filters — because a single one-way translation is exactly the
 * bug that survives review: reads look right, and a role *filter* or a role *write* fails on the
 * enum cast with a `22P02` the classifier can only call `unknown`. (The directory's `role=` filter
 * carried that bug until T046 added the write path beside it.)
 *
 * What it cannot skip is *validating*: a value the enum does not have — a future
 * `member_status` label, a column that became nullable — has to be refused here. For an
 * unrecognised role or status the answer is the least privileged one rather than a throw
 * (the same choice `society.rows.ts` documents: an unknown role must never become `admin`
 * and an unknown status must never become `active`), while an unrecognised occupancy is a
 * shape error, because there is no "least privileged" occupancy and guessing one would put a
 * billing-relevant value on a member nobody chose.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `date` column, normalised to `YYYY-MM-DD`.
 *
 * `postgres.js` parses `date` (OID 1082) as a JavaScript `Date` at **UTC midnight** — measured,
 * not assumed: `select '2026-01-01'::date` comes back as `2026-01-01T00:00:00.000Z`, so the
 * first ten characters of the ISO string are the column's value with no timezone to shift.
 * A string is accepted too, because a repair script or a future cast may hand one over.
 */
const dateColumnSchema = z
  .union([z.string(), z.date(), z.null()])
  .transform((value) => {
    const iso = toIso(value);
    return iso === null ? null : iso.slice(0, 10);
  });

/** `coerce` on the numerics: a `smallint` can arrive as a string on some drivers. */
export const memberRowSchema = z.object({
  id: z.string(),
  society_id: z.string(),
  /** `null` = a shadow member: recorded by an Admin, no account yet (PRD §3.3). */
  user_id: z.string().nullable(),
  apartment_id: z.string().nullable(),
  display_name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  role: z.string(),
  status: z.string(),
  occupancy: z.string(),
  is_primary: z.boolean(),
  lease_start: dateColumnSchema,
  lease_end: dateColumnSchema,
  share_contact: z.boolean(),
  joined_at: nullableTimestampSchema,
  approved_by: z.string().nullable(),
  removed_at: nullableTimestampSchema,
  removed_by: z.string().nullable(),
  /** T049 — the join request's own fields, on the membership row that *is* the request. */
  request_note: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  rejected_at: nullableTimestampSchema,
  rejected_by: z.string().nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
  /** Joined from `apartments` — absent for a member with no flat. */
  apartment_number: z.string().nullable().optional(),
  building_id: z.string().nullable().optional(),
  building_name: z.string().nullable().optional(),
  floor: z.coerce.number().int().nullable().optional(),
  /** `count(*) OVER ()`, present only on the directory read. */
  total: z.coerce.number().int().optional(),
});
export type MemberRow = z.infer<typeof memberRowSchema>;

export const memberRowListSchema = z.array(memberRowSchema);

/**
 * One row of the join queue: a membership row, plus the other claimants of its flat.
 *
 * The claims are aggregated in SQL as JSON and validated **by `memberRowSchema` itself** —
 * `row_to_json()` in the query keeps the column names identical, so there is one schema and
 * one mapper for `public.members` rather than a second pair that would drift the first time a
 * column is added.
 */
export const joinRequestRowSchema = memberRowSchema.extend({
  claims: z.array(memberRowSchema),
});
export type JoinRequestRow = z.infer<typeof joinRequestRowSchema>;

export const joinRequestRowListSchema = z.array(joinRequestRowSchema);

/** One queue row → the domain's `JoinRequest`. */
export function joinRequestFromRow(row: JoinRequestRow): JoinRequest {
  return {
    member: memberFromRow(row),
    claims: row.claims.map((claim) => memberFromRow(claim)),
  };
}

/** `count(*)::int as count` — the one aggregate this module reads. */
export const memberCountRowSchema = z.object({
  count: z.coerce.number().int(),
});

/**
 * One row → the domain entity.
 *
 * The `society_id` and the timestamps are taken from the row rather than from the arguments
 * that produced the query: the row is the authority, and echoing back what the caller asked
 * for would let a bug in a `WHERE` clause go unnoticed.
 */
export function memberFromRow(row: MemberRow): Member {
  return {
    id: asMemberId(row.id),
    societyId: asSocietyId(row.society_id),
    userId: row.user_id === null ? null : asUserId(row.user_id),
    apartmentId:
      row.apartment_id === null ? null : asApartmentId(row.apartment_id),
    // The three joined labels are null together or present together; a member with an
    // `apartment_id` whose apartment row is gone (a repair, a hard delete) renders as "no
    // flat recorded" rather than as a half-built address.
    apartment:
      row.apartment_id === null ||
      row.apartment_number === undefined ||
      row.apartment_number === null
        ? null
        : {
            id: asApartmentId(row.apartment_id),
            number: row.apartment_number,
            buildingId: asBuildingId(row.building_id ?? ""),
            buildingName: row.building_name ?? null,
            floor: row.floor ?? null,
          },
    displayName: row.display_name,
    phone: row.phone,
    email: row.email,
    role: roleFromRow(row.role),
    status: statusFromRow(row.status),
    occupancy: occupancyFromRow(row.occupancy),
    isPrimary: row.is_primary,
    leaseStart: row.lease_start,
    leaseEnd: row.lease_end,
    shareContact: row.share_contact,
    joinedAt: row.joined_at,
    approvedBy: row.approved_by === null ? null : asMemberId(row.approved_by),
    removedAt: row.removed_at,
    removedBy: row.removed_by === null ? null : asMemberId(row.removed_by),
    requestNote: row.request_note,
    rejectionReason: row.rejection_reason,
    rejectedAt: row.rejected_at,
    rejectedBy: row.rejected_by === null ? null : asMemberId(row.rejected_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function membersFromRows(rows: readonly MemberRow[]): readonly Member[] {
  return rows.map((row) => memberFromRow(row));
}

/**
 * Unknown values degrade to the **least** privileged option rather than throwing.
 *
 * A role the API does not recognise must never become `admin`, and a status it cannot place
 * must never become `active` — a forward-compatible database (a role or status added by
 * T046/T049) would otherwise silently grant access. The conservative cells are the same ones
 * `society.rows.ts` chose, so the two modules cannot disagree about a new label.
 */
function roleFromRow(value: string): MemberRole {
  const known: readonly MemberRole[] = [
    "admin",
    "treasurer",
    "committee_member",
    "resident",
    "tenant",
    "guest",
  ];
  if (value === "committee") return "committee_member";
  const match = known.find((role) => role === value);
  return match ?? "guest";
}

/**
 * The domain's role → the label `public.member_role` actually has.
 *
 * The inverse of the one branch in `roleFromRow`, kept beside it so the two cannot drift: every
 * read of a role and every write of one goes through this pair. `MemberRole` is already the
 * closed union, so a member of it that is somehow unmapped is a compile-time impossibility
 * rather than something to validate at runtime.
 */
export function roleToDatabase(role: MemberRole): string {
  return role === "committee_member" ? "committee" : role;
}

function statusFromRow(value: string) {
  return isMemberStatus(value) ? value : ("inactive" as const);
}

function occupancyFromRow(value: string) {
  if (isMemberOccupancy(value)) return value;
  throw unexpectedShapeError("member occupancy");
}

/**
 * A row that did not match its schema. Always a bug on one side of the boundary (a renamed
 * column, a new nullable field), never something the user did — so the copy stays generic and
 * the actionable part is a hint for the operator.
 */
export function unexpectedShapeError(what: string): MemberError {
  return new MemberError("unknown", "Something went wrong. Please try again.", {
    hint: `Unexpected ${what} shape returned by the database.`,
  });
}

/** The column default of `occupancy`, re-exported so a caller can name it. */
export { DEFAULT_MEMBER_OCCUPANCY, DEFAULT_MEMBER_ROLE };

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The named exceptions the member migration and the membership triggers raise.
 *
 * They travel as `P0001` with the name in the message, so they are matched by name rather
 * than by code — which is why every one of them is listed here instead of inline: adding a
 * `RAISE EXCEPTION` to the SQL without adding it here would silently become `unknown`, and
 * this list is what makes that omission visible in review.
 */
export const RAISED_EXCEPTION = {
  /** `chk_admin_present()` — the last active admin cannot be removed or suspended. */
  societyAdminRequired: "SOCIETY_ADMIN_REQUIRED",
  /** `chk_role_caps()` — PRD §2.2's caps (3 admins, 2 treasurers), re-checked at the write. */
  societyRoleCapExceeded: "SOCIETY_ROLE_CAP_EXCEEDED",
  memberStatusChangeForbidden: "MEMBER_STATUS_CHANGE_FORBIDDEN",
  memberRoleChangeForbidden: "MEMBER_ROLE_CHANGE_FORBIDDEN",
  /** New in T045: only an Admin may move a membership between flats. */
  memberApartmentChangeForbidden: "MEMBER_APARTMENT_CHANGE_FORBIDDEN",
  memberSocietyImmutable: "MEMBER_SOCIETY_IMMUTABLE",
  memberUserImmutable: "MEMBER_USER_IMMUTABLE",

  // T049's join-request decisions. Every one of them is raised by name from
  // `20260926130000_join_requests.sql`, which is why they are listed here: an omission
  // would silently degrade a refusal that has a screen into `unknown` → 500.
  /** The request was already decided, withdrawn or removed — a second tap, or a race. */
  joinRequestNotPending: "JOIN_REQUEST_NOT_PENDING",
  /** The caller tried to decide their own request. */
  joinSelfReview: "JOIN_SELF_REVIEW",
  /** The reviewer's own membership is missing, inactive or not Admin/Treasurer. */
  joinReviewForbidden: "JOIN_REVIEW_FORBIDDEN",
  joinReviewDenied: "JOIN_REVIEW_DENIED",
  joinRequestNotFound: "JOIN_REQUEST_NOT_FOUND",
  /** A role above Resident, from somebody who does not hold `member.role_change`. */
  joinRoleNotAssignable: "JOIN_ROLE_NOT_ASSIGNABLE",
  /** The flat named by the approval is not a live flat of the request's society. */
  joinApartmentInvalid: "JOIN_APARTMENT_INVALID",
  /** A rejection with no usable reason — the requester is owed one. */
  joinRejectionReasonRequired: "JOIN_REJECTION_REASON_REQUIRED",
} as const;

/** Constraint names worth a specific answer rather than "that change conflicts". */
const CONSTRAINT = {
  shadowPhone: "uq_members_shadow_phone",
  primaryOccupant: "uq_primary_occupant",
  apartmentSociety: "fk_members_apartment_society",
  societyUser: "members_society_user_key",
} as const;

/**
 * Postgres failure → the module's error vocabulary.
 *
 * `context` matters for exactly one case, and it is the same one every module documents:
 * `42501` covers both "your role has no grant on this table" and "RLS refused this row". On a
 * **read** that must be `not_found` (PRD T041: a non-member cannot tell a foreign society
 * from a non-existent one). On a **write** the caller has already passed `SocietyGuard`, so
 * they are an active member and the only thing RLS can be refusing is their *role* —
 * `forbidden`, a message the user can act on, rather than a 404 for a society they can
 * plainly see.
 *
 * Postgres's `detail` is deliberately NOT copied into the error: it can carry column values
 * (a phone number, an email) and these objects travel toward the UI.
 */
export function memberErrorFromPostgres(
  error: unknown,
  context: "read" | "write",
): MemberError {
  const candidate = asErrorLike(error);
  const code = candidate.code ?? "";
  const message = candidate.message ?? "";
  const hint = candidate.hint;
  // The constraint name is included because a check violation's most useful discriminator
  // lives there (and in the message), not always in `detail`.
  const haystack = [
    message,
    candidate.detail,
    candidate.constraint,
    candidate.constraint_name,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ");

  const withHint = (): Record<string, unknown> => ({
    code: candidate.code,
    ...(hint === undefined ? {} : { hint }),
  });

  switch (code) {
    case SQLSTATE.notFound:
      // `assert_society_membership`/`assert_society_admin` use P0002/P0003 for their
      // refusals, and a definer helper reached from this module reports the same way. All one
      // answer to the caller: there is nothing here for you.
      return new MemberError(
        "not_found",
        "That member is not available to you.",
        withHint(),
      );

    case SQLSTATE.forbidden:
      return new MemberError(
        "forbidden",
        hint ?? "Only a society Admin can make that change.",
        withHint(),
      );

    case SQLSTATE.raised:
      return raisedError(message, hint, withHint());

    case SQLSTATE.insufficientPrivilege:
      if (/permission denied for table/i.test(message)) {
        // The role itself has no grant, which for this app means the request arrived without
        // a usable identity: nothing is granted to `anon`.
        return new MemberError(
          "forbidden",
          "Your session expired. Please sign in again.",
          withHint(),
        );
      }
      return context === "read"
        ? new MemberError(
            "not_found",
            "That member is not available to you.",
            withHint(),
          )
        : new MemberError(
            "forbidden",
            "Only a society Admin can make that change.",
            withHint(),
          );

    case SQLSTATE.uniqueViolation:
      if (/phone|shadow_phone/i.test(haystack)) {
        return new MemberError(
          "conflict",
          "Another member in this society is already recorded with that number.",
          { ...withHint(), field: "phone" },
        );
      }
      if (/primary_occupant|occupancy/i.test(haystack)) {
        // PRD §7's `uq_primary_occupant`: one primary owner and one primary tenant per flat.
        // Reached when two requests race past the application's own read, which is exactly
        // why the index exists.
        return new MemberError(
          "conflict",
          "That flat already has a primary occupant for this occupancy.",
          { ...withHint(), field: "apartmentId" },
        );
      }
      if (/society_id, user_id|members_society_user_key/i.test(haystack)) {
        return new MemberError(
          "conflict",
          "That person is already a member of this society.",
          withHint(),
        );
      }
      return new MemberError(
        "conflict",
        "That change conflicts with an existing record.",
        withHint(),
      );

    case SQLSTATE.checkViolation:
      return new MemberError("validation", checkViolationMessage(haystack), {
        ...withHint(),
        field: checkViolationField(haystack),
      });

    case SQLSTATE.foreignKeyViolation:
      if (/apartment/i.test(haystack)) {
        // The composite key is what makes this reachable at all: a flat in another society
        // satisfies every other constraint the row has.
        return new MemberError(
          "validation",
          "That flat is not in this society.",
          { ...withHint(), field: "apartmentId" },
        );
      }
      return new MemberError(
        "not_found",
        "That society is not available to you.",
        withHint(),
      );

    case SQLSTATE.undefinedTable:
      return new MemberError(
        "unknown",
        "This part of the app is not available yet. Please try again later.",
        {
          ...withHint(),
          hint: "The members directory is missing. Apply supabase/migrations/20260925120000_members_directory.sql.",
        },
      );

    default:
      break;
  }

  if (/row-level security|permission denied/i.test(message)) {
    return context === "read"
      ? new MemberError(
          "not_found",
          "That member is not available to you.",
          withHint(),
        )
      : new MemberError(
          "forbidden",
          "Only a society Admin can make that change.",
          withHint(),
        );
  }

  return new MemberError("unknown", "Something went wrong. Please try again.", {
    code,
    ...(hint === undefined ? {} : { hint }),
  });
}

function raisedError(
  message: string,
  hint: string | undefined,
  base: Record<string, unknown>,
): MemberError {
  if (message.includes(RAISED_EXCEPTION.societyAdminRequired)) {
    return new MemberError(
      "sole_admin",
      hint ?? "A society needs at least one active Admin.",
      base,
    );
  }
  if (message.includes(RAISED_EXCEPTION.societyRoleCapExceeded)) {
    // A cap, not a state: the use case counted first and this is the database refusing a value it
    // did not see (two Admins promoting at the same moment). `field: role` so the picker — the only
    // screen that can act on it — is what highlights.
    return new MemberError(
      "role_cap_exceeded",
      hint ??
        "That role is already held by as many members as this society allows.",
      { ...base, field: "role" },
    );
  }
  if (
    message.includes(RAISED_EXCEPTION.memberApartmentChangeForbidden) ||
    message.includes(RAISED_EXCEPTION.memberSocietyImmutable) ||
    message.includes(RAISED_EXCEPTION.memberUserImmutable)
  ) {
    return new MemberError(
      "forbidden",
      hint ?? "Only a society Admin can move a membership.",
      base,
    );
  }
  if (message.includes(RAISED_EXCEPTION.memberStatusChangeForbidden)) {
    return new MemberError(
      "forbidden",
      hint ?? "Joining a society needs an Admin to approve it.",
      base,
    );
  }
  if (message.includes(RAISED_EXCEPTION.memberRoleChangeForbidden)) {
    return new MemberError(
      "forbidden",
      hint ?? "Only a society Admin can change roles.",
      base,
    );
  }

  // ── T049: the join queue ───────────────────────────────────────────────────
  if (message.includes(RAISED_EXCEPTION.joinRequestNotPending)) {
    return new MemberError(
      "join_request_not_pending",
      hint ?? "That request has already been decided.",
      { ...base, field: "memberId" },
    );
  }
  if (message.includes(RAISED_EXCEPTION.joinSelfReview)) {
    return new MemberError(
      "self_review",
      hint ?? "You cannot decide your own request.",
      { ...base, field: "memberId" },
    );
  }
  if (message.includes(RAISED_EXCEPTION.joinRoleNotAssignable)) {
    // A field error rather than a plain refusal: the role is what has to change, and the
    // picker is the screen that can change it.
    return new MemberError(
      "role_not_assignable",
      hint ??
        "Only a society Admin can admit somebody at a role above Resident.",
      { ...base, field: "role" },
    );
  }
  if (message.includes(RAISED_EXCEPTION.joinApartmentInvalid)) {
    return new MemberError(
      "validation",
      hint ?? "That flat is not an available flat of this society.",
      { ...base, field: "apartmentId" },
    );
  }
  if (message.includes(RAISED_EXCEPTION.joinRejectionReasonRequired)) {
    return new MemberError(
      "validation",
      hint ?? "Give a reason the requester can act on.",
      { ...base, field: "reason" },
    );
  }
  if (
    message.includes(RAISED_EXCEPTION.joinRequestNotFound) ||
    message.includes(RAISED_EXCEPTION.joinReviewForbidden) ||
    message.includes(RAISED_EXCEPTION.joinReviewDenied)
  ) {
    // One answer for "no such request", "another society's request" and "your membership
    // cannot review" — the caller learns nothing about a row they may not decide, and the
    // use case has already answered the readable cases (404/403) before reaching the
    // database.
    return new MemberError(
      "not_found",
      hint ?? "That join request is not available to you.",
      base,
    );
  }
  return new MemberError(
    "unknown",
    "Something went wrong. Please try again.",
    base,
  );
}

function checkViolationField(haystack: string): string {
  if (/lease/i.test(haystack)) return "leaseEnd";
  if (/primary_requires_apartment/i.test(haystack)) return "apartmentId";
  if (/name_not_blank|display_name/i.test(haystack)) return "displayName";
  if (/rejection_reason/i.test(haystack)) return "reason";
  if (/request_note/i.test(haystack)) return "message";
  return "member";
}

/** Names the offending field, so a form can highlight it rather than guess. */
function checkViolationMessage(haystack: string): string {
  if (/lease/i.test(haystack)) {
    return "Lease end cannot be before the lease start.";
  }
  if (/primary_requires_apartment/i.test(haystack)) {
    return "Choose the flat this member is the primary occupant of.";
  }
  if (/name_not_blank|display_name/i.test(haystack)) {
    return "Enter a name.";
  }
  if (/rejection_reason/i.test(haystack)) {
    return "Give a reason the requester can act on.";
  }
  if (/request_note/i.test(haystack)) {
    return "Your note is too long.";
  }
  return "Please check the details and try again.";
}

export { CONSTRAINT };
