import type { StructureDeps } from '@ses/application';

import { getApartmentRepository } from './apartment.repository';
import { getBuildingRepository, getStructureMembershipReader } from './building.repository';

/**
 * The dependencies every structure use case needs, resolved at call time.
 *
 * One factory rather than one per service, because `StructureDeps` is one object
 * and both the building and the flat use cases take it — including the cases that
 * cross the two, `deleteBuilding` asking the **apartments** port how many flats a
 * building still has. A service that built its own `deps` would have to remember
 * that the buildings repository alone is not enough, and the failure would be a
 * `TypeError` at the moment a delete is attempted.
 *
 * Resolved per call, never captured at import: the repositories read the society
 * and auth stores per request, and a snapshot taken at import time would be a
 * session from before the user signed in.
 */
export function structureDeps(): StructureDeps {
  return {
    buildings: getBuildingRepository(),
    apartments: getApartmentRepository(),
    memberships: getStructureMembershipReader(),
  };
}
