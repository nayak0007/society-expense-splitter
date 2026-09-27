import {
  INVITATION_CHANNELS,
  INVITATION_STATUSES,
  INVITATION_TTL_DAYS,
  MEMBER_ROLES,
} from "@ses/domain";
import { z } from "zod";

/**
 * Invitation wire contract — Roadmap T047 (PRD §3.3, §7.2).
 *
 * ## The only place a token is sent, and the only direction it travels
 *
 * `createInvitationResponseSchema` carries `token`. That is deliberate and it is the whole
 * delivery design: the manager who created the invitation is the person who sends it — WhatsApp,
 * SMS, word of mouth — which is exactly what PRD §3.3 describes, and it needs no notification
 * infrastructure to work. Every **other** schema in this file is token-free: the list, the detail,
 * the preview and the acceptance response have no field a credential could arrive in, so a token
 * cannot leak through a normal response even by accident. Server-side sending is deferred to the
 * notifications phase (SAD §6) and recorded as such rather than half-built here.
 *
 * ## Vocabulary imported, never restated
 *
 * The statuses, channels and roles come from `@ses/domain`, for the reason `member.ts` records in
 * full: a second `z.enum([...])` is a second definition of one rule, and it fails asymmetrically —
 * a client accepts a value the server (or the database's CHECK) refuses.
 *
 * ## Request bodies are strict, responses are not
 *
 * SAD §7.8 stage 1, as everywhere: an unknown inbound key is a caller mistake worth naming, while
 * an added outbound field must not break a client that has not been rebuilt.
 */

/** PRD §7.2's five statuses. `expired` is derived server-side, and never written by a client. */
export const invitationStatusSchema = z.enum(INVITATION_STATUSES);
export type InvitationStatusDto = z.infer<typeof invitationStatusSchema>;

export const invitationChannelSchema = z.enum(INVITATION_CHANNELS);
export type InvitationChannelDto = z.infer<typeof invitationChannelSchema>;

/** The role vocabulary, shared with the members module — one enum, one matrix behind it. */
export const invitationRoleSchema = z.enum(MEMBER_ROLES);

/**
 * E.164, the same shape `profiles` and `members` are held to.
 *
 * Restated as a regex rather than imported because the domain's phone value object is a *member*
 * module concern (it strips formatting for the directory's search); this is the wire's check on a
 * number that will be stored verbatim, and the database's own CHECK is the authority for both.
 */
const phoneSchema = z
  .string()
  .regex(
    /^\+[1-9][0-9]{7,14}$/,
    "Use an international number, e.g. +919800000901",
  );

/**
 * One invitation as the management screens read it.
 *
 * `expired` and `inviteeHint` are **derived**, and they travel rather than being recomputed on the
 * client: `expired` is `status` folded with `expiresAt` against the server's clock (a client whose
 * clock is wrong would hide a live invitation or offer a dead one), and `inviteeHint` is the same
 * mask the preview shows, so the manager sees what the recipient will see.
 */
