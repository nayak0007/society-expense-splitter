import {
  apartmentDetailResponseSchema,
  apartmentListResponseSchema,
  apartmentResponseSchema,
} from '@ses/contracts';
import type { ApartmentDto } from '@ses/contracts';
import { asApartmentId, asBuildingId, asSocietyId, asWingId, StructureError } from '@ses/domain';
import type {
  Apartment,
  ApartmentId,
  ApartmentRepository,
  BuildingId,
  CreateApartmentInput,
  SocietyId,
  UpdateApartmentInput,
  UserId,
} from '@ses/domain';

import { apiRequest, isApiError } from '@/lib/api/api-client';
import type { ApiError } from '@/lib/api/api-client';

/**
 * `ApartmentRepository` implemented over the Resident 360 API.
 *
 * The same three properties `ApiBuildingRepository` records, restated because the
 * flat routes are the first place the two of them differ:
 *
 *  - the society travels as the `X-Society-Id` header, never in the path and never
 *    in the body — that header is what puts the request behind `SocietyGuard`, and
 *    a second way to say where the request acts is exactly how a guard ends up
 *    authorising one tenant while the query reads another;
 *  - `actor` is not sent: over HTTP the actor *is* the JWT;
 *  - the pair `(buildingId, societyId)` is not verified locally. The client does
 *    not hold a copy of the structure and must not keep one — a foreign building is
 *    answered `404`, which becomes `not_found`.
 *
 * ## `countForBuilding` reads the list, and that is a deliberate trade
 *
 * The port has no count endpoint: `GET /buildings/:id/apartments` is the only way
 * to ask the question, so this method reads the flats and reports how many came
 * back. Its one caller is `deleteBuilding`, which asks before it removes a building
 * and only branches on whether the answer is zero — and the rule is enforced again
 * by the database (`building_soft_delete` raises `BUILDING_HAS_APARTMENTS`), so the
 * cost of a list read buys a *better* message ("this building still has 12 flats")
 * rather than the enforcement itself. A dedicated `HEAD`/count route would be a
 * second endpoint to document and version for one client-side branch.
 */

/** The port's `Apartment` is the API's `apartmentSchema` plus branded ids. */
function apartmentFromDto(dto: ApartmentDto): Apartment {
  return {
    id: asApartmentId(dto.id),
    societyId: asSocietyId(dto.societyId),
    buildingId: asBuildingId(dto.buildingId),
    wingId: dto.wingId === null ? null : asWingId(dto.wingId),
    apartmentNumber: dto.apartmentNumber,
    floor: dto.floor,
    bhk: dto.bhk,
    carpetAreaSqft: dto.carpetAreaSqft,
    builtupAreaSqft: dto.builtupAreaSqft,
    parkingSlots: dto.parkingSlots,
    shareUnits: dto.shareUnits,
    occupancyStatus: dto.occupancyStatus,
    isCommercial: dto.isCommercial,
    isBillable: dto.isBillable,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    deletedAt: dto.deletedAt,
  };
}

/**
 * The `{ field }` detail, or nothing at all when the server named no field.
 *
 * Spread rather than an always-present key, for the reason the building adapter
 * gives: `formFieldOfError` treats a missing `field` as "not attached to an input",
 * and a literal `undefined` would be the same as absent while also marking the
 * object as *having* a field.
 */
function fieldDetails(error: ApiError): { readonly field?: string } {
  const field = error.field ?? error.details?.[0]?.field;
  return field === undefined ? {} : { field };
}

/**
 * API error catalogue → the structure module's vocabulary (SAD §7.10).
 *
 * `BUILDING_HAS_APARTMENTS` is the one code here that is *not* a flat failure: it
 * arrives on `DELETE /buildings/:id` and the flat dictionary is where it is spelled
 * — `conflict` plus `field: 'apartmentNumber'` would be wrong, and `building_has_apartments`
 * is the code the domain uses for the same rule, so the two adapters cannot
 * disagree about which refusal the user is looking at.
 */
