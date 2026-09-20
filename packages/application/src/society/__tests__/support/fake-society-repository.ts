import {
  DEFAULT_SOCIETY_SETTINGS,
  asMemberId,
  asSocietyId,
  asUserId,
  fixedClock,
  generateJoinCode,
  normalizeJoinCode,
  slugify,
  societyError,
} from "@ses/domain";
import type {
  Clock,
  CreateSocietyInput,
  JoinSocietyInput,
  MemberRole,
  MembershipStatus,
  OccupancyType,
  Society,
  SocietyId,
  SocietyJoinPreview,
  SocietyMembership,
  SocietyRepository,
  SocietySettings,
  SocietyType,
  UpdateSocietyInput,
  UserId,
} from "@ses/domain";

/**
 * A five-line-in-spirit fake of the `SocietyRepository` port.
 *
 * WHY A HAND-WRITTEN FAKE AND NOT `jest.mock`: the port is already the seam —
 * the domain declares what it needs and this implements exactly that, so a test
 * asserts against the real call surface (`calls()`) instead of against a
 * mocked module's internals. No module registry, no hoisting rules, no
 * `mockResolvedValue` chains; and the same file works if the API later reuses it
 * as an in-memory adapter for its own tests.
 *
 * It deliberately does NOT re-implement the domain rules (sole-admin, code
 * expiry, capability checks). Those are what the use cases under test are
 * supposed to enforce, and a fake that enforced them too would let a broken use
 * case pass. It enforces only the storage-level facts the port documents:
 * non-members see `null`/`not_found`, never `forbidden`.
 *
 * It DOES record every call, which is how tests prove the cheap, useful thing:
 * that validation happens before I/O — an invalid command never reaches the
 * repository at all.
 */

export type RepositoryMethod =
  | "listMemberships"
  | "listSocietyMemberships"
  | "findById"
  | "findJoinPreview"
  | "create"
  | "update"
  | "regenerateJoinCode"
  | "remove"
  | "join"
  | "leave";

export interface SeedMember {
  readonly userId: string;
  readonly role: MemberRole;
  readonly status?: MembershipStatus;
  readonly occupancyType?: OccupancyType;
}

export interface SeedSocietyOptions {
  readonly id?: string;
  readonly name?: string;
  readonly type?: SocietyType;
  readonly city?: string;
  readonly state?: string;
  readonly joinCode?: string;
  readonly joinCodeExpiresAt?: string | null;
  readonly settings?: Partial<SocietySettings>;
  readonly createdBy?: string;
  readonly members?: readonly SeedMember[];
}

/** Default clock instant for every seeded row: a fixed, human-readable date. */
export const TEST_NOW = "2026-09-20T10:00:00.000Z";

export class FakeSocietyRepository implements SocietyRepository {
  private readonly societies = new Map<SocietyId, Society>();
  private readonly memberships: SocietyMembership[] = [];
  private readonly updates: UpdateSocietyInput[] = [];
  private readonly recorded: RepositoryMethod[] = [];
  private readonly failures = new Map<RepositoryMethod, unknown>();
  private readonly clock: Clock;
  private readonly nextCode: () => string;
  private sequence = 0;

  constructor(
    options: { readonly clock?: Clock; readonly nextCode?: () => string } = {},
  ) {
    this.clock = options.clock ?? fixedClock(TEST_NOW);
    this.nextCode = options.nextCode ?? defaultCodes();
  }

  // ── test-support surface ───────────────────────────────────────────────────

  /** Every method this fake was asked to perform, in order. */
  calls(): readonly RepositoryMethod[] {
    return [...this.recorded];
  }

  callCount(method: RepositoryMethod): number {
    return this.recorded.filter((entry) => entry === method).length;
  }

  /** Make the next call of `method` reject — used to test error conversion. */
  failNext(method: RepositoryMethod, error: unknown): void {
    this.failures.set(method, error);
  }

