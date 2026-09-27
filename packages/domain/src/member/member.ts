import { MEMBER_ROLES } from "../society/society";
import type { MemberRole } from "../society/society";
import type {
  ApartmentId,
  BuildingId,
  MemberId,
  SocietyId,
  UserId,
} from "../shared/ids";

/**
 * Member entity + value unions (PRD §3.3, §7 `members`; SAD §8.2).
 *
 * A `Member` is a **membership**: the join between a user and a society, and the
 * only place a role exists. PRD §2 says it plainly — "One user may be a Resident
 * in Society A and a Treasurer in Society B" — which is why every field here is
 * scoped by `societyId` and why the entity is not called `User`.
 *
 * ## Why this is not `SocietyMembership`
 *
 * `SocietyMembership` (in `society/society.ts`) is what the *society* module needs
 * to render a switcher and evaluate its own capabilities: an id, a role, a
 * three-state status and a `UserId`. Two of its simplifications are deliberate and
 * both are load-bearing for the society module, and both are wrong here:
 *
 *  - **its `userId` is required**, so a *shadow member* — an owner recorded by an
 *    Admin before they had an account, PRD §3.3, "essential, since many owners never
 *    install the app but must still be billed" — cannot be represented at all
 *    (`society.rows.ts` filters them out of every roster read);
 *  - **its status union is three-valued** (`pending | active | removed`), with
 *    `inactive` and `rejected` collapsed onto `removed`.
 *
 * The directory has to show exactly the rows the roster read drops and distinguish
 * exactly the states it folds, so it gets its own entity rather than widening one
 * whose narrowness is used elsewhere. The mapping between the two stays one-way:
 * `SocietyMembership` is derivable from a `Member` with a `user_id`, never the
 * reverse.
 *
 * ## The statuses are the database's, in the database's order
 *
 * PRD §7.1 defines `member_status AS ENUM ('pending','active','inactive','removed',
 * 'rejected')`. That list is reproduced verbatim — not renamed, not reordered, not
 * collapsed — because the domain's vocabulary is the contract the SQL, the wire
 * schema and the UI all read, and a synonym in one of them is a translation table
 * that will eventually disagree with itself (the reason `society.rows.ts` has to
 * carry a `committee`/`committee_member` map today).
 *
 * Two readings worth stating, because a later task will look for them:
 *  - **Suspended is `inactive`.** The prompt that asked for this module listed
 *    "Suspended" as a state; the PRD's word for it is `inactive`, and a member
 *    suspended by an Admin is exactly a member who is still attached to the society
 *    but may not act.
 *  - **Left is `removed`.** PRD §3.3: "soft removal → status = 'removed',
 *    `removed_at`, `removed_by`". Leaving and being removed are the same row state
 *    reached by two different actors, distinguished by `removed_by` — which is why
 *    the society module's `leaveSociety` and this module's `removeMember` share one
 *    storage transition rather than two columns.
 */

// Re-exported rather than redeclared: one role union for the whole system, the one
// `permission-evaluator.ts` keys its matrix on.
export { MEMBER_ROLES };
export type { MemberRole };

/** PRD §7.1, verbatim. */
export const MEMBER_STATUSES = [
  "pending",
  "active",
  "inactive",
  "removed",
  "rejected",
] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/**
 * PRD §7.1 `occupancy_type`, verbatim.
 *
 * Not to be confused with the *join* declaration (`OCCUPANCY_TYPES` in
 * `society/society.ts`: `owner | tenant | family_member`), which is what a person
 * says about themselves at the join screen. This is the stored value, and it has
 * one extra member the join flow cannot express: `vacant_owner`, an owner who lives
 * elsewhere. PRD §3.3 says that distinction "drives which charge heads apply and who
 * receives which notifications", so it has to survive storage.
 */
export const MEMBER_OCCUPANCIES = [
  "owner_occupied",
  "tenant",
  "family_member",
  "vacant_owner",
] as const;
export type MemberOccupancy = (typeof MEMBER_OCCUPANCIES)[number];

/**
 * The occupancies that may hold a flat's primary claim.
 *
 * Mirrors the predicate of `uq_primary_occupant` in
 * `supabase/migrations/20260925120000_members_directory.sql` exactly, including that
 * a `vacant_owner` counts as the owner. Exported so the rule the use cases enforce
 * and the rule the index enforces are one list rather than two.
 */
export const PRIMARY_OCCUPANCIES: readonly MemberOccupancy[] = [
  "owner_occupied",
  "tenant",
  "vacant_owner",
];

