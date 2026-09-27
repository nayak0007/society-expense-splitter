import {
  DEFAULT_MEMBER_OCCUPANCY,
  DEFAULT_MEMBER_ROLE,
  asApartmentId,
  asBuildingId,
  asMemberId,
  asSocietyId,
  asUserId,
} from "@ses/domain";
import type {
  CreateMemberInput,
  JoinApprovalInput,
  JoinRequest,
  JoinRequestPage,
  JoinRequestQuery,
  Member,
  MemberActivation,
  MemberId,
  MemberPage,
  MemberQuery,
  MemberRepository,
  MemberRole,
  MemberStatus,
  MemberOccupancy,
  SocietyId,
  UpdateMemberInput,
  UserId,
} from "@ses/domain";

import { TEST_NOW } from "../../../structure/__tests__/support/fake-building-repository";

/**
 * A hand-written fake of `MemberRepository`.
 *
 * What it deliberately does **not** do, which is the part worth reading:
 *
 *  - it does not enforce `uq_members_shadow_phone`, `uq_primary_occupant` or
 *    `chk_admin_present()`. Those are database facts that reach the caller as a classified
 *    `conflict`/`sole_admin` from the adapter, and the API's e2e suite is where they are
 *    covered. A fake that enforced them would let the adapter's classification go untested
 *    while the suite stayed green.
 *  - it does not validate a status transition. `setStatus` writes what it is given, so the
 *    *use case's* transition rule is the thing under test.
 *
 * What it does reproduce, because a use case is allowed to rely on it:
 *
 *  - a member is addressable only by the pair `(id, societyId)`, so one belonging to another
 *    society is unreachable rather than merely unauthorised (PRD T041);
 *  - `findById` and `findViewer` see live rows only, while `findViewer` returns every status
 *    except `removed` — the asymmetry the port documents and the reason this module does not
 *    reuse the society module's membership reader;
 *  - `update` distinguishes absent (`undefined` = unchanged) from `null` (= clear), which is
 *    the rule that makes the patch API honest. Spreading the patch would erase it and turn
 *    `{ phone: null }` into a no-op no test would notice;
 *  - `list` applies the filters, the ordering and the paging, and reports the total the
 *    filters produced rather than the number of rows returned.
 *
 * Every call is recorded, so a test can assert the cheap and useful thing: that validation
 * happens before any I/O.
 */

export type MemberRepositoryMethod =
  | "list"
  | "findById"
  | "findViewer"
  | "findLiveShadowByPhone"
  | "create"
  | "update"
  | "setStatus"
  | "setRole"
  | "countActiveByRole"
  | "listJoinRequests"
  | "approveJoinRequest"
  | "rejectJoinRequest"
  | "remove";

export interface SeedMemberSpec {
  readonly id?: string;
  readonly userId?: string | null;
  readonly apartmentId?: string | null;
  readonly apartmentNumber?: string | null;
  readonly buildingId?: string | null;
  readonly buildingName?: string | null;
  readonly floor?: number | null;
  readonly displayName?: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly role?: MemberRole;
  readonly status?: MemberStatus;
  readonly occupancy?: MemberOccupancy;
  readonly isPrimary?: boolean;
  readonly leaseStart?: string | null;
  readonly leaseEnd?: string | null;
  readonly shareContact?: boolean;
  /** T049 — the request's own fields, so a queue test can seed what a requester wrote. */
  readonly requestNote?: string | null;
  readonly rejectionReason?: string | null;
  readonly rejectedAt?: string | null;
  readonly createdAt?: string;
}

export class FakeMemberRepository implements MemberRepository {
  private readonly members = new Map<MemberId, Member>();
  private readonly created: CreateMemberInput[] = [];
  private readonly updated: UpdateMemberInput[] = [];
  private readonly statuses: MemberActivation[] = [];
  private readonly roles: {
    readonly id: MemberId;
    readonly role: MemberRole;
  }[] = [];
  private readonly approvals: {
    readonly id: MemberId;
    readonly input: JoinApprovalInput;
  }[] = [];
  private readonly rejections: string[] = [];
  private readonly recorded: MemberRepositoryMethod[] = [];
  private readonly failures = new Map<MemberRepositoryMethod, unknown>();
  private sequence = 0;

  // ── test-support surface ────────────────────────────────────────────────────