function mapError(error: unknown, fallbackMessage: string): StructureError {
  if (!isApiError(error)) {
    return error instanceof StructureError
      ? error
      : new StructureError('unknown', 'The flat operation failed unexpectedly.');
  }

  switch (error.code) {
    case 'NOT_FOUND':
      // PRD T041: a non-member must not be able to tell a foreign society's flat
      // from a flat that does not exist, so both answer the same.
      return new StructureError('not_found', 'That flat is not available to you.', {
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
    case 'VERSION_MISMATCH': {
      // The detail code, when the API sent one, is what distinguishes "that flat
      // number is taken" from "the building still has flats". Both are 409s; only
      // the second is about the *building*, and the form that produced it is the
      // building edit screen — so it is reported as its own domain code rather than
      // as a conflict the flat form would try to attach to a field.
      const detailCode = error.details?.[0]?.code;
      if (detailCode === 'BUILDING_HAS_APARTMENTS') {
        return new StructureError('building_has_apartments', error.message, {
          requestId: error.requestId,
        });
      }
      return new StructureError('conflict', error.message, {
        ...fieldDetails(error),
        requestId: error.requestId,
      });
    }

    default:
      // UNAUTHENTICATED and TOKEN_EXPIRED land here on purpose — the client already
      // replayed once after a silent refresh, and a still-refused session has been
      // cleared by supabase-js, which routes to sign-in.
      return new StructureError('unknown', error.message || fallbackMessage, {
        code: error.code,
        requestId: error.requestId,
      });
  }
}

/**
 * Only the keys the contract accepts — both body schemas are strict, so an extra
 * key is a `400` rather than something ignored.
 *
 * `undefined` is dropped and **`null` is kept**, which is the opposite of the
 * building adapter's rule and on purpose: on a flat, `null` means "no longer
 * recorded" and is a value the user asked for by emptying the field, while absent
 * means "leave it alone". Dropping `null` here would silently make every recorded
 * area un-clearable from the app.
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

/**
 * `wingId` is deliberately absent from both lists.
 *
 * Wings have no write API yet (Roadmap T043), so a form cannot produce one, and a
 * body that carried `wingId: undefined`-derived keys would be answered `400` by the
 * strict contract. The column and its foreign key exist; the reference does not
 * become settable until the wings slice lands.
 */
const APARTMENT_FIELDS = [
  'apartmentNumber',
  'floor',
  'bhk',
  'carpetAreaSqft',
  'builtupAreaSqft',
  'parkingSlots',
  'shareUnits',
  'occupancyStatus',
  'isCommercial',
  'isBillable',
] as const;

export class ApiApartmentRepository implements ApartmentRepository {
  async listApartments(
    buildingId: BuildingId,
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<readonly Apartment[]> {
    try {
      const { apartments } = await apiRequest('GET', `buildings/${buildingId}/apartments`, {
        schema: apartmentListResponseSchema,
        societyId,
      });
      return apartments.map((apartment) => apartmentFromDto(apartment));
    } catch (error: unknown) {
      throw mapError(error, 'Could not load the flats.');
    }
  }

  /** `null`, not a throw, for a flat the caller may not see. */
  async findApartment(
    id: ApartmentId,
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<Apartment | null> {
    try {
      const { apartment } = await apiRequest('GET', `apartments/${id}`, {
        schema: apartmentDetailResponseSchema,
        societyId,
      });
      return apartmentFromDto(apartment);
    } catch (error: unknown) {
      // The port asks for "absent" and the caller renders an empty state; a
      // deleted or foreign flat is an ordinary answer, not a failure.
      if (isApiError(error) && error.code === 'NOT_FOUND') return null;
      throw mapError(error, 'Could not load that flat.');
    }
  }

  async create(
    buildingId: BuildingId,
    societyId: SocietyId,
    input: CreateApartmentInput,
    _actor: UserId,
  ): Promise<Apartment> {
    try {
      const { apartment } = await apiRequest('POST', `buildings/${buildingId}/apartments`, {
        body: body(input, APARTMENT_FIELDS),
        schema: apartmentResponseSchema,
        societyId,
      });
      return apartmentFromDto(apartment);
    } catch (error: unknown) {
      throw mapError(error, 'Could not create the flat.');
    }
  }

  async update(
    id: ApartmentId,
    societyId: SocietyId,
    input: UpdateApartmentInput,
    _actor: UserId,
  ): Promise<Apartment> {
    try {
      const { apartment } = await apiRequest('PATCH', `apartments/${id}`, {
        body: body(input, APARTMENT_FIELDS),
        schema: apartmentResponseSchema,
        societyId,
      });
      return apartmentFromDto(apartment);
    } catch (error: unknown) {
      throw mapError(error, 'Could not save the flat.');
    }
  }

  /** Soft delete server-side: the row is kept, every read path filters it. */
  async remove(id: ApartmentId, societyId: SocietyId, _actor: UserId): Promise<void> {
    try {
      await apiRequest('DELETE', `apartments/${id}`, { societyId });
    } catch (error: unknown) {
      throw mapError(error, 'Could not delete the flat.');
    }
  }

  /**
   * How many live flats the building has — read as a list, because the API has no
   * count route and one caller only needs to know whether the answer is zero.
   */
  async countForBuilding(
    buildingId: BuildingId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<number> {
    const apartments = await this.listApartments(buildingId, societyId, actor);
    return apartments.length;
  }
}
