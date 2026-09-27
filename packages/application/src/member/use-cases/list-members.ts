import {
  DEFAULT_MEMBER_PAGE_LIMIT,
  MAX_MEMBER_PAGE_LIMIT,
  asMemberError,
  err,
  ok,
  toMemberView,
} from "@ses/domain";
import type {
  Member,
  MemberCapabilities,
  MemberError,
  MemberQuery,
  MemberView,
  Result,
  SocietyId,
  UserId,
} from "@ses/domain";

import { loadMemberContext, requireMemberCapability } from "./support";
import type { MemberDeps } from "./support";

/**
 * The society's member directory, with search, filters and paging — PRD §3.3's "Member
 * Directory: searchable list with flat number, role badge, occupancy" and the Roadmap's
 * "Listing filters by role, status, building and occupancy".
 *
 * ## Why search is this use case and not its own
 *
 * The prompt this module answers listed "Search Members" as an operation, and it is one — a
 * *filter* of this read, not a second read. Giving it its own use case would mean a second
 * SQL query with its own ordering, its own paging and its own capability check, all of which
 * would have to stay in step with this one's; the thing a user actually expects from a
 * search box is that the list they are looking at narrows. `query` is a field of
 * `MemberQuery`, matched by the repository against name, phone and flat number.
 *
 * ## Why the reading role is checked here and not only in SQL
 *
 * The repository's query runs under RLS, which already returns the roster to an active
 * member — so for them this guard changes no outcome. It changes the *answer*: a Guest holds
 * no `member.view` in the matrix, and a pending member's own RLS branch shows them exactly
 * one row, so both would see a plausible one-row (or empty) society rather than being told
 * their role cannot read the directory. "Nobody has joined yet" and "not for you" must not
 * be the same screen.
 *
 * ## The capabilities travel with the page
 *
 * Because that is where they are used: a list screen decides whether the "Add member"
 * affordance and each row's edit/suspend/remove actions exist at all, and computing that
 * from a role string in the screen is exactly what SAD §9.3 forbids.
 */
export interface MemberDirectory {
  readonly members: readonly MemberView[];
  /** Rows the filters matched, not rows returned — "showing 50 of 340". */
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly capabilities: MemberCapabilities;
}

/**
 * The page bounds, resolved here rather than trusted.
 *
 * The contract defaults and clamps the same two values for an HTTP caller, and this repeats
 * the work for the mobile client, which calls this use case directly: a `limit` of 10000
 * arriving from a screen would otherwise become a `LIMIT 10000` on a query whose whole cost
 * model assumes a page. `Math.max(1, …)` rather than a rejection for the same reason
 * `common/pagination.ts` gives — over-max is a client asking for too much (safe to trim),
 * while a nonsense floor is worth failing on later rather than silently guessing at.
 */
function resolvePage(query: MemberQuery): {
  readonly limit: number;
  readonly offset: number;
} {
  const requested = query.limit ?? DEFAULT_MEMBER_PAGE_LIMIT;
  const limit = Math.min(
    MAX_MEMBER_PAGE_LIMIT,
    Math.max(
      1,
      Math.trunc(
        Number.isFinite(requested) ? requested : DEFAULT_MEMBER_PAGE_LIMIT,
      ),
    ),
  );
  const offset = Math.max(0, Math.trunc(query.offset ?? 0));
  return { limit, offset: Number.isFinite(offset) ? offset : 0 };
}

export async function listMembers(
  deps: MemberDeps,
  actor: UserId,
  societyId: SocietyId,
  query: MemberQuery = {},
): Promise<Result<MemberDirectory, MemberError>> {
  const loaded = await loadMemberContext(deps, actor, societyId);
  if (!loaded.ok) return loaded;

  const guard = requireMemberCapability(
    loaded.value.capabilities,
    "canView",
    loaded.value.viewer.status === "active"
      ? "Your role in this society cannot view its members."
      : "Your membership in this society is not active.",
  );
  if (!guard.ok) return guard;

  const { limit, offset } = resolvePage(query);

  try {
    // Ordering, filtering and the total are the repository's: doing any of them here would
    // mean sorting a page that the database already chose rows for, which is the same
    // answer for the first page and the wrong one for the second.
    const page = await deps.members.list(societyId, actor, {
      ...query,
      limit,
      offset,
    });

    return ok({
      // Redacted row by row, not once for the caller: consent is a property of the member
      // being read (`share_contact`), so two neighbours on one page can legitimately have
      // different visibility.
      members: page.members.map((member: Member) =>
        toMemberView(loaded.value.viewer, member),
      ),
      total: page.total,
      limit,
      offset,
      capabilities: loaded.value.capabilities,
    });
  } catch (error: unknown) {
    return err(asMemberError(error));
  }
}