  /** Insert a member directly, bypassing every rule. */
  seedMember(societyId: string, spec: SeedMemberSpec = {}): Member {
    this.sequence += 1;
    const apartmentId = spec.apartmentId ?? null;
    const member: Member = {
      id: asMemberId(spec.id ?? `member-${this.sequence}`),
      societyId: asSocietyId(societyId),
      userId:
        spec.userId === undefined
          ? null
          : spec.userId === null
            ? null
            : asUserId(spec.userId),
      apartmentId: apartmentId === null ? null : asApartmentId(apartmentId),
      apartment:
        apartmentId === null
          ? null
          : {
              id: asApartmentId(apartmentId),
              number: spec.apartmentNumber ?? `A-${this.sequence}`,
              buildingId: asBuildingId(
                spec.buildingId ?? `building-${this.sequence}`,
              ),
              buildingName: spec.buildingName ?? `Block ${this.sequence}`,
              floor: spec.floor ?? null,
            },
      displayName: spec.displayName ?? `Member ${this.sequence}`,
      phone: spec.phone ?? null,
      email: spec.email ?? null,
      role: spec.role ?? DEFAULT_MEMBER_ROLE,
      status: spec.status ?? "active",
      occupancy: spec.occupancy ?? DEFAULT_MEMBER_OCCUPANCY,
      isPrimary: spec.isPrimary ?? false,
      leaseStart: spec.leaseStart ?? null,
      leaseEnd: spec.leaseEnd ?? null,
      shareContact: spec.shareContact ?? false,
      joinedAt: spec.status === "pending" ? null : TEST_NOW,
      approvedBy: null,
      removedAt: null,
      removedBy: null,
      requestNote: spec.requestNote ?? null,
      rejectionReason: spec.rejectionReason ?? null,
      rejectedAt: spec.rejectedAt ?? null,
      rejectedBy: null,
      createdAt: spec.createdAt ?? TEST_NOW,
      updatedAt: TEST_NOW,
    };
    this.members.set(member.id, member);
    return member;
  }

  /** Every approval handed over — the *request*, so a test can assert what was asked for. */
  approvalInputs(): readonly {
    readonly id: MemberId;
    readonly input: JoinApprovalInput;
  }[] {
    return [...this.approvals];
  }

  /** Every rejection handed over, with the reason the use case validated. */
  rejectionReasons(): readonly string[] {
    return [...this.rejections];
  }

  calls(): readonly MemberRepositoryMethod[] {
    return [...this.recorded];
  }

  callCount(method: MemberRepositoryMethod): number {
    return this.recorded.filter((entry) => entry === method).length;
  }

  /** Make the next call of `method` reject — used to test error conversion. */
  failNext(method: MemberRepositoryMethod, error: unknown): void {
    this.failures.set(method, error);
  }

  createInputs(): readonly CreateMemberInput[] {
    return [...this.created];
  }

  /** Every update patch handed over — the *patch*, never the merged row. */
  updatePatches(): readonly UpdateMemberInput[] {
    return [...this.updated];
  }

  statusWrites(): readonly MemberActivation[] {
    return [...this.statuses];
  }

  /** Every role write handed over — the *request*, so a test can assert what was asked for. */
  roleWrites(): readonly {
    readonly id: MemberId;
    readonly role: MemberRole;
  }[] {
    return [...this.roles];
  }

  stored(id: string): Member | undefined {
    return this.members.get(asMemberId(id));
  }

  /** Every stored row, in insertion order — for assertions that search by field. */
  storedAll(): readonly Member[] {
    return [...this.members.values()];
  }

  // ── the port ────────────────────────────────────────────────────────────────

