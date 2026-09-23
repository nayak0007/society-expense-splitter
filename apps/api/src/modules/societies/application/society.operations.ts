import { Inject, Injectable } from "@nestjs/common";
import {
  createSociety,
  deleteSociety,
  getSocietyProfile,
  joinSociety,
  leaveSociety,
  listSocietySummaries,
  lookupJoinCode,
  regenerateJoinCode,
  updateSociety,
} from "@ses/application";
import type {
  CreateSocietyCommand,
  CreatedSociety,
  JoinSocietyCommand,
  SocietyDeps,
  SocietyProfileView,
  UpdateSocietyCommand,
} from "@ses/application";
import type {
  Clock,
  Result,
  Society,
  SocietyError,
  SocietyId,
  SocietyMembership,
  SocietyJoinPreview,
  SocietyRepository,
  SocietySummary,
  UserId,
} from "@ses/domain";

import { toAppError } from "./society-error.mapper";
import { SOCIETY_CLOCK, SOCIETY_REPOSITORY } from "./society.tokens";

/**
 * The API's view of the society use cases.
 *
 * **No business rules live here.** Every rule — the join-code's shape and
 * expiry, the sole-admin invariant, `canManage`/`canDelete`, "absent means
 * unchanged but empty means cleared" — is already implemented in
 * `@ses/application`, which the mobile app calls too. This class does the two
 * things that are genuinely specific to HTTP:
 *
 *  1. it supplies the dependencies (`SocietyRepository` + `Clock`) that the use
 *     cases take as arguments, from the container rather than as values;
 *  2. it unwraps `Result` into a value or a thrown `AppError`, because a
 *     controller that had to branch on `ok` on every route would reintroduce the
 *     per-endpoint divergence the shared layer exists to prevent.
 *
 * The `(deps, actor, command) → Result` shape is what makes (1) trivial: the use
 * cases are pure functions, so there is nothing to construct per request and
 * nothing to reset between them.
 *
 * `Clock` is injected rather than imported as `systemClock` so a test can freeze
 * time and exercise join-code expiry — the one rule in this module that depends
 * on "now".
 */
@Injectable()
export class SocietyOperations {
  constructor(
    @Inject(SOCIETY_REPOSITORY)
    private readonly repository: SocietyRepository,
    @Inject(SOCIETY_CLOCK) private readonly clock: Clock,
  ) {}

  private get deps(): SocietyDeps {
    return { repository: this.repository, clock: this.clock };
  }

  async create(
    actor: UserId,
    command: CreateSocietyCommand,
  ): Promise<CreatedSociety> {
    return unwrap(createSociety(this.deps, actor, command));
  }

  async list(actor: UserId): Promise<readonly SocietySummary[]> {
    return unwrap(listSocietySummaries(this.deps, actor));
  }

  /**
   * The public lookup. No actor: a join code is a capability, so possessing it
   * *is* the authorisation, and the repository runs this one under the anonymous
   * identity (grants, no user).
   */
  async lookupJoinCode(code: string): Promise<SocietyJoinPreview | null> {
    return unwrap(lookupJoinCode(this.deps, code));
  }

  async profile(actor: UserId, id: SocietyId): Promise<SocietyProfileView> {
    return unwrap(getSocietyProfile(this.deps, actor, id));
  }

  async update(
    actor: UserId,
    id: SocietyId,
    command: UpdateSocietyCommand,
  ): Promise<Society> {
    return unwrap(updateSociety(this.deps, actor, id, command));
  }

  async remove(actor: UserId, id: SocietyId): Promise<void> {
    return unwrap(deleteSociety(this.deps, actor, id));
  }

  async rotateJoinCode(actor: UserId, id: SocietyId): Promise<Society> {
    return unwrap(regenerateJoinCode(this.deps, actor, id));
  }

  async join(
    actor: UserId,
    command: JoinSocietyCommand,
  ): Promise<SocietyMembership> {
    return unwrap(joinSociety(this.deps, actor, command));
  }

  async leave(actor: UserId, id: SocietyId): Promise<void> {
    return unwrap(leaveSociety(this.deps, actor, id));
  }
}

/**
 * Awaits a use case and converts failure into the API's exception.
 *
 * `await` before branching, rather than `.then`, so a rejected promise (an
 * adapter throwing something the use case could not classify — the one case the
 * use cases let escape) propagates as itself and reaches the filter's
 * `INTERNAL` path, instead of being mistaken for a domain failure.
 */
async function unwrap<TValue>(
  pending: Promise<Result<TValue, SocietyError>>,
): Promise<TValue> {
  const result = await pending;
  if (!result.ok) {
    throw toAppError(result.error);
  }
  return result.value;
}
