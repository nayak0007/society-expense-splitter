import { asStructureError, ok } from "@ses/domain";
import type {
  Apartment,
  ApartmentId,
  Result,
  SocietyId,
  SocietyMembership,
  StructureCapabilities,
  UserId,
} from "@ses/domain";

import { loadApartmentContext } from "./support";
import type { StructureDeps } from "./support";

/**
 * View one flat (PRD §2 screen 73; the edit screen's read).
 *
 * Returns the flat, the caller's membership and the capabilities derived from it —
 * the same triple `getBuilding` returns, and for the same reason: the screen needs
 * all three to render (the details, the caller's role, and which of edit/delete to
 * offer), and computing the capabilities in the domain is what keeps a screen from
 * inventing its own permission logic (SAD §9.3).
 *
 * ## Why the capability check is left to the route and to the loader
 *
 * A *read* is refused in two stages and neither is here: a caller who is not an
 * active member fails inside `loadApartmentContext` with `not_found`, and a
 * membership whose role lacks `structure.view` is refused by the API's
 * `@RequirePermission("structure.view")` before this function is reached. Adding a
 * third check would be a rule stated where it is not enforced — the guard is what
 * protects the route, and duplicating it here would only make the two drift.
 * `listApartments` *does* check, because it has no sibling route guard to rely on
 * for the building-scoped path; that asymmetry is documented there.
 */
export interface ApartmentView {
  readonly apartment: Apartment;
  readonly membership: SocietyMembership;
  readonly capabilities: StructureCapabilities;
}

export async function getApartment(
  deps: StructureDeps,
  actor: UserId,
  societyId: SocietyId,
  apartmentId: ApartmentId,
): Promise<Result<ApartmentView, ReturnType<typeof asStructureError>>> {
  const loaded = await loadApartmentContext(
    deps,
    actor,
    societyId,
    apartmentId,
  );
  if (!loaded.ok) return loaded;

  return ok({
    apartment: loaded.value.apartment,
    membership: loaded.value.membership,
    capabilities: loaded.value.capabilities,
  });
}
