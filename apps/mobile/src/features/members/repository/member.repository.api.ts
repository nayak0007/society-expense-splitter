import {
  approveJoinRequestSchema,
  assignRoleResponseSchema,
  joinRequestListResponseSchema,
  joinRequestResponseSchema,
  memberDetailResponseSchema,
  memberListResponseSchema,
  memberResponseSchema,
  rejectJoinRequestSchema,
} from '@ses/contracts';
import type { JoinRequestDto, MemberDto } from '@ses/contracts';
import { asApartmentId, asBuildingId, asMemberId, MemberError } from '@ses/domain';
import type {
  CreateMemberInput,
  JoinApprovalInput,
  JoinRequest,
  JoinRequestPage,
  JoinRequestQuery,
  Member,
  MemberActivation,
  MemberId,
  MemberPage,
  MemberQuery,
  MemberRepository,
  MemberRole,
  SocietyId,
  UpdateMemberInput,
  UserId,
} from '@ses/domain';

import { apiRequest, isApiError } from '@/lib/api/api-client';
import type { ApiError } from '@/lib/api/api-client';

/**
 * `MemberRepository` implemented over the Resident 360 API.
 *
 * ## The society is a header, the actor is the token
 *
 * Same as `ApiBuildingRepository` and `ApiSocietyRepository`: every call sends
 * `X-Society-Id` — never a path parameter *and* a header, which would give the request
 * two ways to say where it acts — and `actor` is never sent, because over HTTP the actor
 * *is* the JWT that the API verifies. Forwarding an id would be redundant and strictly
 * weaker.
 *
 * ## `findViewer` and `findLiveShadowByPhone` are reads, not local guesses
 *
 * Two of the port's methods have no obvious REST verb, and both are answered with real
 * reads rather than by inventing a value, because the use cases that call them decide
 * things with the answer:
 *
 *  - **`findViewer`** is `GET /members/me`, added for exactly this purpose. It is the one
 *    row a roster cannot point at, and every member use case loads it first. The
 *    alternative — reading the society store's membership snapshot — would have to
 *    fabricate a `Member` out of four of its fields, which is how a *suspended* member
 *    ends up looking active to the very capability check that exists to tell them apart.
 *  - **`findLiveShadowByPhone`** searches the directory for the normalised number (the API
 *    matches a phone by its digits) and keeps the live shadow rows. It is a **pre-check**,
 *    not the enforcement: `uq_members_shadow_phone` is what makes a duplicate impossible,
 *    and the API classifies that violation into the same typed `conflict` on `phone`. This
 *    version exists so the common case is reported under the input the user is looking at,
 *    instead of after a failed create.
 *
 * ## What is *not* sent
 *
 * `role` and `status` are absent from both bodies, which the contract enforces with
 * `.strict()`: a role is T046's operation and a status is the suspend/reactivate pair
 * below. A field the API refuses is better than one it accepts and ignores.
 */

/**
 * `MemberDto` → the port's `Member`.
 *
 * `contactVisible` is **dropped**, deliberately: it is not a property of the member but of
 * the *viewer*, and the domain derives it in `toMemberView(viewer, member)` — inside the
 * use cases, from the same rule the API applied. Carrying the server's copy into the entity
 * would give the app two answers to "may I see this", sourced from two places.
 */
function memberFromDto(dto: MemberDto): Member {
  return {
    id: asMemberId(dto.id),
    societyId: dto.societyId as SocietyId,
    userId: dto.userId === null ? null : (dto.userId as UserId),
    apartmentId: dto.apartmentId === null ? null : asApartmentId(dto.apartmentId),
    apartment:
      dto.apartment === null
        ? null
        : {
            id: asApartmentId(dto.apartment.id),
            number: dto.apartment.number,
            buildingId: asBuildingId(dto.apartment.buildingId),
            buildingName: dto.apartment.buildingName,
            floor: dto.apartment.floor,
          },
    displayName: dto.displayName,
    phone: dto.phone,
    email: dto.email,
    role: dto.role,
    status: dto.status,
    occupancy: dto.occupancy,
    isPrimary: dto.isPrimary,
    leaseStart: dto.leaseStart,
    leaseEnd: dto.leaseEnd,
    shareContact: dto.shareContact,
    joinedAt: dto.joinedAt,
    approvedBy: dto.approvedBy === null ? null : asMemberId(dto.approvedBy),
    removedAt: dto.removedAt,
    removedBy: dto.removedBy === null ? null : asMemberId(dto.removedBy),
    requestNote: dto.requestNote,
    rejectionReason: dto.rejectionReason,
    rejectedAt: dto.rejectedAt,
    rejectedBy: dto.rejectedBy === null ? null : asMemberId(dto.rejectedBy),
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
  };
}