/** `members.display_name varchar(120)` (PRD §7). */
export const MEMBER_NAME_MAX_LENGTH = 120;
/** `members.phone varchar(16)` — an E.164 number with the `+` fits. */
export const MEMBER_PHONE_MAX_LENGTH = 16;
/** The RFC's practical ceiling, and what the column will hold. */
export const MEMBER_EMAIL_MAX_LENGTH = 254;
/** Bound on the directory's `q` parameter, so a scan stays bounded. */
export const MEMBER_SEARCH_MAX_LENGTH = 120;

/** The column default of `role`; a shadow member is an ordinary resident. */
export const DEFAULT_MEMBER_ROLE: MemberRole = "resident";
/** The column default of `occupancy` (PRD §7). */
export const DEFAULT_MEMBER_OCCUPANCY: MemberOccupancy = "owner_occupied";

/**
 * Directory paging defaults.
 *
 * A member directory is a *human* list — it is read by scrolling, not by a machine
 * — so the page is larger than the API's generic 20 (`common/pagination.ts`) and
 * the ceiling is explicit. Both are exported so the contract, the UI's "showing 50
 * of 340" copy and the SQL `LIMIT` cannot disagree about where the boundary is.
 */
export const DEFAULT_MEMBER_PAGE_LIMIT = 50;
export const MAX_MEMBER_PAGE_LIMIT = 200;

/**
 * Directory orderings, named for what a human is looking for.
 *
 * `name` is the default because it is the only order that makes a *search*
 * predictable — the answer stays in the same place after every filter change — and
 * `joined` exists for the one question that needs recency: "who has joined lately?"
 * for an Admin reviewing the roster. Deliberately a closed union rather than a
 * column name: the value selects a fixed SQL expression, so no client string ever
 * reaches an `ORDER BY`.
 */
export const MEMBER_SORTS = ["name", "joined"] as const;
export type MemberSort = (typeof MEMBER_SORTS)[number];

/**
 * The flat a membership occupies, as the directory renders it.
 *
 * A nested object rather than three loose fields, because the three are null
 * together or present together — a `null` apartment is "this member has no flat
 * recorded yet" (a shadow member added before the flats were set up, or a
 * committee member who is not an occupant), and there is no state in which a
 * member has a flat number but no building.
 *
 * `buildingName` and `floor` are nullable even so: they are joined from tables that
 * can lag behind (a building removed by a repair, a floor genuinely unrecorded —
 * `apartments.floor` is nullable because "nobody wrote it down" is not zero), and a
 * directory row that rendered `null` for a whole member because one label was
 * missing would be worse than one with a partial address.
 */
export interface MemberApartment {
  readonly id: ApartmentId;
  readonly number: string;
  readonly buildingId: BuildingId;
  readonly buildingName: string | null;
  readonly floor: number | null;
}

/**
 * One membership, whole.
 *
 * Nullability mirrors the columns deliberately (as elsewhere in this package): the
 * entity is the contract between the API, the local cache and the UI, so a rename
 * or a nullability change here is a migration there.
 */