  list(
    societyId: SocietyId,
    _actor: UserId,
    query: MemberQuery,
  ): Promise<MemberPage> {
    this.recorded.push("list");
    this.throwIfArmed("list");

    const filtered = [...this.members.values()]
      .filter((member) => member.societyId === societyId)
      // Live rows by default; the `removed` rows stay reachable when a caller asks for
      // that status explicitly, which is what the port documents.
      .filter((member) =>
        query.status === undefined
          ? member.status !== "removed"
          : member.status === query.status,
      )
      .filter((member) =>
        query.role === undefined ? true : member.role === query.role,
      )
      .filter((member) =>
        query.occupancy === undefined
          ? true
          : member.occupancy === query.occupancy,
      )
      .filter((member) =>
        query.apartmentId === undefined
          ? true
          : member.apartmentId === query.apartmentId,
      )
      .filter((member) =>
        query.buildingId === undefined
          ? true
          : member.apartment?.buildingId === query.buildingId,
      )
      .filter((member) => matchesQuery(member, query.query));

    const sorted = [...filtered].sort((left, right) => {
      if (query.sort === "joined") {
        return (right.joinedAt ?? "").localeCompare(left.joinedAt ?? "");
      }
      return (
        left.displayName.localeCompare(right.displayName) ||
        left.id.localeCompare(right.id)
      );
    });

    const limit = query.limit ?? sorted.length;
    const offset = query.offset ?? 0;
    return Promise.resolve({
      members: sorted.slice(offset, offset + limit),
      total: sorted.length,
    });
  }

