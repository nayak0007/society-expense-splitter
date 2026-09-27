import {
  INVITATION_CHANNELS,
  INVITATION_STATUSES,
  InvitationError,
  asApartmentId,
  asInvitationId,
  asMemberId,
  asSocietyId,
} from "@ses/domain";
import type {
  Invitation,
  InvitationAcceptance,
  InvitationChannel,
  InvitationPreview,
  InvitationStatus,
  MemberRole,
} from "@ses/domain";
import { z } from "zod";

import {
  asErrorLike,
  SQLSTATE,
} from "../../../common/database/postgres-errors";
import {
  nullableTimestampSchema,
  timestampSchema,
} from "../../../common/database/postgres-rows";
import { roleToDatabase } from "../../members/infrastructure/member.rows";

/**
 * The database ⇄ domain boundary for the invitations module.
 *
 * Rows are **validated, not trusted**: a renamed column or a new `NOT NULL` fails loudly here rather
 * than reaching a use case as `undefined`.
 *
 * ## The one translation, reused rather than rewritten
 *
 * `member_role` has a spelling the domain does not (`committee` vs `committee_member`), and the pair
 * of functions that translate it lives in `member.rows.ts`. This file imports `roleToDatabase` from
 * there instead of copying it — the invites module hands roles to the same column, and a second copy
 * of a one-word translation is precisely the kind of duplication that drifts and then fails as a
 * `22P02` nobody can explain.
 *
 * ## Unknown values degrade to the safe ones
 *
 * An unrecognised `status` becomes `revoked` — the closed reading: a status the API cannot place
 * must never be treated as live, because "live" is the value that admits somebody. An unrecognised
 * `channel` becomes `link`, which claims the least (it is the one channel that carries no address,
 * so nothing is disclosed by mis-rendering it).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One `public.invitations` row, as the management reads see it.
 *
 * `token_hash` is **absent, and not by accident**: the column is in no SELECT grant, so a statement
 * that asked for it would fail with `42501` rather than leak. Leaving it out of this schema is the
 * second half of that guarantee — a row shape that had it would tempt a query to fetch it.
 *
 * `invitee_hint` does not exist as a column: the repository composes it from the row's address or
 * number with the domain's `maskInvitee`, so the manager's list shows exactly what the recipient's
 * preview will.
 */
export const invitationRowSchema = z.object({
  id: z.string(),
  society_id: z.string(),
  apartment_id: z.string().nullable(),
  invited_by: z.string(),
  invited_by_name: z.string().nullable().optional(),
  channel: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  role: z.string(),
  status: z.string(),
  expires_at: timestampSchema,
  opened_at: nullableTimestampSchema,
  accepted_at: nullableTimestampSchema,
  revoked_at: nullableTimestampSchema,
  created_at: timestampSchema,
  /** Joined for the list: the flat's number, absent when the invitation names no flat. */
  apartment_number: z.string().nullable().optional(),
  /** `count(*) OVER ()`, present only on the list read. */
  total: z.coerce.number().int().optional(),
});
export type InvitationRow = z.infer<typeof invitationRowSchema>;

export const invitationRowListSchema = z.array(invitationRowSchema);

/** The `jsonb` shape `invitation_preview()` returns. */
export const invitationPreviewRowSchema = z.object({
  id: z.string(),
  society_id: z.string(),
  society_name: z.string(),
  role: z.string(),
  apartment_id: z.string().nullable(),
  apartment_number: z.string().nullable(),
  channel: z.string(),
  invitee_hint: z.string(),
  requires_account_match: z.boolean(),
  status: z.string(),
  expired: z.boolean(),
  expires_at: timestampSchema,
  apartment_addressable: z.boolean().optional(),
});
export type InvitationPreviewRow = z.infer<typeof invitationPreviewRowSchema>;

/** The `jsonb` shape `invitation_accept()` returns. */
export const invitationAcceptanceRowSchema = z.object({
  society_id: z.string(),
  member_id: z.string(),
  role: z.string(),
  apartment_id: z.string().nullable(),
  linked_shadow: z.boolean(),
});
export type InvitationAcceptanceRow = z.infer<
  typeof invitationAcceptanceRowSchema
>;

