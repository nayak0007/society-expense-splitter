import {
  buildingDetailResponseSchema,
  buildingListResponseSchema,
  buildingResponseSchema,
} from "@ses/contracts";
import type {
  BuildingDetailResponseDto,
  BuildingDto,
  BuildingListResponseDto,
  BuildingResponseDto,
} from "@ses/contracts";
import type { Building, StructureCapabilities } from "@ses/domain";

/**
 * Domain entity → wire DTO, per SAD §4.5's `presentation/*.mapper.ts`.
 *
 * ## Why every mapper *parses* rather than constructs
 *
 * The contract schemas in `@ses/contracts` are the client's parse target, so the
 * response has to satisfy them exactly. Mapping by hand and trusting it means a
 * domain rename — `totalFloors` to `floorCount`, a `null` becoming `undefined` —
 * ships as a silently wrong payload that the mobile client then fails to parse, in
 * production, on one screen. Parsing here turns that into a 500 with a stack trace
 * at the moment the field moves, and the cost is a Zod pass over one small object
 * on the response path.
 *
 * The mappers are deliberately explicit rather than spreads: a spread would
 * forward any field the domain grows, including ones the contract does not define,
 * and the whole point of the boundary is that it is enumerated.
 *
 * `capabilities` is derived from the *membership* the use case already loaded, and
 * is shipped on reads for the reason `SocietyCapabilities` is: a list screen has
 * to decide whether to render "Add building" and whether each row's edit and
 * delete are available, and re-deriving that from a role string in the screen is
 * exactly what SAD §9.3 forbids.
 */
export function buildingToDto(building: Building): BuildingDto {
  return buildingResponseSchema.shape.building.parse({
    id: building.id,
    societyId: building.societyId,
    name: building.name,
    totalFloors: building.totalFloors,
    displayOrder: building.displayOrder,
    createdAt: building.createdAt,
    updatedAt: building.updatedAt,
    deletedAt: building.deletedAt,
  });
}

function capabilitiesToDto(
  capabilities: StructureCapabilities,
): BuildingListResponseDto["capabilities"] {
  return buildingListResponseSchema.shape.capabilities.parse({
    canManage: capabilities.canManage,
    canView: capabilities.canView,
  });
}

/**
 * `GET /buildings` — the list and what the caller may do with it.
 *
 * The membership is taken as an argument even though only the capabilities are
 * read from it: the use case returns both, and keeping the pair together here
 * means the capabilities on the wire are always the ones evaluated against *this*
 * response's membership rather than against whatever a caller happened to have.
 */
export function buildingListToDto(
  buildings: readonly Building[],
  capabilities: StructureCapabilities,
): BuildingListResponseDto {
  return buildingListResponseSchema.parse({
    buildings: buildings.map((building) => buildingToDto(building)),
    capabilities: capabilitiesToDto(capabilities),
  });
}

export function buildingDetailToDto(
  building: Building,
  capabilities: StructureCapabilities,
): BuildingDetailResponseDto {
  return buildingDetailResponseSchema.parse({
    building: buildingToDto(building),
    capabilities: capabilitiesToDto(capabilities),
  });
}

export function buildingResponseToDto(building: Building): BuildingResponseDto {
  return buildingResponseSchema.parse({ building: buildingToDto(building) });
}
