import {
  createdSocietyResponseSchema,
  joinOptionsResponseSchema,
  joinPreviewResponseSchema,
  membershipListResponseSchema,
  membershipResponseSchema,
  societyProfileResponseSchema,
  societyResponseSchema,
} from '@ses/contracts';
import type { MembershipDto, SocietyDto } from '@ses/contracts';
import {
  asApartmentId,
  asBuildingId,
  asMemberId,
  asSocietyId,
  asSocietyError,
  asUserId,
  JOIN_CODE_PATTERN,
  normalizeJoinCode,
  paise,
  SocietyError,
} from '@ses/domain';
import type {
  CreateSocietyInput,
  JoinSocietyInput,
  Society,
  SocietyJoinOptions,
  SocietyJoinPreview,
  SocietyMembership,
  SocietyRepository,
  UpdateSocietyInput,
  UserId,
} from '@ses/domain';

import { apiRequest, isApiError } from '@/lib/api/api-client';

/**
 * `SocietyRepository` implemented over the Resident 360 API — the end state the port was
 * written for.
 *
 * ## Why this replaced the direct-Supabase adapter
 *
 * The previous adapter spoke PostgREST: it read `public.members` and called the
 * `society_*` SQL functions with the anon key. That worked, and RLS made it safe,
 * but it put the rules in two places that had to agree — the SQL functions and
 * the API's own copies — and it meant every table change was an app release. This
 * adapter sends HTTP and nothing else: the API owns the rules, RLS still enforces
 * them underneath, and the client is one of two consumers of the same use cases
 * (`@ses/application`) rather than a second implementation of them.
 *
 * ## The `actor` argument is not sent
 *
 * The port takes `actor` so scope can never come from ambient state, and this
 * adapter is the clearest case for why it is not forwarded: over HTTP the actor
 * *is* the JWT. The API reads `sub` from the verified token, so a client-supplied
 * id would be both redundant and weaker — anything it said, the token already
 * says better. Passing it would also mean a request could disagree with itself.
 *
 * ## Errors
 *
 * The API answers in the SAD §7.10 catalogue, which is a *superset* of the
 * domain's vocabulary, so `mapError` narrows rather than guesses: `NOT_FOUND`
 * becomes `not_found`, `SOCIETY_ADMIN_REQUIRED` becomes `sole_admin`, and a
 * `CONFLICT` means different things on `join` (already a member) than on `create`
 * (a duplicate name) — which is why it takes the operation as an argument.
 */

const MEMBERSHIPS_PATH = 'societies/memberships';

/** The port's `Society` is the API's `societySchema` plus branded ids. */
function societyFromDto(dto: SocietyDto): Society {
  return {
    id: asSocietyId(dto.id),
    name: dto.name,
    slug: dto.slug,
    type: dto.type,
    registrationNumber: dto.registrationNumber,
    addressLine1: dto.addressLine1,
    addressLine2: dto.addressLine2,
    city: dto.city,
    state: dto.state,
    pincode: dto.pincode,
    country: dto.country,
    currency: dto.currency,
    timezone: dto.timezone,
    joinCode: dto.joinCode,
    joinCodeExpiresAt: dto.joinCodeExpiresAt,
    plan: dto.plan,
    createdBy: asUserId(dto.createdBy),
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    deletedAt: dto.deletedAt,
    // The wire carries money as a JSON integer (there is no bigint in JSON) and
    // the domain holds it as `bigint` paise (ADR-0005), so the DTO→domain step is
    // where the two meet. One field today; the money fields Phase 4 adds cross
    // the same way.
    settings: {
      ...dto.settings,
      approvalThresholdPaise: paise(dto.settings.approvalThresholdPaise),
    },
    memberCount: dto.memberCount,
  };
}

function membershipFromDto(dto: MembershipDto): SocietyMembership {
  return {
    id: asMemberId(dto.id),
    societyId: asSocietyId(dto.societyId),
    userId: asUserId(dto.userId),
    role: dto.role,
    status: dto.status,
    occupancyType: dto.occupancyType,
    joinedAt: dto.joinedAt,
  };
}

/** The operation, where it changes what a status means. */
type Operation = 'read' | 'write' | 'join' | 'create';

