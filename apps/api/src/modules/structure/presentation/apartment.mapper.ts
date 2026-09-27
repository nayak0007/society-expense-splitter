import {
  apartmentDetailResponseSchema,
  apartmentListResponseSchema,
  apartmentResponseSchema,
} from "@ses/contracts";
import type {
  ApartmentDetailResponseDto,
  ApartmentDto,
  ApartmentListResponseDto,
  ApartmentResponseDto,
} from "@ses/contracts";
import type { Apartment, StructureCapabilities } from "@ses/domain";

/**
 * Domain entity → wire DTO, per SAD §4.5's `presentation/*.mapper.ts`.
 *
 * Every mapper *parses* rather than constructs, for the reason `building.mapper.ts`
 * records at length: the contract schemas are the client's parse target, so mapping
 * by hand and trusting it means a domain rename ships as a silently wrong payload
 * that the mobile client then fails to parse, in production, on one screen. Parsing
 * here turns that into a 500 with a stack trace at the moment the field moves.
 *
 * The mappers are explicit rather than spreads: a spread would forward any field
 * the domain grows, including ones the contract does not define, and the whole
 * point of the boundary is that it is enumerated.
 */

export function apartmentToDto(apartment: Apartment): ApartmentDto {
  return apartmentResponseSchema.shape.apartment.parse({
    id: apartment.id,
    societyId: apartment.societyId,
    buildingId: apartment.buildingId,
    wingId: apartment.wingId,
    apartmentNumber: apartment.apartmentNumber,
    floor: apartment.floor,
    bhk: apartment.bhk,
    carpetAreaSqft: apartment.carpetAreaSqft,
    builtupAreaSqft: apartment.builtupAreaSqft,
    parkingSlots: apartment.parkingSlots,
    shareUnits: apartment.shareUnits,
    occupancyStatus: apartment.occupancyStatus,
    isCommercial: apartment.isCommercial,
    isBillable: apartment.isBillable,
    createdAt: apartment.createdAt,
    updatedAt: apartment.updatedAt,
    deletedAt: apartment.deletedAt,
  });
}

function capabilitiesToDto(
  capabilities: StructureCapabilities,
): ApartmentListResponseDto["capabilities"] {
  // The capability shape is the same two booleans the building contract defines,
  // and it is parsed against the apartment contract's own copy rather than the
  // building one — the two schemas are free to diverge, and this is what notices.
  return apartmentListResponseSchema.shape.capabilities.parse({
    canManage: capabilities.canManage,
    canView: capabilities.canView,
  });
}

/**
 * `GET /buildings/:buildingId/apartments` — the flats and what the caller may do.
 *
 * `canManage` is what lets a screen render "add your first flat" for an empty
 * building instead of an error state, and it is shipped rather than re-derived in
 * the screen for the reason SAD §9.3 gives: a disabled button and a rejected
 * request must not be able to disagree.
 */
export function apartmentListToDto(
  apartments: readonly Apartment[],
  capabilities: StructureCapabilities,
): ApartmentListResponseDto {
  return apartmentListResponseSchema.parse({
    apartments: apartments.map((apartment) => apartmentToDto(apartment)),
    capabilities: capabilitiesToDto(capabilities),
  });
}

export function apartmentDetailToDto(
  apartment: Apartment,
  capabilities: StructureCapabilities,
): ApartmentDetailResponseDto {
  return apartmentDetailResponseSchema.parse({
    apartment: apartmentToDto(apartment),
    capabilities: capabilitiesToDto(capabilities),
  });
}

export function apartmentResponseToDto(
  apartment: Apartment,
): ApartmentResponseDto {
  return apartmentResponseSchema.parse({
    apartment: apartmentToDto(apartment),
  });
}