/** One queue row: the request, plus everybody else claiming its flat (T049). */
function joinRequestFromDto(dto: JoinRequestDto): JoinRequest {
  return {
    member: memberFromDto(dto.member),
    claims: dto.claims.map((claim) => memberFromDto(claim)),
  };
}

/** The `{ field }` detail, or nothing at all when the server named no field. */
function fieldDetails(error: ApiError): { readonly field?: string } {
  const field = error.field ?? error.details?.[0]?.field;
  return field === undefined ? {} : { field };
}

/**
 * API error catalogue → the member module's vocabulary (SAD §7.10).
 *
 * Narrowing rather than guessing, exactly as the structure adapter does. The cases worth
 * reading twice:
 *
 *  - `VALIDATION_ERROR` keeps the offending field, so a bad phone number arrives attached to
 *    the phone input rather than as a banner.
 *  - `CONFLICT` does too: a duplicate shadow phone is reported by the API with
 *    `field: "phone"`, and a duplicate *primary occupant* names the flat.
 *  - `SOCIETY_ADMIN_REQUIRED` (the database trigger that refuses to leave a society without
 *    an admin) becomes `sole_admin`, which is what the domain's own vocabulary calls it — so
 *    a screen can explain it without matching on a transport code.
 *  - `MEMBER_INACTIVE` is the guard's answer for a membership that is not active: `forbidden`,
 *    with the server's sentence, which says *why*.
 */
function mapError(error: unknown): MemberError {
  if (!isApiError(error)) {
    return error instanceof MemberError
      ? error
      : new MemberError('unknown', 'The member operation failed unexpectedly.');
  }

  switch (error.code) {
    case 'NOT_FOUND':
      return new MemberError('not_found', 'That member is not available to you.', {
        requestId: error.requestId,
      });

    case 'FORBIDDEN':
    case 'MEMBER_INACTIVE': {
      // T049's two 403s carry their own detail codes, so a queue screen can say *why* instead of
      // showing one sentence for "your role", "your own request" and "that role is above you".
      if (error.details?.some((detail) => detail.code === 'SELF_REVIEW') === true) {
        return new MemberError('self_review', error.message, {
          requestId: error.requestId,
        });
      }
      if (error.details?.some((detail) => detail.code === 'ROLE_NOT_ASSIGNABLE') === true) {
        return new MemberError('role_not_assignable', error.message, {
          ...fieldDetails(error),
          requestId: error.requestId,
        });
      }
      return new MemberError('forbidden', error.message, {
        requestId: error.requestId,
      });
    }

    case 'VALIDATION_ERROR':
    case 'SOCIETY_REQUIRED':
    case 'SOCIETY_INVALID':
      return new MemberError('validation', error.message, {
        ...fieldDetails(error),
        requestId: error.requestId,
      });

    case 'CONFLICT':
    case 'DUPLICATE_RESOURCE':
    case 'VERSION_MISMATCH': {
      // One conflict has its own domain code, and it is T046's: PRD §2.2's caps. The server marks
      // it with a `ROLE_CAP_EXCEEDED` detail code so a picker can say "at most 2 treasurers" —
      // the sentence that tells the user what to do — rather than the generic "that value is
      // taken", which reads as a bug beside a dropdown of roles.
      if (error.details?.some((detail) => detail.code === 'ROLE_CAP_EXCEEDED') === true) {
        return new MemberError('role_cap_exceeded', error.message, {
          ...fieldDetails(error),
          requestId: error.requestId,
        });
      }
      // T049: the request was decided by somebody else (or by this caller a moment ago). Its own
      // code, because the screen's answer is to refetch the queue rather than to correct a field.
      if (error.details?.some((detail) => detail.code === 'JOIN_REQUEST_NOT_PENDING') === true) {
        return new MemberError('join_request_not_pending', error.message, {
          requestId: error.requestId,
        });
      }
      return new MemberError('conflict', error.message, {
        ...fieldDetails(error),
        requestId: error.requestId,
      });
    }

    case 'SOCIETY_ADMIN_REQUIRED':
      return new MemberError('sole_admin', error.message, {
        requestId: error.requestId,
      });

    default:
      // UNAUTHENTICATED and TOKEN_EXPIRED land here on purpose: they are not this layer's
      // decision. The client already replayed once after a silent refresh, and a session
      // still refused has been cleared by supabase-js, which routes to sign-in.
      return new MemberError('unknown', error.message, {
        code: error.code,
        requestId: error.requestId,
      });
  }
}

