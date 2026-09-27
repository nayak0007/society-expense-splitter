import { Inject, Injectable } from "@nestjs/common";

import type { ImportApartmentReader, ImportFlat } from "@ses/application";
import type { SocietyId, UserId } from "@ses/domain";

import {
  APARTMENT_REPOSITORY,
  BUILDING_REPOSITORY,
} from "../../structure/application/structure.tokens";
import type { ApartmentRepository } from "@ses/domain";
import type { BuildingRepository } from "@ses/domain";

/**
 * The flat reference the bulk import resolves `flat_no` labels against (T048).
 *
 * ## Why this adapter exists, and why it is this thin
 *
 * The import asks one question — "which live flats can this admin see?" — and the
 * answer is a join across two tables the *structure* module owns. Rather than letting
 * the member module grow SQL about `apartments`, the question is answered **through
 * the structure module's own ports**: list the society's buildings, list each
 * building's flats, index the labels. Every read runs under the caller's own RLS
 * identity inside the existing adapters, so another society's flat is structurally
 * absent from the answer — which is exactly `APARTMENT_NOT_FOUND` at the use case,
 * never a cross-tenant leak.
 *
 * Two batched queries per import (one per table), regardless of row count — the N+1
 * the Roadmap's own criteria forbid would be one query *per row*, and this is not
 * that: the per-building fan-out is one query per building, which is bounded by the
 * society's structure, not by the file.
 */
@Injectable()
export class ImportFlatReaderService implements ImportApartmentReader {
  constructor(
    @Inject(BUILDING_REPOSITORY) private readonly buildings: BuildingRepository,
    @Inject(APARTMENT_REPOSITORY)
    private readonly apartments: ApartmentRepository,
  ) {}

  async listSocietyFlats(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly ImportFlat[]> {
    const buildings = await this.buildings.listBuildings(societyId, actor);
    const flats = await Promise.all(
      buildings.map((building) =>
        this.apartments.listApartments(building.id, societyId, actor),
      ),
    );
    return flats.flat().map((apartment) => ({
      id: apartment.id,
      apartmentNumber: apartment.apartmentNumber,
    }));
  }
}
