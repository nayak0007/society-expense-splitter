import { asSocietyError, ok } from "@ses/domain";
import type {
  Result,
  Society,
  SocietyCapabilities,
  SocietyId,
  SocietyMembership,
  UserId,
} from "@ses/domain";

import { loadSocietyContext } from "./support";
import type { SocietyDeps } from "./support";

/**
 * View the society profile (PRD §3.2).
 *
 * Returns the society, the caller's membership and the capabilities derived from
 * them, in one object. The UI needs all three to render one screen — the details,
 * the caller's role badge, and which actions to offer — and computing the
 * capabilities server-side (or in the domain, for a local read) is what stops a
 * screen from inventing its own permission logic.
 */
export interface SocietyProfileView {
  readonly society: Society;
  readonly membership: SocietyMembership;
  readonly capabilities: SocietyCapabilities;
}

export async function getSocietyProfile(
  deps: SocietyDeps,
  actor: UserId,
  societyId: SocietyId,
): Promise<Result<SocietyProfileView, ReturnType<typeof asSocietyError>>> {
  const loaded = await loadSocietyContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  return ok({
    society: loaded.value.society,
    membership: loaded.value.membership,
    capabilities: loaded.value.capabilities,
  });
}