  findById(
    id: MemberId,
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<Member | null> {
    this.recorded.push("findById");
    this.throwIfArmed("findById");
    return Promise.resolve(this.live(id, societyId) ?? null);
  }

  findViewer(societyId: SocietyId, actor: UserId): Promise<Member | null> {
    this.recorded.push("findViewer");
    this.throwIfArmed("findViewer");
    const found = [...this.members.values()].find(
      (member) =>
        member.societyId === societyId &&
        member.userId === actor &&
        member.status !== "removed",
    );
    return Promise.resolve(found ?? null);
  }

  findLiveShadowByPhone(
    societyId: SocietyId,
    phone: string,
    _actor: UserId,
    exceptId?: MemberId,
  ): Promise<Member | null> {
    this.recorded.push("findLiveShadowByPhone");
    this.throwIfArmed("findLiveShadowByPhone");
    const found = [...this.members.values()].find(
      (member) =>
        member.societyId === societyId &&
        member.userId === null &&
        member.phone === phone &&
        member.status !== "removed" &&
        member.id !== exceptId,
    );
    return Promise.resolve(found ?? null);
  }

  create(
    societyId: SocietyId,
    input: CreateMemberInput,
    _actor: UserId,
  ): Promise<Member> {
    this.recorded.push("create");
    this.throwIfArmed("create");
    this.created.push(input);

    this.sequence += 1;
    const created: Member = {
      id: asMemberId(`created-${this.sequence}`),
      societyId,
      // No account: the whole point of the direct-add path.
      userId: null,
      apartmentId: input.apartmentId ?? null,
      apartment: null,
      displayName: input.displayName,
      phone: input.phone,
      email: input.email ?? null,
      role: DEFAULT_MEMBER_ROLE,
      status: "active",
      occupancy: input.occupancy ?? DEFAULT_MEMBER_OCCUPANCY,
      isPrimary: input.isPrimary ?? false,
      leaseStart: input.leaseStart ?? null,
      leaseEnd: input.leaseEnd ?? null,
      shareContact: input.shareContact ?? false,
      joinedAt: TEST_NOW,
      approvedBy: null,
      removedAt: null,
      removedBy: null,
      requestNote: null,
      rejectionReason: null,
      rejectedAt: null,
      rejectedBy: null,
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW,
    };
    this.members.set(created.id, created);
    return Promise.resolve(created);
  }

  update(
    id: MemberId,
    societyId: SocietyId,
    input: UpdateMemberInput,
    _actor: UserId,
  ): Promise<Member> {
    this.recorded.push("update");
    this.throwIfArmed("update");
    this.updated.push(input);

    const existing = this.live(id, societyId);
    if (existing === undefined) {
      return Promise.reject(new Error("No such member."));
    }

    // Key *presence* is the signal: `undefined` never reaches this fake because the use case
    // builds the patch with conditional spreads, so `in` is the honest test.
    const patch = input as Record<string, unknown>;
    const next: Member = {
      ...existing,
      ...(("displayName" in patch
        ? { displayName: input.displayName }
        : {}) as object),
      ...("phone" in patch ? { phone: input.phone ?? null } : {}),
      ...("email" in patch ? { email: input.email ?? null } : {}),
      ...(("occupancy" in patch
        ? { occupancy: input.occupancy }
        : {}) as object),
      ...("apartmentId" in patch
        ? { apartmentId: input.apartmentId ?? null }
        : {}),
      ...("isPrimary" in patch ? { isPrimary: input.isPrimary } : {}),
      ...("leaseStart" in patch
        ? { leaseStart: input.leaseStart ?? null }
        : {}),
      ...("leaseEnd" in patch ? { leaseEnd: input.leaseEnd ?? null } : {}),
      ...("shareContact" in patch ? { shareContact: input.shareContact } : {}),
      updatedAt: TEST_NOW,
    } as Member;

    this.members.set(next.id, next);
    return Promise.resolve(next);
  }

  setStatus(
    id: MemberId,
    societyId: SocietyId,
    status: MemberActivation,
    _actor: UserId,
  ): Promise<Member> {
    this.recorded.push("setStatus");
    this.throwIfArmed("setStatus");
    this.statuses.push(status);

    const existing = this.live(id, societyId);
    if (existing === undefined) {
      return Promise.reject(new Error("No such member."));
    }
    const next: Member = {
      ...existing,
      status,
      joinedAt:
        status === "active" && existing.joinedAt === null
          ? TEST_NOW
          : existing.joinedAt,
      updatedAt: TEST_NOW,
    };
    this.members.set(next.id, next);
    return Promise.resolve(next);
  }

  /**
   * Set a role. Writes what it is given, like `setStatus` — the *use case's* rules are what this
   * exists to test, and the caps the database enforces are covered by the API's e2e suite and the
   * RLS canary.
   *
   * `live()` is applied here as it is everywhere else in this fake, so a `removed` member is
   * unreachable: that is a property of the storage the port promises, and a use case is allowed to
   * rely on it.
   */
  setRole(
    id: MemberId,
    societyId: SocietyId,
    role: MemberRole,
    _actor: UserId,
  ): Promise<Member> {
    this.recorded.push("setRole");
    this.throwIfArmed("setRole");
    this.roles.push({ id, role });

    const existing = this.live(id, societyId);
    if (existing === undefined) {
      return Promise.reject(new Error("No such member."));
    }
    const next: Member = { ...existing, role, updatedAt: TEST_NOW };
    this.members.set(next.id, next);
    return Promise.resolve(next);
  }

  /**
   * Active holders of a role, excluding one row.
   *
   * `active` only, deliberately: PRD §2.2's caps are about members who can act, and a suspended
   * treasurer must not occupy a slot — that is the rule the use case depends on, so the fake has to
   * reproduce it or the test would pass against a fake that disagrees with Postgres.
   */
  countActiveByRole(
    societyId: SocietyId,
    role: MemberRole,
    _actor: UserId,
    exceptId?: MemberId,
  ): Promise<number> {
    this.recorded.push("countActiveByRole");
    this.throwIfArmed("countActiveByRole");

    const holders = [...this.members.values()].filter(
      (member) =>
        member.societyId === societyId &&
        member.status === "active" &&
        member.role === role &&
        member.id !== exceptId,
    );
    return Promise.resolve(holders.length);
  }

  // ── the join queue (T049) ───────────────────────────────────────────────────

  /**
   * The society's pending rows, oldest last (the repository's own order is newest first), each
   * with the other members claiming its flat.
   *
   * The claims are computed the way Postgres computes them — every live membership naming the
   * same flat, this request included, and none at all for a request without a flat — because
   * the *use case* renders them and a fake that returned an empty list would make the "both
   * claims visible" test pass while proving nothing.
   */
  listJoinRequests(
    societyId: SocietyId,
    _actor: UserId,
    query: JoinRequestQuery,
  ): Promise<JoinRequestPage> {
    this.recorded.push("listJoinRequests");
    this.throwIfArmed("listJoinRequests");

    const pending = [...this.members.values()]
      .filter(
        (member) =>
          member.societyId === societyId && member.status === "pending",
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

    const requests: JoinRequest[] = pending.map((member) => ({
      member,
      claims: [...this.members.values()].filter(
        (claim) =>
          claim.societyId === societyId &&
          claim.status !== "removed" &&
          member.apartmentId !== null &&
          claim.apartmentId === member.apartmentId,
      ),
    }));

    const limit = query.limit ?? requests.length;
    const offset = query.offset ?? 0;
    return Promise.resolve({
      requests: requests.slice(offset, offset + limit),
      total: requests.length,
    });
  }

  /**
   * Admit a pending member.
   *
   * Writes what it is given, like `setStatus` and `setRole`: the fake does **not** re-check that
   * the row is pending. That check is the `SECURITY DEFINER` function's job in production, and
   * the use case's own refusal is what the unit tests are about — a fake that enforced it too
   * would let the use case's check go untested.
   */
  approveJoinRequest(
    id: MemberId,
    societyId: SocietyId,
    input: JoinApprovalInput,
    actor: UserId,
  ): Promise<Member> {
    this.recorded.push("approveJoinRequest");
    this.throwIfArmed("approveJoinRequest");
    this.approvals.push({ id, input });

    const existing = this.live(id, societyId);
    if (existing === undefined) {
      return Promise.reject(new Error("No such member."));
    }
    const next: Member = {
      ...existing,
      status: "active",
      role: input.role ?? existing.role,
      occupancy: input.occupancy ?? existing.occupancy,
      apartmentId:
        input.apartmentId === undefined
          ? existing.apartmentId
          : input.apartmentId === null
            ? null
            : asApartmentId(input.apartmentId),
      isPrimary: input.isPrimary ?? existing.isPrimary,
      joinedAt: existing.joinedAt ?? TEST_NOW,
      approvedBy: this.viewerId(societyId, actor) ?? null,
      // The approval overrides a previous refusal, so its stamps go (the migration's own
      // behaviour — a re-ask keeps them, a decision clears them).
      rejectionReason: null,
      rejectedAt: null,
      rejectedBy: null,
      updatedAt: TEST_NOW,
    };
    this.members.set(next.id, next);
    return Promise.resolve(next);
  }

  /** Refuse a pending member, recording who decided and why. */
  rejectJoinRequest(
    id: MemberId,
    societyId: SocietyId,
    reason: string,
    actor: UserId,
  ): Promise<Member> {
    this.recorded.push("rejectJoinRequest");
    this.throwIfArmed("rejectJoinRequest");
    this.rejections.push(reason);

    const existing = this.live(id, societyId);
    if (existing === undefined) {
      return Promise.reject(new Error("No such member."));
    }
    const next: Member = {
      ...existing,
      status: "rejected",
      rejectionReason: reason,
      rejectedAt: TEST_NOW,
      rejectedBy: this.viewerId(societyId, actor) ?? null,
      updatedAt: TEST_NOW,
    };
    this.members.set(next.id, next);
    return Promise.resolve(next);
  }

  remove(id: MemberId, societyId: SocietyId, _actor: UserId): Promise<void> {
    this.recorded.push("remove");
    this.throwIfArmed("remove");

    const existing = this.live(id, societyId);
    if (existing === undefined) {
      return Promise.reject(new Error("No such member."));
    }
    // Soft: the row stays, exactly as the port promises. A hard delete here would let a use
    // case that depends on the row surviving pass its tests and fail in production.
    this.members.set(existing.id, {
      ...existing,
      status: "removed",
      removedAt: TEST_NOW,
      updatedAt: TEST_NOW,
    });
    return Promise.resolve();
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** The actor's own membership id — who a stamp names, resolved the way the SQL does. */
  private viewerId(societyId: SocietyId, actor: UserId): MemberId | undefined {
    return [...this.members.values()].find(
      (member) => member.societyId === societyId && member.userId === actor,
    )?.id;
  }

  private live(id: MemberId, societyId: SocietyId): Member | undefined {
    const member = this.members.get(id);
    if (member === undefined) return undefined;
    if (member.societyId !== societyId) return undefined;
    if (member.status === "removed") return undefined;
    return member;
  }

  private throwIfArmed(method: MemberRepositoryMethod): void {
    const armed = this.failures.get(method);
    if (armed !== undefined) {
      this.failures.delete(method);
      throw armed;
    }
  }
}

/** Name, phone suffix and flat number — the three things a person searches a roster by. */
function matchesQuery(member: Member, query: string | undefined): boolean {
  if (query === undefined || query.trim().length === 0) return true;
  const needle = query.trim().toLowerCase();
  if (member.displayName.toLowerCase().includes(needle)) return true;
  if (
    member.phone !== null &&
    member.phone.replace(/\D/g, "").endsWith(needle)
  ) {
    return true;
  }
  const flat = member.apartment?.number.toLowerCase();
  return flat !== undefined && flat === needle;
}