  /** Insert a society and its memberships directly, bypassing every rule. */
  seedSociety(options: SeedSocietyOptions = {}): {
    readonly society: Society;
    readonly memberships: readonly SocietyMembership[];
  } {
    const id = asSocietyId(options.id ?? `society-${this.societies.size + 1}`);
    const createdAt = this.clock.nowIso();
    const members = options.members ?? [
      { userId: "user-admin", role: "admin" },
    ];

    const society = makeSociety({
      id,
      name: options.name ?? "Green Valley Residency",
      slug: slugify(options.name ?? "Green Valley Residency"),
      type: options.type ?? "apartment",
      city: options.city ?? "Pune",
      state: options.state ?? "Maharashtra",
      joinCode: options.joinCode ?? "GV4K2M",
      joinCodeExpiresAt: options.joinCodeExpiresAt ?? null,
      createdBy: asUserId(
        options.createdBy ?? members[0]?.userId ?? "user-admin",
      ),
      createdAt,
      updatedAt: createdAt,
      memberCount: members.length,
      settings: { ...DEFAULT_SOCIETY_SETTINGS, ...options.settings },
    });

    const seeded: SocietyMembership[] = members.map((member, index) =>
      makeMembership({
        id: asMemberId(`${id}-member-${index + 1}`),
        societyId: id,
        userId: asUserId(member.userId),
        role: member.role,
        status: member.status ?? "active",
        occupancyType: member.occupancyType ?? "owner",
        joinedAt: createdAt,
      }),
    );

    this.societies.set(id, society);
    this.memberships.push(...seeded);
    return { society, memberships: seeded };
  }

  putSociety(society: Society): void {
    this.societies.set(society.id, society);
  }

  /**
   * Insert a membership on its own — including one whose society does not
   * exist, which is how a test proves a dangling row is skipped rather than
   * crashing a list.
   */
  putMembership(membership: SocietyMembership): void {
    this.memberships.push(membership);
  }

  /** Every patch handed to `update`, so a test can assert the exact diff. */
  updatePatches(): readonly UpdateSocietyInput[] {
    return [...this.updates];
  }

  // ── the port ───────────────────────────────────────────────────────────────

  async listMemberships(actor: UserId): Promise<readonly SocietyMembership[]> {
    this.record("listMemberships");
    this.throwIfQueued("listMemberships");
    return this.memberships
      .filter(
        (membership) =>
          membership.userId === actor && membership.status !== "removed",
      )
      .reverse();
  }