/** `count(*)::int as count`. */
export const invitationCountRowSchema = z.object({
  count: z.coerce.number().int(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row → the domain entity.
 *
 * No mask here: the entity carries the address and the *wire* carries `in***@example.com`, so the
 * mask is composed by the presentation mapper (`maskInvitee`). Putting it on the entity would make a
 * masked string the thing the domain holds, and then the create path — which must keep the real
 * address to send nothing yet but to match on acceptance — would have to un-mask it.
 */
export function invitationFromRow(row: InvitationRow): Invitation {
  return {
    id: asInvitationId(row.id),
    societyId: asSocietyId(row.society_id),
    apartmentId:
      row.apartment_id === null ? null : asApartmentId(row.apartment_id),
    apartmentNumber: row.apartment_number ?? null,
    invitedBy: asMemberId(row.invited_by),
    invitedByName: row.invited_by_name ?? null,
    channel: channelFromRow(row.channel),
    email: row.email,
    phone: row.phone,
    role: roleFromRow(row.role),
    status: statusFromRow(row.status),
    expiresAt: row.expires_at,
    openedAt: row.opened_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export function invitationPreviewFromRow(
  row: InvitationPreviewRow,
): InvitationPreview {
  return {
    id: asInvitationId(row.id),
    societyId: asSocietyId(row.society_id),
    societyName: row.society_name,
    role: roleFromRow(row.role),
    apartmentId:
      row.apartment_id === null ? null : asApartmentId(row.apartment_id),
    apartmentNumber: row.apartment_number,
    channel: channelFromRow(row.channel),
    // The database masked it; this is the one string the API must not recompute.
    inviteeHint: row.invitee_hint,
    requiresAccountMatch: row.requires_account_match,
    status: statusFromRow(row.status),
    expired: row.expired,
    expiresAt: row.expires_at,
  };
}

export function invitationAcceptanceFromRow(
  row: InvitationAcceptanceRow,
): InvitationAcceptance {
  return {
    societyId: asSocietyId(row.society_id),
    memberId: asMemberId(row.member_id),
    role: roleFromRow(row.role),
    apartmentId:
      row.apartment_id === null ? null : asApartmentId(row.apartment_id),
    linkedShadow: row.linked_shadow,
  };
}

/** The six roles, spelled here once because a row's value is a plain string. */
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
  return known.find((role) => role === value) ?? "guest";
}

/**
 * An unrecognised status becomes `revoked` — never `sent`.
 *
 * The closed direction, and the only one that is safe: treating a status this build does not know
 * as live would let it be accepted, and the database would agree (its CHECK has no such label
 * today, so the value can only come from a *newer* database than this build). Saying "revoked" is
 * wrong in a way the user can act on ("ask an Admin for a new invitation"); saying "sent" is wrong
 * in a way nobody notices.
 */
function statusFromRow(value: string): InvitationStatus {
  return (INVITATION_STATUSES as readonly string[]).includes(value)
    ? (value as InvitationStatus)
    : "revoked";
}

/** An unrecognised channel becomes `link`: the one that carries no address. */
function channelFromRow(value: string): InvitationChannel {
  return (INVITATION_CHANNELS as readonly string[]).includes(value)
    ? (value as InvitationChannel)
    : "link";
}

function unexpectedShapeError(what: string): InvitationError {
  return new InvitationError(
    "unknown",
    "Something went wrong. Please try again.",
    {
      hint: `Unexpected ${what} shape returned by the database.`,
    },
  );
}

export { unexpectedShapeError, roleToDatabase };

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The named exceptions the invitation migration raises.
 *
 * They travel as `P0001` with the name in the message, so they are matched **by name** — which is
 * why every one of them is listed here rather than inline: a new `RAISE EXCEPTION` in the SQL that
 * is missing from this list silently becomes `unknown`, and that is a 500 for a rule the user could
 * have been told about.
 */
export const RAISED_EXCEPTION = {
  invitationNotFound: "INVITATION_NOT_FOUND",
  invitationNotAcceptable: "INVITATION_NOT_ACCEPTABLE",
  invitationExpired: "INVITATION_EXPIRED",
  invitationRoleNotAssignable: "INVITATION_ROLE_NOT_ASSIGNABLE",
  invitationOpenLinkRole: "INVITATION_OPEN_LINK_ROLE",
  invitationRecipientAlreadyMember: "INVITATION_RECIPIENT_ALREADY_MEMBER",
  invitationRecipientMismatch: "INVITATION_RECIPIENT_MISMATCH",
  invitationAlreadyMember: "INVITATION_ALREADY_MEMBER",
  invitationMembershipRemoved: "INVITATION_MEMBERSHIP_REMOVED",
  invitationInviterRequired: "INVITATION_INVITER_REQUIRED",
  invitationTransitionForbidden: "INVITATION_TRANSITION_FORBIDDEN",
  invitationApartmentInvalid: "INVITATION_APARTMENT_INVALID",
  invitationAcceptDenied: "INVITATION_ACCEPT_DENIED",
} as const;

/** Constraint names worth a specific answer rather than "that conflicts with something". */
const CONSTRAINT = {
  liveEmail: "uq_invitations_live_email",
  livePhone: "uq_invitations_live_phone",
  tokenHash: "uq_invitations_token_hash",
  apartmentSociety: "fk_invitations_apartment_society",
} as const;

/**
 * Postgres failure → the module's error vocabulary.
 *
 * `context` matters for the same single case every module documents: `42501` covers both "your role
 * has no grant" and "RLS refused this row". On a **read** that is `not_found` (PRD T041 — a
 * non-member cannot tell a foreign society from a non-existent one); on a **write** the caller has
 * already passed the guard chain, so what RLS can be refusing is their *role*: `forbidden`.
 *
 * Postgres's `detail` is not copied into the error: it can carry the address or the number of the
 * person invited, and these objects travel toward the UI.
 */
export function invitationErrorFromPostgres(
  error: unknown,
  context: "read" | "write" | "accept",
): InvitationError {
  const candidate = asErrorLike(error);
  const code = candidate.code ?? "";
  const message = candidate.message ?? "";
  const hint = candidate.hint;
  const haystack = [
    message,
    candidate.detail,
    candidate.constraint,
    candidate.constraint_name,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ");

  const base: Record<string, unknown> = {
    code: candidate.code,
    ...(hint === undefined ? {} : { hint }),
  };

  switch (code) {
    case SQLSTATE.raised:
      return raisedError(message, hint, base);

    case SQLSTATE.notFound:
      return new InvitationError(
        "invitation_not_found",
        "That invitation link is not valid. Ask for a new one.",
        base,
      );

    case SQLSTATE.forbidden:
      return new InvitationError(
        "forbidden",
        hint ?? "Only a society Admin or Treasurer can manage invitations.",
        base,
      );

    case SQLSTATE.insufficientPrivilege:
      if (/permission denied for table/i.test(message)) {
        return new InvitationError(
          "forbidden",
          "Your session expired. Please sign in again.",
          base,
        );
      }
      if (context === "accept") {
        return new InvitationError(
          "invitation_accept_denied",
          "You cannot accept this invitation.",
          base,
        );
      }
      return context === "read"
        ? new InvitationError(
            "not_found",
            "That invitation is not available to you.",
            base,
          )
        : new InvitationError(
            "forbidden",
            "Only a society Admin or Treasurer can manage invitations.",
            base,
          );

    case SQLSTATE.uniqueViolation:
      if (/live_email/i.test(haystack)) {
        return new InvitationError(
          "conflict",
          "There is already an invitation waiting for that email address.",
          { ...base, field: "email" },
        );
      }
      if (/live_phone/i.test(haystack)) {
        return new InvitationError(
          "conflict",
          "There is already an invitation waiting for that phone number.",
          { ...base, field: "phone" },
        );
      }
      if (/token_hash/i.test(haystack)) {
        // A 256-bit collision is not the explanation: the honest reading is a token source that
        // handed out the same value twice.
        return new InvitationError(
          "unknown",
          "Something went wrong. Please try again.",
          {
            ...base,
            hint: "The invitation token collided with an existing row.",
          },
        );
      }
      return new InvitationError(
        "conflict",
        "That invitation conflicts with one that already exists.",
        base,
      );

    case SQLSTATE.checkViolation:
      if (/token_hash/i.test(haystack)) {
        return new InvitationError(
          "unknown",
          "Something went wrong. Please try again.",
          {
            ...base,
            hint: "The invitation token digest was not a sha256 hex digest.",
          },
        );
      }
      if (/recipient/i.test(haystack)) {
        return new InvitationError(
          "validation",
          "A targeted invitation needs an email address or a phone number.",
          { ...base, field: "channel" },
        );
      }
      return new InvitationError(
        "validation",
        "Please check the invitation details and try again.",
        base,
      );

    case SQLSTATE.foreignKeyViolation:
      if (/apartment/i.test(haystack)) {
        return new InvitationError(
          "invitation_apartment_invalid",
          "That flat is not available in this society.",
          { ...base, field: "apartmentId" },
        );
      }
      return new InvitationError(
        "not_found",
        "That society is not available to you.",
        base,
      );

    case SQLSTATE.undefinedTable:
      return new InvitationError(
        "unknown",
        "This part of the app is not available yet. Please try again later.",
        {
          ...base,
          hint: "The invitations table is missing. Apply supabase/migrations/20260926120000_invitations.sql.",
        },
      );

    default:
      break;
  }

  if (/row-level security|permission denied/i.test(message)) {
    if (context === "accept") {
      return new InvitationError(
        "invitation_accept_denied",
        "You cannot accept this invitation.",
        base,
      );
    }
    return context === "read"
      ? new InvitationError(
          "not_found",
          "That invitation is not available to you.",
          base,
        )
      : new InvitationError(
          "forbidden",
          "Only a society Admin or Treasurer can manage invitations.",
          base,
        );
  }

  return new InvitationError(
    "unknown",
    "Something went wrong. Please try again.",
    {
      code,
      ...(hint === undefined ? {} : { hint }),
    },
  );
}

/**
 * The named refusals, one case each — the migration's vocabulary, in the module's words.
 *
 * Every branch keeps the database's `HINT` when it has one, because that string was written for the
 * user ("Ask an Admin for a new one"), and falls back to a sentence of the same shape when the
 * raise had none. The `field` is attached where a form has something to highlight; a refusal with no
 * field renders as a banner, which is deliberate for the acceptance failures — they belong to a link,
 * not to an input.
 */
function raisedError(
  message: string,
  hint: string | undefined,
  base: Record<string, unknown>,
): InvitationError {
  const withField = (field: string): Record<string, unknown> => ({
    ...base,
    field,
  });

  if (message.includes(RAISED_EXCEPTION.invitationNotFound)) {
    return new InvitationError(
      "invitation_not_found",
      hint ?? "That invitation link is not valid. Ask for a new one.",
      base,
    );
  }
  if (message.includes(RAISED_EXCEPTION.invitationNotAcceptable)) {
    return new InvitationError(
      "invitation_not_acceptable",
      hint ?? "That invitation has already been accepted or revoked.",
      base,
    );
  }
  if (message.includes(RAISED_EXCEPTION.invitationExpired)) {
    return new InvitationError(
      "invitation_expired",
      hint ?? "That invitation has expired. Ask a society Admin for a new one.",
      base,
    );
  }
  if (message.includes(RAISED_EXCEPTION.invitationRoleNotAssignable)) {
    return new InvitationError(
      "invitation_role_not_assignable",
      hint ??
        "Only a society Admin can invite somebody at a role above Resident.",
      withField("role"),
    );
  }
  if (message.includes(RAISED_EXCEPTION.invitationOpenLinkRole)) {
    return new InvitationError(
      "invitation_open_link_role",
      hint ?? "A shareable link can only be created at the Resident role.",
      withField("role"),
    );
  }
  if (message.includes(RAISED_EXCEPTION.invitationRecipientAlreadyMember)) {
    return new InvitationError(
      "invitation_recipient_already_member",
      hint ?? "That person is already a member of this society.",
      base,
    );
  }
  if (message.includes(RAISED_EXCEPTION.invitationRecipientMismatch)) {
    return new InvitationError(
      "invitation_recipient_mismatch",
      hint ??
        "That invitation is for a different person. Sign in with the invited account.",
      base,
    );
  }
  if (message.includes(RAISED_EXCEPTION.invitationAlreadyMember)) {
    return new InvitationError(
      "invitation_already_member",
      hint ?? "You are already a member of this society.",
      base,
    );
  }
  if (message.includes(RAISED_EXCEPTION.invitationMembershipRemoved)) {
    return new InvitationError(
      "invitation_membership_removed",
      hint ?? "This membership was removed. Ask an admin to reinstate it.",
      base,
    );
  }
  if (message.includes(RAISED_EXCEPTION.invitationInviterRequired)) {
    return new InvitationError(
      "invitation_inviter_required",
      hint ?? "Only an active member of this society can invite somebody.",
      base,
    );
  }
  if (message.includes(RAISED_EXCEPTION.invitationTransitionForbidden)) {
    return new InvitationError(
      "invitation_not_acceptable",
      hint ?? "That invitation has already been accepted, revoked or expired.",
      base,
    );
  }
  if (message.includes(RAISED_EXCEPTION.invitationApartmentInvalid)) {
    return new InvitationError(
      "invitation_apartment_invalid",
      hint ?? "That flat is not available in this society.",
      withField("apartmentId"),
    );
  }
  if (message.includes(RAISED_EXCEPTION.invitationAcceptDenied)) {
    return new InvitationError(
      "invitation_accept_denied",
      hint ?? "Sign in as the invited account to accept an invitation.",
      base,
    );
  }
  return new InvitationError(
    "unknown",
    "Something went wrong. Please try again.",
    base,
  );
}

export { CONSTRAINT };