export interface Member {
  readonly id: MemberId;
  readonly societyId: SocietyId;
  /**
   * `null` = a shadow member: an occupant recorded by an Admin, with no account
   * until they sign up (PRD §3.3). The single most important nullability in this
   * module — it is why `Member` exists next to `SocietyMembership`.
   */
  readonly userId: UserId | null;
  readonly apartmentId: ApartmentId | null;
  readonly apartment: MemberApartment | null;
  readonly displayName: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly role: MemberRole;
  readonly status: MemberStatus;
  readonly occupancy: MemberOccupancy;
  /** The flat's primary owner or tenant — at most one of each per flat. */
  readonly isPrimary: boolean;
  readonly leaseStart: string | null;
  readonly leaseEnd: string | null;
  /**
   * PRD §3.3's consent flag for the directory, default **off**. Governs whether
   * *other members* may see this member's contact details; see
   * `canViewMemberContact()` for what it does and does not cover.
   */
  readonly shareContact: boolean;
  readonly joinedAt: string | null;
  readonly approvedBy: MemberId | null;
  readonly removedAt: string | null;
  readonly removedBy: MemberId | null;
  /**
   * The note the requester attached to their join request (T049), or `null`.
   *
   * On the membership because the membership *is* the request (`join-requests.ts`), and because
   * the note is the context a reviewer needs beside the row they are deciding — a separate
   * relation would have to be joined into every queue read to say the same thing.
   */
  readonly requestNote: string | null;
  /**
   * Why the request was refused (T049), or `null`.
   *
   * Kept after a re-ask, deliberately: the next reviewer sees what the last one decided,
   * which is the context a corrected claim arrives with. An approval clears it, because a
   * row that is `active` and carries a rejection reason reads as though it were still being
   * argued about.
   */
  readonly rejectionReason: string | null;
  readonly rejectedAt: string | null;
  readonly rejectedBy: MemberId | null;
  /** When the request was made — the row's own creation time. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A member as one particular viewer may see them.
 *
 * `Member` plus one derived fact: whether `phone`/`email` were *withheld* rather
 * than absent. That distinction is the whole reason this type exists — a UI that
 * renders `null` as "no phone on file" when the truth is "this member has not
 * consented to share it" tells the user a lie about their own society's data. The
 * flag is computed in the domain, next to the rule, so the server and the client
 * cannot disagree about it (SAD §9.3).
 */
export type MemberView = Omit<Member, "phone" | "email"> & {
  readonly phone: string | null;
  readonly email: string | null;
  readonly contactVisible: boolean;
};

/**
 * The directory's query — filters, order and page in one object.
 *
 * Every field is optional because every one of them is a *narrowing*: the default is
 * the whole live roster, in name order, first page. `removed` is the one status that
 * is excluded by default and included on request — PRD §3.3 keeps a removed member's
 * history ("Financial history is never deleted"), so the rows stay reachable, but a
 * directory that showed them beside current residents by default would be a roster
 * nobody trusts.
 */
export interface MemberQuery {
  readonly role?: MemberRole | undefined;
  readonly status?: MemberStatus | undefined;
  readonly occupancy?: MemberOccupancy | undefined;
  /** Only members attached to a flat in this building. */
  readonly buildingId?: BuildingId | undefined;
  readonly apartmentId?: ApartmentId | undefined;
  /** Free text, matched against name, phone and flat number. */
  readonly query?: string | undefined;
  readonly sort?: MemberSort | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

/** One page of the directory, with the total the filters produced. */
export interface MemberPage {
  readonly members: readonly Member[];
  /**
   * Rows matching the filters, **not** rows returned: the count is what lets the UI
   * say "showing 50 of 340" and size its scrollbar. It arrives in the same
   * statement as the page (`count(*) OVER ()`), so it costs no second round trip.
   */
  readonly total: number;
}

/**
 * The admin direct-add path (PRD §3.3: "name + phone, creates a *shadow member*").
 *
 * `displayName` and `phone` are required and everything else is not, which is the
 * PRD's own list: a society recording an owner who never installs the app knows
 * their name and their number, and frequently nothing else. Requiring an email
 * would make the path unusable for the case it exists for.
 */
export interface CreateMemberInput {
  readonly displayName: string;
  readonly phone: string;
  readonly email?: string | null | undefined;
  readonly occupancy?: MemberOccupancy | undefined;
  readonly apartmentId?: ApartmentId | null | undefined;
  readonly isPrimary?: boolean | undefined;
  readonly leaseStart?: string | null | undefined;
  readonly leaseEnd?: string | null | undefined;
  readonly shareContact?: boolean | undefined;
}

/**
 * Partial update, with the same two-modifier shape `UpdateApartmentInput` uses: an
 * **absent** field is unchanged and an explicit **`null`** clears it.
 *
 * That distinction is not decoration here. A phone number is a shadow member's only
 * identifier (`uq_members_shadow_phone`), so a society that recorded a wrong one
 * needs to *clear* it — and with a `coalesce($1, column)` write there is no way to
 * say that, only "leave the wrong one in place".
 */
export interface UpdateMemberInput {
  readonly displayName?: string | undefined;
  readonly phone?: string | null | undefined;
  readonly email?: string | null | undefined;
  readonly occupancy?: MemberOccupancy | undefined;
  readonly apartmentId?: ApartmentId | null | undefined;
  readonly isPrimary?: boolean | undefined;
  readonly leaseStart?: string | null | undefined;
  readonly leaseEnd?: string | null | undefined;
  readonly shareContact?: boolean | undefined;
}

/**
 * The two status transitions T045 owns.
 *
 * Narrower than `MemberStatus` on purpose. Approval (`pending → active`) and
 * rejection (`pending → rejected`) are the join queue's transitions (T049), and
 * removal is `remove` rather than a status write, so neither can be expressed by
 * reaching for this type by accident.
 */
export type MemberActivation = "active" | "inactive";