function mapError(error: unknown, operation: Operation): SocietyError {
  if (!isApiError(error)) return asSocietyError(error);

  switch (error.code) {
    case 'NOT_FOUND':
      // PRD T041: a non-member must not be able to tell a foreign society from a
      // non-existent one, so the API and this mapping both answer `not_found`.
      return new SocietyError('not_found', 'That society is not available to you.', {
        requestId: error.requestId,
      });

    case 'FORBIDDEN':
      return new SocietyError('forbidden', 'Only a society Admin can change society details.', {
        requestId: error.requestId,
      });

    case 'SOCIETY_ADMIN_REQUIRED':
      return new SocietyError(
        'sole_admin',
        'A society must always have an active Admin. Make someone else an Admin first.',
        { requestId: error.requestId },
      );

    case 'VALIDATION_ERROR':
      return new SocietyError('validation', error.message, {
        field: error.details?.[0]?.field,
        requestId: error.requestId,
      });

    case 'CONFLICT':
    case 'DUPLICATE_RESOURCE':
    case 'VERSION_MISMATCH':
      return operation === 'join'
        ? new SocietyError('already_member', 'You are already a member of this society.', {
            requestId: error.requestId,
          })
        : new SocietyError('conflict', error.message, { requestId: error.requestId });

    default:
      // UNAUTHENTICATED, TOKEN_EXPIRED and DEPENDENCY_UNAVAILABLE land here. The
      // first two are not this layer's decision: the client already replayed once
      // after a silent refresh, and a session that is still refused has been
      // cleared by supabase-js, which routes to sign-in through
      // `onAuthStateChange`. Inventing a code here would be a second, worse
      // answer to a question the auth store already answers.
      return new SocietyError('unknown', error.message, {
        code: error.code,
        requestId: error.requestId,
      });
  }
}

/** Only the keys `createSocietySchema` accepts — it is strict. */
const CREATE_FIELDS = [
  'name',
  'type',
  'registrationNumber',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'pincode',
  'billingDay',
  'dueDay',
  'approvalThresholdPaise',
] as const;

/** `createSocietySchema.partial()` plus the settings the update route accepts. */
const UPDATE_FIELDS = [
  ...CREATE_FIELDS,
  'graceDays',
  'billVacantFlats',
  'allowPartialPayments',
  'defaulterListPublic',
  'financialYearStartMonth',
  'timezone',
] as const;

/**
 * Copies only the fields the contract allows, and only those the caller set.
 *
 * Sending `undefined` explicitly would be dropped by `JSON.stringify` anyway, but
 * a key mapped from `Partial<>` still has to be filtered before that: the update
 * schema rejects an empty patch ("Nothing to update"), so an all-undefined body
 * assembled from a mostly-empty input would answer 422 for a request the caller
 * believed was valid. The strict schemas also mean an extra key is a 400, so this
 * cannot be a spread.
 */
function pickDefined<T extends object>(
  input: T,
  fields: readonly (keyof T)[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    const value = input[field];
    if (value !== undefined) body[String(field)] = value;
  }
  return body;
}

export class ApiSocietyRepository implements SocietyRepository {
  // ── read ─────────────────────────────────────────────────────────────────────

  /** The caller's own memberships, newest first. */
  async listMemberships(_actor: UserId): Promise<readonly SocietyMembership[]> {
    try {
      const { memberships } = await apiRequest('GET', MEMBERSHIPS_PATH, {
        schema: membershipListResponseSchema,
      });
      return memberships.map((membership) => membershipFromDto(membership));
    } catch (error: unknown) {
      throw mapError(error, 'read');
    }
  }

  /**
   * The society's roster.
   *
   * A non-member gets `not_found` — never an empty array, which would confirm the
   * id is real (PRD T041). The API decides that, and the port's contract is that
   * this method throws; there is no empty-list branch here to accidentally take.
   */
  async listSocietyMemberships(
    societyId: string,
    _actor: UserId,
  ): Promise<readonly SocietyMembership[]> {
    try {
      const { memberships } = await apiRequest('GET', `societies/${societyId}/members`, {
        schema: membershipListResponseSchema,
      });
      return memberships.map((membership) => membershipFromDto(membership));
    } catch (error: unknown) {
      throw mapError(error, 'read');
    }
  }

  /** Full society for a member of it, `null` for anyone else. */
  async findById(id: string, _actor: UserId): Promise<Society | null> {
    try {
      const profile = await apiRequest('GET', `societies/${id}`, {
        schema: societyProfileResponseSchema,
      });
      return societyFromDto(profile.society);
    } catch (error: unknown) {
      // `null`, not a throw: the port asks for "absent", and the caller renders an
      // empty state rather than an error screen.
      if (isApiError(error) && error.code === 'NOT_FOUND') return null;
      throw mapError(error, 'read');
    }
  }

  /** Public preview of a join code (PRD §3.2). No session required. */
  async findJoinPreview(rawCode: string): Promise<SocietyJoinPreview | null> {
    const code = normalizeJoinCode(rawCode);
    // Checked here rather than server-side: the query pipe is strict, so a
    // malformed code would come back as a 422 and the join screen would show a
    // validation error for what is simply "nothing typed yet".
    if (!JOIN_CODE_PATTERN.test(code)) return null;

    try {
      const { preview } = await apiRequest(
        'GET',
        `societies/lookup?code=${encodeURIComponent(code)}`,
        { schema: joinPreviewResponseSchema, anonymous: true },
      );
      return {
        id: asSocietyId(preview.id),
        name: preview.name,
        city: preview.city,
        state: preview.state,
        type: preview.type,
        memberCount: preview.memberCount,
        joinCodeExpiresAt: preview.joinCodeExpiresAt,
      };
    } catch (error: unknown) {
      // A code that resolves to nothing is the ordinary answer, not a failure.
      if (isApiError(error) && error.code === 'NOT_FOUND') return null;
      throw mapError(error, 'read');
    }
  }

