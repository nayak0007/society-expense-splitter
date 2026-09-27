import {
  buildingDetailResponseSchema,
  buildingListResponseSchema,
  buildingResponseSchema,
} from '@ses/contracts';
import type { BuildingDto } from '@ses/contracts';
import { asBuildingId, asSocietyId, StructureError } from '@ses/domain';
import type {
  Building,
  BuildingId,
  BuildingRepository,
  CreateBuildingInput,
  SocietyId,
  UpdateBuildingInput,
  UserId,
} from '@ses/domain';

import { apiRequest, isApiError } from '@/lib/api/api-client';
import type { ApiError } from '@/lib/api/api-client';

/**
 * `BuildingRepository` implemented over the Resident 360 API.
 *
 * ## Where the society comes from
 *
 * Every method sends the society as the `X-Society-Id` header — **not** in the
 * path and never in the body. That header is what puts the request behind
 * `SocietyGuard`, which resolves it into the caller's membership in one read and
 * hands the controller both the society and the membership it authorised against.
 * A path parameter carrying the tenant alongside a header would give the request
 * two ways to say where it acts, and the guard authorises against one while the
 * query reads the other.
 *
 * ## `actor` is not sent
 *
 * Same as `ApiSocietyRepository`: over HTTP the actor *is* the JWT, verified by
 * the API against the project's JWKS. Forwarding an id would be redundant and
 * strictly weaker, because the token says it better and the server would have to
 * decide which to believe.
 *
 * ## The pair `(buildingId, societyId)` is not checked here
 *
 * The domain port documents that a building id alone does not say which tenant a
 * caller acts in, and this adapter relies on the server honouring that: a building
 * that exists in another society is answered `404`, which becomes `not_found`
 * below. Re-checking the pair locally would mean holding a copy of the structure,
 * which the client does not have and must not keep.
 */

/** The port's `Building` is the API's `buildingSchema` plus a branded id. */
function buildingFromDto(dto: BuildingDto): Building {
  return {
    id: asBuildingId(dto.id),
    societyId: asSocietyId(dto.societyId),
    name: dto.name,
    totalFloors: dto.totalFloors,
    displayOrder: dto.displayOrder,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    deletedAt: dto.deletedAt,
  };
}

/**
 * API error catalogue → the structure module's vocabulary (SAD §7.10).
 *
 * Narrowing rather than guessing, exactly as the society adapter does. The two
 * cases worth reading twice:
 *
 *  - `VALIDATION_ERROR` becomes `validation` and **keeps the offending field**,
 *    so a duplicate name arrives attached to the name input instead of as a
 *    banner the user cannot act on.
 *  - `SOCIETY_REQUIRED`/`SOCIETY_INVALID` (the guard's `400`s for a missing or
 *    malformed header) become `validation` too: they are this adapter's own bug,
 *    never something the user did, and reporting them as `unknown` would make a
 *    programming error look like an outage.
 */
/**
 * The `{ field }` detail, or nothing at all when the server named no field.
 *
 * Spread rather than an always-present key: `formFieldOfError` treats a missing
 * `field` as "this failure is not attached to an input", and a literal `undefined`
 * forwarded here would be the same as absent — except that it would also mark the
 * object as having a field for anyone who checked `'field' in details`.
 */
function fieldDetails(error: ApiError): { readonly field?: string } {
  const field = error.field ?? error.details?.[0]?.field;
  return field === undefined ? {} : { field };
}

function mapError(error: unknown): StructureError {
  if (!isApiError(error)) {
    return error instanceof StructureError
      ? error
      : new StructureError('unknown', 'The building operation failed unexpectedly.');
  }

  switch (error.code) {
    case 'NOT_FOUND':
      // PRD T041: a non-member must not be able to tell a foreign society's
      // building from a building that does not exist, so both answer the same.
      return new StructureError('not_found', 'That building is not available to you.', {
        requestId: error.requestId,
      });

    case 'FORBIDDEN':
      return new StructureError(
        'forbidden',
        'Only a society Admin can change the society structure.',
        { requestId: error.requestId },
      );

    case 'VALIDATION_ERROR':
    case 'SOCIETY_REQUIRED':
    case 'SOCIETY_INVALID':
      return new StructureError('validation', error.message, {
        ...fieldDetails(error),
        requestId: error.requestId,
      });

    case 'CONFLICT':
    case 'DUPLICATE_RESOURCE':
    case 'VERSION_MISMATCH':
      return new StructureError('conflict', error.message, {
        ...fieldDetails(error),
        requestId: error.requestId,
      });

    default:
      // UNAUTHENTICATED and TOKEN_EXPIRED land here on purpose. They are not this
      // layer's decision: the client already replayed once after a silent
      // refresh, and a session still refused has been cleared by supabase-js,
      // which routes to sign-in through `onAuthStateChange`.
      return new StructureError('unknown', error.message, {
        code: error.code,
        requestId: error.requestId,
      });
  }
}

/**
 * Only the keys `createBuildingSchema` accepts — it is `.strict()`, so an extra
 * key is a `400` rather than something ignored.
 *
 * `undefined` values are dropped rather than sent as `null`: the contract makes
 * `totalFloors`/`displayOrder` `.optional()`, and "not recorded" is an absent
 * value. Sending `null` would be refused, and on the update path `undefined`
 * already means "leave unchanged" — so a patch assembled from a form the user
 * half-filled would otherwise clear fields they never touched.
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

const BUILDING_FIELDS = ['name', 'totalFloors', 'displayOrder'] as const;

export class ApiBuildingRepository implements BuildingRepository {
  async listBuildings(societyId: SocietyId, _actor: UserId): Promise<readonly Building[]> {
    try {
      const { buildings } = await apiRequest('GET', 'buildings', {
        schema: buildingListResponseSchema,
        societyId,
      });
      return buildings.map((building) => buildingFromDto(building));
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  /** `null`, not a throw, for a building the caller may not see. */
  async findBuilding(
    id: BuildingId,
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<Building | null> {
    try {
      const { building } = await apiRequest('GET', `buildings/${id}`, {
        schema: buildingDetailResponseSchema,
        societyId,
      });
      return buildingFromDto(building);
    } catch (error: unknown) {
      // The port asks for "absent" and the caller renders an empty state; a
      // deleted or foreign building is an ordinary answer, not a failure.
      if (isApiError(error) && error.code === 'NOT_FOUND') return null;
      throw mapError(error);
    }
  }

  async create(
    societyId: SocietyId,
    input: CreateBuildingInput,
    _actor: UserId,
  ): Promise<Building> {
    try {
      const { building } = await apiRequest('POST', 'buildings', {
        body: body(input, BUILDING_FIELDS),
        schema: buildingResponseSchema,
        societyId,
      });
      return buildingFromDto(building);
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  async update(
    id: BuildingId,
    societyId: SocietyId,
    input: UpdateBuildingInput,
    _actor: UserId,
  ): Promise<Building> {
    try {
      const { building } = await apiRequest('PATCH', `buildings/${id}`, {
        body: body(input, BUILDING_FIELDS),
        schema: buildingResponseSchema,
        societyId,
      });
      return buildingFromDto(building);
    } catch (error: unknown) {
      throw mapError(error);
    }
  }

  /** Soft delete server-side: the row is kept, every read path filters it. */
  async remove(id: BuildingId, societyId: SocietyId, _actor: UserId): Promise<void> {
    try {
      await apiRequest('DELETE', `buildings/${id}`, { societyId });
    } catch (error: unknown) {
      throw mapError(error);
    }
  }
}
