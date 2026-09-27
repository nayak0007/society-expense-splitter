import type { BuildingRepository, StructureMembershipReader } from '@ses/domain';

import { ApiBuildingRepository } from './building.repository.api';
import { SessionStructureMembershipReader } from './structure-membership.reader';

/**
 * Structure feature composition root — the one place that decides which
 * implementation the app uses.
 *
 * **The API is the only repository implementation, and there is deliberately no
 * mock here.** The society slice keeps one because it predates the API and its
 * fake doubles as a UI-development seam; the building slice was written after
 * `/v1/buildings` existed, so a local fake would be a second implementation of
 * rules that already live in `@ses/application` and are exercised by the API's own
 * e2e suite. Both entry points exist for the same reason the society slice's do —
 * that importing this module must not construct anything, and that a test can
 * swap in a five-line stub without module mocking:
 *
 *     setBuildingRepository(fake); setStructureMembershipReader(fakeReader);
 *
 * The membership reader is resolved lazily too, so the store is read per call
 * rather than captured once at import — which is what keeps it from holding a
 * snapshot from before the user signed in.
 */
let buildingRepository: BuildingRepository | null = null;
let membershipReader: StructureMembershipReader | null = null;

export function getBuildingRepository(): BuildingRepository {
  buildingRepository ??= new ApiBuildingRepository();
  return buildingRepository;
}

/** Test/tooling seam — inject a fake or a stub. */
export function setBuildingRepository(repository: BuildingRepository | null): void {
  buildingRepository = repository;
}

export function getStructureMembershipReader(): StructureMembershipReader {
  membershipReader ??= new SessionStructureMembershipReader();
  return membershipReader;
}

/** Test/tooling seam — inject a fake reader, or reset to the session snapshot. */
export function setStructureMembershipReader(reader: StructureMembershipReader | null): void {
  membershipReader = reader;
}