  /**
   * The flats a join code's society offers (T049) — the join screen's selector.
   *
   * `anonymous: false` on purpose: this route is authenticated (the SQL function is granted to
   * `authenticated` only, because a code oracle reachable by anyone is a brute-force surface),
   * while the *preview* above is the one public call. Sending the token is what makes the two
   * different requests rather than two spellings of one.
   *
   * A dead code answers `422 JOIN_CODE_INVALID`, which `mapError` maps to `join_code_invalid` —
   * the same code and the same sentence the submission gives, so the join screen has one branch.
   */
  async joinOptions(
    rawCode: string,
    query: { readonly query?: string | undefined; readonly limit?: number | undefined },
    _actor: UserId,
  ): Promise<SocietyJoinOptions> {
    const code = normalizeJoinCode(rawCode);
    if (!JOIN_CODE_PATTERN.test(code)) {
      throw new SocietyError(
        'join_code_invalid',
        'A join code is 6 characters (no 0, O, 1 or I).',
        { field: 'code' },
      );
    }

    const parameters: [string, string][] = [['code', code]];
    if (query.query !== undefined && query.query.trim().length > 0) {
      parameters.push(['q', query.query.trim()]);
    }
    if (query.limit !== undefined) parameters.push(['limit', String(query.limit)]);
    const search = parameters
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join('&');

    try {
      const options = await apiRequest('GET', `societies/join-options?${search}`, {
        schema: joinOptionsResponseSchema,
      });
      return {
        societyId: asSocietyId(options.societyId),
        flats: options.flats.map((flat) => ({
          id: asApartmentId(flat.id),
          number: flat.number,
          buildingId: asBuildingId(flat.buildingId),
          buildingName: flat.buildingName,
          wingId: flat.wingId,
          wingName: flat.wingName,
          floor: flat.floor,
        })),
        total: options.total,
        truncated: options.truncated,
      };
    } catch (error: unknown) {
      throw mapError(error, 'read');
    }
  }

  // ── write ────────────────────────────────────────────────────────────────────

  /**
   * Create a society, its settings and the creator's Admin membership.
   *
   * The slug, the join code and the membership are derived server-side; the client
   * sends only what the user chose. No join-code retry lives here any more: the
   * code is minted inside the server's transaction, so a collision is the server's
   * to absorb, not a race for every client to notice and re-drive.
   */
  async create(
    input: CreateSocietyInput,
    _actor: UserId,
  ): Promise<{
    readonly society: Society;
    readonly membership: SocietyMembership;
  }> {
    try {
      const created = await apiRequest('POST', 'societies', {
        body: pickDefined(input, CREATE_FIELDS),
        schema: createdSocietyResponseSchema,
      });
      return {
        society: societyFromDto(created.society),
        membership: membershipFromDto(created.membership),
      };
    } catch (error: unknown) {
      throw mapError(error, 'create');
    }
  }

  /** Patch the society and/or its settings — one atomic call. */
  async update(id: string, input: UpdateSocietyInput, _actor: UserId): Promise<Society> {
    try {
      const { society } = await apiRequest('PATCH', `societies/${id}`, {
        body: pickDefined(input, UPDATE_FIELDS),
        schema: societyResponseSchema,
      });
      return societyFromDto(society);
    } catch (error: unknown) {
      throw mapError(error, 'write');
    }
  }

  /** Admin-only join-code rotation. The new code is minted server-side. */
  async regenerateJoinCode(id: string, _actor: UserId): Promise<Society> {
    try {
      const { society } = await apiRequest('POST', `societies/${id}/join-code`, {
        schema: societyResponseSchema,
      });
      return societyFromDto(society);
    } catch (error: unknown) {
      throw mapError(error, 'write');
    }
  }

  /** Soft delete: the row stays, the memberships are removed, the code dies. */
  async remove(id: string, _actor: UserId): Promise<void> {
    try {
      await apiRequest('DELETE', `societies/${id}`);
    } catch (error: unknown) {
      throw mapError(error, 'write');
    }
  }

  /** Ask to join with a code. Never auto-approved (PRD §3.2). */
  async join(input: JoinSocietyInput, _actor: UserId): Promise<SocietyMembership> {
    try {
      const { membership } = await apiRequest('POST', 'societies/join', {
        body: { code: normalizeJoinCode(input.code), occupancyType: input.occupancyType },
        schema: membershipResponseSchema,
      });
      return membershipFromDto(membership);
    } catch (error: unknown) {
      if (isApiError(error) && error.code === 'NOT_FOUND') {
        // The one message for "no such code" and "code belongs to a deleted
        // society": a probe must not be able to enumerate societies.
        throw new SocietyError('join_code_invalid', 'That join code does not match any society.');
      }
      throw mapError(error, 'join');
    }
  }

  /** Leave, or withdraw a pending request. */
  async leave(societyId: string, _actor: UserId): Promise<void> {
    try {
      await apiRequest('POST', `societies/${societyId}/leave`);
    } catch (error: unknown) {
      throw mapError(error, 'write');
    }
  }
}