  async listSocietyMemberships(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly SocietyMembership[]> {
    this.record("listSocietyMemberships");
    this.throwIfQueued("listSocietyMemberships");
    if (this.membershipOf(societyId, actor) === null) {
      throw societyError("not_found", "That society is not available to you.");
    }
    return this.memberships.filter(
      (membership) =>
        membership.societyId === societyId && membership.status !== "removed",
    );
  }

  async findById(id: SocietyId, actor: UserId): Promise<Society | null> {
    this.record("findById");
    this.throwIfQueued("findById");
    if (this.membershipOf(id, actor) === null) return null;
    return this.societies.get(id) ?? null;
  }

  async findJoinPreview(code: string): Promise<SocietyJoinPreview | null> {
    this.record("findJoinPreview");
    this.throwIfQueued("findJoinPreview");
    const normalized = normalizeJoinCode(code);
    for (const society of this.societies.values()) {
      if (society.joinCode === normalized) {
        return {
          id: society.id,
          name: society.name,
          city: society.city,
          state: society.state,
          type: society.type,
          memberCount: society.memberCount,
          joinCodeExpiresAt: society.joinCodeExpiresAt,
        };
      }
    }
    return null;
  }

  async create(
    input: CreateSocietyInput,
    actor: UserId,
  ): Promise<{
    readonly society: Society;
    readonly membership: SocietyMembership;
  }> {
    this.record("create");
    this.throwIfQueued("create");

    const createdAt = this.clock.nowIso();
    const society = makeSociety({
      id: asSocietyId(`society-${++this.sequence}`),
      name: input.name,
      slug: slugify(input.name),
      type: input.type,
      registrationNumber: input.registrationNumber ?? null,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city,
      state: input.state,
      pincode: input.pincode ?? null,
      joinCode: this.nextCode(),
      createdBy: actor,
      createdAt,
      updatedAt: createdAt,
      memberCount: 1,
      settings: {
        ...DEFAULT_SOCIETY_SETTINGS,
        billingDay: input.billingDay,
        dueDay: input.dueDay,
        approvalThresholdPaise: input.approvalThresholdPaise,
      },
    });

    const membership = makeMembership({
      id: asMemberId(`${society.id}-member-1`),
      societyId: society.id,
      userId: actor,
      role: "admin",
      status: "active",
      occupancyType: "owner",
      joinedAt: createdAt,
    });

    this.societies.set(society.id, society);
    this.memberships.push(membership);
    return { society, membership };
  }

  // The trailing `actor` parameter is omitted rather than ignored: the port
  // declares three arguments, TypeScript lets an implementation declare fewer,
  // and dropping it is honest about the fact that this store is not multi-tenant.
  async update(id: SocietyId, input: UpdateSocietyInput): Promise<Society> {
    this.record("update");
    this.updates.push(input);
    this.throwIfQueued("update");

    const current = this.societies.get(id);
    if (current === undefined)
      throw societyError("not_found", "Society not found.");

    // A patch is applied field by field: absent keys must leave the stored value
    // untouched, which is exactly the property the update use case is tested for.
    const cleared = (
      value: string | undefined,
      fallback: string | null,
    ): string | null =>
      value === undefined ? fallback : value.length === 0 ? null : value;

    const next: Society = {
      ...current,
      name: input.name ?? current.name,
      type: input.type ?? current.type,
      registrationNumber: cleared(
        input.registrationNumber,
        current.registrationNumber,
      ),
      addressLine1: cleared(input.addressLine1, current.addressLine1),
      addressLine2: cleared(input.addressLine2, current.addressLine2),
      city: input.city ?? current.city,
      state: input.state ?? current.state,
      pincode: cleared(input.pincode, current.pincode),
      settings: {
        ...current.settings,
        ...(input.billingDay === undefined
          ? {}
          : { billingDay: input.billingDay }),
        ...(input.dueDay === undefined ? {} : { dueDay: input.dueDay }),
        ...(input.approvalThresholdPaise === undefined
          ? {}
          : { approvalThresholdPaise: input.approvalThresholdPaise }),
      },
      updatedAt: this.clock.nowIso(),
    };

    this.societies.set(id, next);
    return next;
  }

  async regenerateJoinCode(id: SocietyId): Promise<Society> {
    this.record("regenerateJoinCode");
    this.throwIfQueued("regenerateJoinCode");

    const current = this.societies.get(id);
    if (current === undefined)
      throw societyError("not_found", "Society not found.");

    const next: Society = {
      ...current,
      joinCode: this.nextCode(),
      updatedAt: this.clock.nowIso(),
    };
    this.societies.set(id, next);
    return next;
  }

  async remove(id: SocietyId): Promise<void> {
    this.record("remove");
    this.throwIfQueued("remove");
    if (!this.societies.has(id))
      throw societyError("not_found", "Society not found.");
    this.societies.delete(id);
  }

  async join(
    input: JoinSocietyInput,
    actor: UserId,
  ): Promise<SocietyMembership> {
    this.record("join");
    this.throwIfQueued("join");

    const normalized = normalizeJoinCode(input.code);
    let target: Society | undefined;
    for (const society of this.societies.values()) {
      if (society.joinCode === normalized) target = society;
    }
    if (target === undefined)
      throw societyError("not_found", "Join code not found.");

    if (this.membershipOf(target.id, actor) !== null) {
      throw societyError(
        "conflict",
        "You are already a member of this society.",
      );
    }

    const membership = makeMembership({
      id: asMemberId(`${target.id}-member-${++this.sequence}`),
      societyId: target.id,
      userId: actor,
      // The PRD is explicit that joins are never auto-approved; the fake keeps
      // the same default so a test cannot accidentally rely on auto-approval.
      role: "resident",
      status: "pending",
      occupancyType: input.occupancyType,
      joinedAt: null,
    });

    this.memberships.push(membership);
    this.putSociety({ ...target, memberCount: target.memberCount + 1 });
    return membership;
  }

  async leave(id: SocietyId, actor: UserId): Promise<void> {
    this.record("leave");
    this.throwIfQueued("leave");

    const membership = this.membershipOf(id, actor);
    if (membership === null)
      throw societyError("not_found", "Society not found.");

    const index = this.memberships.indexOf(membership);
    if (index >= 0) this.memberships.splice(index, 1);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private membershipOf(
    societyId: SocietyId,
    actor: UserId,
  ): SocietyMembership | null {
    return (
      this.memberships.find(
        (membership) =>
          membership.societyId === societyId &&
          membership.userId === actor &&
          membership.status !== "removed",
      ) ?? null
    );
  }

  private record(method: RepositoryMethod): void {
    this.recorded.push(method);
  }

  private throwIfQueued(method: RepositoryMethod): void {
    const failure = this.failures.get(method);
    if (failure === undefined) return;
    this.failures.delete(method);
    throw failure;
  }
}

/** Deterministic, well-formed codes so a regenerated code is assertable. */
function defaultCodes(): () => string {
  let index = 0;
  const codes = ["AB2CD3", "EF4GH5", "JK6LM7", "NP8QR9", "ST2UV3", "WX4YZ5"];
  return () => {
    const code = codes[index % codes.length] ?? "AB2CD3";
    index += 1;
    return code;
  };
}

export function makeSociety(overrides: Partial<Society> = {}): Society {
  return {
    id: asSocietyId("society-1"),
    name: "Green Valley Residency",
    slug: "green-valley-residency",
    type: "apartment",
    registrationNumber: null,
    addressLine1: null,
    addressLine2: null,
    city: "Pune",
    state: "Maharashtra",
    pincode: null,
    country: "IN",
    currency: "INR",
    timezone: "Asia/Kolkata",
    joinCode: generateJoinCode(() => 0),
    joinCodeExpiresAt: null,
    plan: "free",
    createdBy: asUserId("user-admin"),
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
    deletedAt: null,
    settings: DEFAULT_SOCIETY_SETTINGS,
    memberCount: 1,
    ...overrides,
  };
}

/**
 * Test-facing factory: plain strings in, branded entity out, so a test never has
 * to write `'member-1' as SocietyMembership['id']` to satisfy the brand.
 */
export interface MembershipSpec {
  readonly id?: string;
  readonly userId?: string;
  readonly societyId?: string;
  readonly role?: MemberRole;
  readonly status?: MembershipStatus;
  readonly occupancyType?: OccupancyType;
  readonly joinedAt?: string | null;
}

export function membership(spec: MembershipSpec = {}): SocietyMembership {
  return makeMembership({
    id: asMemberId(spec.id ?? "member-1"),
    userId: asUserId(spec.userId ?? "user-admin"),
    societyId: asSocietyId(spec.societyId ?? "society-1"),
    role: spec.role ?? "admin",
    status: spec.status ?? "active",
    occupancyType: spec.occupancyType ?? "owner",
    joinedAt: spec.joinedAt === undefined ? TEST_NOW : spec.joinedAt,
  });
}

export function makeMembership(
  overrides: Partial<SocietyMembership> = {},
): SocietyMembership {
  return {
    id: asMemberId("member-1"),
    societyId: asSocietyId("society-1"),
    userId: asUserId("user-admin"),
    role: "admin",
    status: "active",
    occupancyType: "owner",
    joinedAt: TEST_NOW,
    ...overrides,
  };
}