export const invitationSummarySchema = z.object({
  id: z.string(),
  channel: invitationChannelSchema,
  /** Exactly one of these is present for a targeted invitation; both are `null` for a link. */
  email: z.string().nullable(),
  phone: z.string().nullable(),
  inviteeHint: z.string(),
  role: invitationRoleSchema,
  status: invitationStatusSchema,
  /** `status` with expiry folded in — "sent, and overdue" is two different facts. */
  expired: z.boolean(),
  apartmentId: z.string().nullable(),
  apartmentNumber: z.string().nullable(),
  /** The membership that issued it, and their name as the list renders it. */
  invitedBy: z.string(),
  invitedByName: z.string().nullable(),
  expiresAt: z.string(),
  openedAt: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type InvitationSummaryDto = z.infer<typeof invitationSummarySchema>;

/** `GET /invitations` — one page, plus the total the filter produced. */
export const invitationListResponseSchema = z.object({
  invitations: z.array(invitationSummarySchema),
  total: z.number().int(),
});
export type InvitationListResponseDto = z.infer<
  typeof invitationListResponseSchema
>;

/**
 * The list query.
 *
 * No search box: a society's live invitations are a handful, and a name search over an address the
 * manager may not be allowed to read in full would be a search that cannot be honest about its own
 * results. Filtering by status is what the screen actually offers — "show me the ones that were
 * opened and never accepted", which is the follow-up that matters.
 */
export const invitationListQuerySchema = z.object({
  status: invitationStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
export type InvitationListQuery = z.infer<typeof invitationListQuerySchema>;

/**
 * The create body — `POST /invitations`.
 *
 * Four rules the database also enforces, stated here so the caller is told which field is wrong
 * rather than getting a 409 from a trigger:
 *
 *  1. a targeted channel (everything but `link`) needs an address — the table's
 *     `chk_invitations_recipient`;
 *  2. a link may not carry one *and* be a link (it is shareable precisely because it is
 *     unaddressed), so the two are mutually exclusive rather than merely optional;
 *  3. an unaddressed link may only be created at `resident` — checked in the domain
 *     (`checkOpenLinkInvite`), because it is a rule about roles, not about fields;
 *  4. `role` defaults to `resident`; a caller that may not choose a role never sends one, and one
 *     that may gets the default when they do not.
 */
export const createInvitationSchema = z
  .strictObject({
    channel: invitationChannelSchema,
    role: invitationRoleSchema.optional(),
    email: z.email().max(254).optional(),
    phone: phoneSchema.optional(),
    apartmentId: z.uuid().optional(),
  })
  .refine(
    (value) =>
      value.channel === "link"
        ? value.email === undefined && value.phone === undefined
        : value.email !== undefined || value.phone !== undefined,
    {
      message:
        "A targeted invitation needs an email address or a phone number; a shareable link must have neither.",
      path: ["channel"],
    },
  );
export type CreateInvitationPayload = z.infer<typeof createInvitationSchema>;

/**
 * The response to a create — the invitation, **and the token, once**.
 *
 * This is the only response in the module that carries a credential, and it goes to the caller who
 * created it: the person who must deliver it. Nothing stores or logs it (the row keeps only the
 * sha256 digest, and it is in no SELECT grant), so a manager who loses the link revokes the
 * invitation and creates another — which is a better answer than a stored secret that can be read
 * back.
 */
export const createInvitationResponseSchema = z.object({
  invitation: invitationSummarySchema,
  /** The bearer credential. Present here and nowhere else — treat it as a password. */
  token: z.string(),
  /**
   * The path a client should link to, without a scheme or host: `/invite/<token>`. Supplied by the
   * server so the two clients (mobile, and the browser that will follow) cannot disagree about
   * where an invitation link points.
   */
  path: z.string(),
  expiresInDays: z.number().int().positive(),
});
export type CreateInvitationResponseDto = z.infer<
  typeof createInvitationResponseSchema
>;

/**
 * The public preview — `GET /invitations/preview/:token`.
 *
 * Masked, and masked by the server: `inviteeHint` is enough for the recipient to recognise their
 * own invitation and not enough for anybody else to harvest an address from a link they were
 * forwarded. No identity is required to reach this, which is why nothing here comes from a row's
 * private columns — the projection is `invitation_preview()`'s own.
 */
export const invitationPreviewResponseSchema = z.object({
  id: z.string(),
  societyId: z.string(),
  societyName: z.string(),
  role: invitationRoleSchema,
  apartmentId: z.string().nullable(),
  apartmentNumber: z.string().nullable(),
  channel: invitationChannelSchema,
  inviteeHint: z.string(),
  requiresAccountMatch: z.boolean(),
  /** `expired` folded in: this is the status the recipient's screen explains. */
  status: invitationStatusSchema,
  expired: z.boolean(),
  expiresAt: z.string(),
});
export type InvitationPreviewResponseDto = z.infer<
  typeof invitationPreviewResponseSchema
>;

/**
 * The acceptance response — the membership that now exists.
 *
 * A membership id and a role, not a token or a session: accepting is not a sign-in, and the caller
 * is already authenticated (the route requires a verified actor). `linkedShadow` says whether an
 * occupant the Admin had already recorded was linked, which is the fact the manager who invited
 * them most wants to see confirmed. The client follows this with the ordinary society reads — the
 * membership it just gained is what makes them answer.
 */
export const acceptInvitationResponseSchema = z.object({
  societyId: z.string(),
  memberId: z.string(),
  role: invitationRoleSchema,
  apartmentId: z.string().nullable(),
  linkedShadow: z.boolean(),
});
export type AcceptInvitationResponseDto = z.infer<
  typeof acceptInvitationResponseSchema
>;

/** `POST /invitations/:invitationId/revoke` — the invitation, now terminal. */
export const revokeInvitationResponseSchema = invitationSummarySchema;
export type RevokeInvitationResponseDto = z.infer<
  typeof revokeInvitationResponseSchema
>;

/**
 * A token as it arrives in a URL — base64url, bounded.
 *
 * Checked at the edge because a *malformed* token is a client bug (`400`, and the field is named)
 * while a well-formed token that matches no row is an ordinary `404`. Without the shape check,
 * every mistyped link would be reported as "no such invitation", which is true but useless to the
 * person holding it.
 */
export const invitationTokenSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Use the token exactly as it appears in the link");

/** The link's own path shape, so a client can build and parse it in one place. */
export const INVITATION_LINK_PREFIX = "/invite/";
export const INVITATION_EXPIRY_DAYS = INVITATION_TTL_DAYS;