/**
 * The directory query as a query string.
 *
 * `undefined` fields are omitted rather than sent empty: `status=` is a value the contract
 * refuses (it is not in the enum), so omitting is what makes "no filter" mean no filter.
 * Every value is encoded — a search term is free text, and a `&` in it would otherwise end
 * the parameter and silently change what was asked for.
 */
function directoryPath(query: MemberQuery): string {
  const parameters: [string, string][] = [];

  if (query.role !== undefined) parameters.push(['role', query.role]);
  if (query.status !== undefined) parameters.push(['status', query.status]);
  if (query.occupancy !== undefined) parameters.push(['occupancy', query.occupancy]);
  if (query.buildingId !== undefined) parameters.push(['buildingId', query.buildingId]);
  if (query.apartmentId !== undefined) parameters.push(['apartmentId', query.apartmentId]);
  if (query.query !== undefined && query.query.trim().length > 0) {
    parameters.push(['q', query.query.trim()]);
  }
  if (query.sort !== undefined) parameters.push(['sort', query.sort]);
  if (query.limit !== undefined) parameters.push(['limit', String(query.limit)]);
  if (query.offset !== undefined) parameters.push(['offset', String(query.offset)]);

  const search = parameters.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');

  return search.length === 0 ? 'members' : `members?${search}`;
}

/**
 * Only the keys the contract accepts — it is `.strict()`, so an extra key is a `400`.
 *
 * `undefined` is dropped rather than sent as `null`: on the create path the contract makes
 * every optional field `.optional()` (and `null` is refused), and on the update path
 * `undefined` already means "leave unchanged" while `null` means "clear" — so a patch
 * assembled from a partly-filled form cannot clear a field the user never touched.
 */
function body<TInput extends object>(
  input: TInput,
  fields: readonly (keyof TInput)[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of fields) {
    const value = input[field];
    if (value !== undefined) payload[String(field)] = value;
  }
  return payload;
}

const CREATE_FIELDS = [
  'displayName',
  'phone',
  'email',
  'occupancy',
  'apartmentId',
  'isPrimary',
  'leaseStart',
  'leaseEnd',
  'shareContact',
] as const satisfies readonly (keyof CreateMemberInput)[];

/** The approval's own fields, in the order the contract declares them. */
const APPROVAL_FIELDS = [
  'role',
  'occupancy',
  'apartmentId',
  'isPrimary',
] as const satisfies readonly (keyof JoinApprovalInput)[];

const UPDATE_FIELDS = [
  'displayName',
  'phone',
  'email',
  'occupancy',
  'apartmentId',
  'isPrimary',
  'leaseStart',
  'leaseEnd',
  'shareContact',
] as const satisfies readonly (keyof UpdateMemberInput)[];

/** A phone reduced to its digits, which is how the API's search matches one. */
function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

export class ApiMemberRepository implements MemberRepository {
  async list(societyId: SocietyId, _actor: UserId, query: MemberQuery): Promise<MemberPage> {
    try {
      const response = await apiRequest('GET', directoryPath(query), {
        schema: memberListResponseSchema,
        societyId,
      });
      return {
        members: response.members.map((member) => memberFromDto(member)),
        total: response.total,
      };
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  /** `null`, not a throw, for a member the caller may not see. */
  async findById(id: MemberId, societyId: SocietyId, _actor: UserId): Promise<Member | null> {
    try {
      const { member } = await apiRequest('GET', `members/${id}`, {
        schema: memberDetailResponseSchema,
        societyId,
      });
      return memberFromDto(member);
    } catch (error: unknown) {
      // The port asks for "absent" and the caller renders an empty state; a removed or
      // foreign member is an ordinary answer, not a failure.
      if (isApiError(error) && error.code === 'NOT_FOUND') return null;
      throw mapError(error);
    }
  }

  /**
   * The caller's own membership — the one read addressed by the token rather than by an id.
   *
   * `null` is *no live membership*: the API answers `404` for a caller outside the society
   * and for one who has been removed, which the use cases turn into the same
   * "not available to you". A refused (`403`) membership is **not** folded into `null`: a
   * suspended member is a member, and the sentence that says so is the point of the
   * distinction, so it propagates.
   */
  async findViewer(societyId: SocietyId, _actor: UserId): Promise<Member | null> {
    try {
      const { member } = await apiRequest('GET', 'members/me', {
        schema: memberDetailResponseSchema,
        societyId,
      });
      return memberFromDto(member);
    } catch (error: unknown) {
      if (isApiError(error) && error.code === 'NOT_FOUND') return null;
      throw mapError(error);
    }
  }

  /**
   * A live shadow member holding this number, or `null`.
   *
   * The port is explicit that this is a *pre-check* — the unique index is the rule — and
   * this implementation is honest about being one: it asks the directory for the digits of
   * the number and matches the rows it gets back exactly. `exceptId` is what lets the edit
   * path ask about a number it is keeping.
   */
  async findLiveShadowByPhone(
    societyId: SocietyId,
    phone: string,
    actor: UserId,
    exceptId?: MemberId,
  ): Promise<Member | null> {
    const digits = digitsOf(phone);
    if (digits.length === 0) return null;

    const page = await this.list(societyId, actor, { query: digits });
    return (
      page.members.find(
        (member) =>
          member.userId === null &&
          member.status !== 'removed' &&
          member.phone !== null &&
          digitsOf(member.phone) === digits &&
          member.id !== exceptId,
      ) ?? null
    );
  }

  /** Record a shadow member. The role and status are the server's to choose. */
  async create(societyId: SocietyId, input: CreateMemberInput, _actor: UserId): Promise<Member> {
    try {
      const { member } = await apiRequest('POST', 'members', {
        body: body(input, CREATE_FIELDS),
        schema: memberResponseSchema,
        societyId,
      });
      return memberFromDto(member);
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  async update(
    id: MemberId,
    societyId: SocietyId,
    input: UpdateMemberInput,
    _actor: UserId,
  ): Promise<Member> {
    try {
      const { member } = await apiRequest('PATCH', `members/${id}`, {
        body: body(input, UPDATE_FIELDS),
        schema: memberResponseSchema,
        societyId,
      });
      return memberFromDto(member);
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  /**
   * Suspend or reactivate — its own routes, not a status patch.
   *
   * That is the API's shape rather than a convenience: approval and rejection are the join
   * queue's transitions (T049) and removal is `remove`, so neither can be expressed by
   * reaching for this method.
   */
  async setStatus(
    id: MemberId,
    societyId: SocietyId,
    status: MemberActivation,
    _actor: UserId,
  ): Promise<Member> {
    const action = status === 'active' ? 'reactivate' : 'suspend';
    try {
      const { member } = await apiRequest('POST', `members/${id}/${action}`, {
        schema: memberResponseSchema,
        societyId,
      });
      return memberFromDto(member);
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  /**
   * Set a membership's role (T046).
   *
   * ## Two round trips, and why that is the honest implementation
   *
   * The wire's answer to a role write is the membership's **permissions** (`PATCH
   * /members/:id/role` → role, action list, capabilities — see `@ses/contracts/permissions.ts`),
   * while the port promises the updated **row**. The adapter therefore reads the row back instead
   * of fabricating it: merging a permissions response into a member would invent `updatedAt`,
   * `status` and every other field, and a screen would render a row no server ever returned.
   *
   * The order matters and is deliberate — the write is awaited first, so a cap refusal or a
   * self-change refusal surfaces as itself rather than as whatever the read would have said. The
   * extra read only happens after a write that succeeded.
   */
  async setRole(
    id: MemberId,
    societyId: SocietyId,
    role: MemberRole,
    actor: UserId,
  ): Promise<Member> {
    try {
      await apiRequest('PATCH', `members/${id}/role`, {
        body: { role },
        schema: assignRoleResponseSchema,
        societyId,
      });
    } catch (error: unknown) {
      throw mapError(error);
    }

    const updated = await this.findById(id, societyId, actor);
    if (updated === null) {
      throw new MemberError('not_found', 'That member is not available to you.');
    }
    return updated;
  }

  /**
   * Active holders of a role, excluding one row — the count PRD §2.2's caps are made of.
   *
   * There is no count endpoint, and there should not be one for two roles' worth of arithmetic:
   * the directory read already computes the total the filters produced, so this is
   * `list({ role, status: 'active' })`'s `total`, minus the row being written when that row is
   * itself an active holder.
   *
   * The subtraction is a read of the target rather than a guess, because the port's contract is a
   * count: `exceptId` is excluded whether or not it holds the role, and assuming it does would
   * undercount the moment a first appointment is made.
   *
   * This is a **pre-check** for a good error message, not the enforcement: the API counts the same
   * rows and `chk_role_caps()` counts them again under the write, so a stale answer here becomes a
   * `409 ROLE_CAP_EXCEEDED` rather than an over-cap role.
   */
  async countActiveByRole(
    societyId: SocietyId,
    role: MemberRole,
    actor: UserId,
    exceptId?: MemberId,
  ): Promise<number> {
    const page = await this.list(societyId, actor, {
      role,
      status: 'active',
      limit: 1,
    });
    if (exceptId === undefined) return page.total;

    const excluded = await this.findById(exceptId, societyId, actor);
    const isActiveHolder =
      excluded !== null && excluded.role === role && excluded.status === 'active';
    return isActiveHolder ? Math.max(0, page.total - 1) : page.total;
  }

  // ── the join queue (T049) ───────────────────────────────────────────────────

  /**
   * One page of the society's pending requests.
   *
   * The claims are *not* recomputed locally, deliberately: the server resolves them in the same
   * statement as the page, and a client that matched flats out of the pages it happened to hold
   * would show a collision only when both rows were in the same page — which is the bug the
   * field exists to prevent.
   */
  async listJoinRequests(
    societyId: SocietyId,
    _actor: UserId,
    query: JoinRequestQuery,
  ): Promise<JoinRequestPage> {
    const parameters: [string, string][] = [];
    if (query.limit !== undefined) parameters.push(['limit', String(query.limit)]);
    if (query.offset !== undefined) parameters.push(['offset', String(query.offset)]);
    const search = parameters.map(([key, value]) => `${key}=${value}`).join('&');

    try {
      const response = await apiRequest(
        'GET',
        search.length === 0 ? 'members/join-requests' : `members/join-requests?${search}`,
        { schema: joinRequestListResponseSchema, societyId },
      );
      return {
        requests: response.requests.map((request) => joinRequestFromDto(request)),
        total: response.total,
      };
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  /**
   * Admit a pending member.
   *
   * Only the fields the approver actually set travel — the contract is `.strict()` and the API
   * treats an absent field as "as requested", so sending defaults would overwrite the
   * requester's own declaration with the client's guess.
   */
  async approveJoinRequest(
    id: MemberId,
    societyId: SocietyId,
    input: JoinApprovalInput,
    _actor: UserId,
  ): Promise<Member> {
    try {
      const { member } = await apiRequest('POST', `members/join-requests/${id}/approve`, {
        body: approveJoinRequestSchema.parse(body(input, APPROVAL_FIELDS)),
        schema: joinRequestResponseSchema,
        societyId,
      });
      return memberFromDto(member);
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  /** Refuse a pending member, with the reason the requester is shown. */
  async rejectJoinRequest(
    id: MemberId,
    societyId: SocietyId,
    reason: string,
    _actor: UserId,
  ): Promise<Member> {
    try {
      const { member } = await apiRequest('POST', `members/join-requests/${id}/reject`, {
        body: rejectJoinRequestSchema.parse({ reason }),
        schema: joinRequestResponseSchema,
        societyId,
      });
      return memberFromDto(member);
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  /** Soft removal server-side: the row, its flat assignment and its history survive. */
  async remove(id: MemberId, societyId: SocietyId, _actor: UserId): Promise<void> {
    try {
      await apiRequest('DELETE', `members/${id}`, { societyId });
    } catch (error: unknown) {
      throw mapError(error);
    }
  }
}
