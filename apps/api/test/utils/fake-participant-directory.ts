import {
  asApartmentId,
  asBuildingId,
  asMemberId,
  asSocietyId,
  asUserId,
} from "@ses/domain";
import type {
  BuildingId,
  ExpenseMemberNameReader,
  ExpenseParticipantReader,
  ExpenseSocietyPolicy,
  ExpenseSocietyReader,
  MemberId,
  MemberRole,
  MembershipStatus,
  OccupancyType,
  ParticipantApartment,
  ParticipantMember,
  ParticipantWing,
  SocietyId,
  SocietyMembership,
  SocietyParticipantDirectory,
  StructureMembershipReader,
  UserId,
} from "@ses/domain";

/**
 * The participant-resolution reads, in memory — the T064 e2e suite's world.
 *
 * ## What is faked, and what is emphatically not
 *
 * Only storage: the four projections a resolution reads (`apartments`, `members`,
 * `wings`, `buildings`), the society's `bill_vacant_flats` policy, and the caller's
 * membership. Everything above this object runs for real — the guard chain, the contract
 * schema, the resolver use case, the owner-only composition, the preview use case, the
 * engine, the mapper and the envelope. A fake at *this* boundary therefore still fails
 * when a rule regresses; the resolution rules themselves are the domain's and are
 * asserted there and in the integration suite against real SQL.
 *
 * It reproduces exactly what the ports promise: a directory is addressed by society (a
 * member of one society can never see another's flats), a membership is returned even when
 * it is pending or removed (the use cases distinguish those, the fake does not), and the
 * vacancy policy is a value the test sets, never one a request could assert.
 *
 * It deliberately does **not** apply eligibility, routing or ordering — a fake that
 * resolved anything would let a broken resolver pass.
 *
 * ## T066's fourth port
 *
 * `listMemberNames` was added here rather than in a fake of its own because it answers
 * a question about the *same* rows this class already seeds: `members`. The
 * production binding is `useExisting` to the participant adapter for exactly that
 * reason, and a separate fake would need a second copy of every member fixture —
 * which is the drift a world-object fake exists to prevent. The name it returns is
 * the participant's own `displayName` when the fixture sets one and the id otherwise,
 * so a suite that asserts "the snapshot recorded the name at publish time" controls
 * both halves with one seed.
 */

/** A uuid-shaped id from a readable label — the domain suites' own helper shape. */
export function id(label: string): string {
  const hex = [...label]
    .map((character) => character.charCodeAt(0).toString(16))
    .join("")
    .slice(0, 12)
    .padEnd(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

export interface MembershipSeed {
  readonly userId: string;
  readonly role: MemberRole;
  readonly status?: MembershipStatus;
  readonly occupancyType?: OccupancyType;
}

export interface DirectorySeed {
  readonly apartments?: readonly ParticipantApartment[];
  readonly members?: readonly ParticipantMember[];
  readonly wings?: readonly ParticipantWing[];
  readonly buildings?: readonly BuildingId[];
}

const EMPTY_DIRECTORY: SocietyParticipantDirectory = {
  apartments: [],
  members: [],
  wings: [],
  buildings: [],
};

export function apartmentFixture(
  label: string,
  overrides: Partial<ParticipantApartment> = {},
): ParticipantApartment {
  return {
    id: asApartmentId(id(label)),
    buildingId: asBuildingId(id("building-1")),
    wingId: null,
    apartmentNumber: label.replace(/^ap-/, ""),
    floor: 1,
    bhk: 2,
    carpetAreaSqft: 700,
    builtupAreaSqft: 875,
    parkingSlots: 1,
    shareUnits: 1,
    occupancyStatus: "owner_occupied",
    isBillable: true,
    ...overrides,
  };
}

export function memberFixture(
  label: string,
  apartmentLabel: string,
  overrides: Partial<ParticipantMember> = {},
): ParticipantMember {
  return {
    id: asMemberId(id(label)),
    apartmentId: asApartmentId(id(apartmentLabel)),
    occupancy: "owner_occupied",
    isPrimary: true,
    ...overrides,
  };
}

export class FakeParticipantDirectory
  implements
    ExpenseParticipantReader,
    ExpenseSocietyReader,
    StructureMembershipReader,
    ExpenseMemberNameReader
{
  private readonly memberships = new Map<string, SocietyMembership>();
  private readonly directories = new Map<string, SocietyParticipantDirectory>();
  private readonly policies = new Map<string, boolean>();
  private readonly memberNames = new Map<string, string>();

  /** Every port call, in order — so a test can assert that a refusal cost no read. */
  readonly calls: string[] = [];

  seedMembership(societyId: string, seed: MembershipSeed): void {
    const membership: SocietyMembership = {
      id: asMemberId(id(`member-${seed.userId}`)),
      societyId: asSocietyId(societyId),
      userId: asUserId(seed.userId),
      role: seed.role,
      status: seed.status ?? "active",
      occupancyType: seed.occupancyType ?? "owner",
      joinedAt: null,
    };
    this.memberships.set(`${societyId}:${seed.userId}`, membership);
  }

  seedDirectory(societyId: string, seed: DirectorySeed): void {
    this.directories.set(societyId, {
      apartments: seed.apartments ?? [],
      members: seed.members ?? [],
      wings: seed.wings ?? [],
      buildings: seed.buildings ?? [asBuildingId(id("building-1"))],
    });
  }

  seedBillVacantFlats(societyId: string, value: boolean): void {
    this.policies.set(societyId, value);
  }

  /** The display name one member's publish snapshot will record. */
  seedMemberName(memberId: MemberId, name: string): void {
    this.memberNames.set(memberId, name);
  }

  reset(): void {
    this.memberships.clear();
    this.directories.clear();
    this.policies.clear();
    this.memberNames.clear();
    this.calls.length = 0;
  }

  callsOf(method: string): number {
    return this.calls.filter((call) => call === method).length;
  }

  async findMembership(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyMembership | null> {
    this.calls.push("findMembership");
    return this.memberships.get(`${societyId}:${actor}`) ?? null;
  }

  async listSocietyParticipants(
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<SocietyParticipantDirectory> {
    this.calls.push("listSocietyParticipants");
    return this.directories.get(societyId) ?? EMPTY_DIRECTORY;
  }

  async findById(
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<ExpenseSocietyPolicy | null> {
    this.calls.push("findById");
    const policy = this.policies.get(societyId);
    return policy === undefined
      ? null
      : { settings: { billVacantFlats: policy } };
  }

  async listMemberNames(
    societyId: SocietyId,
    memberIds: readonly MemberId[],
    _actor: UserId,
  ): Promise<ReadonlyMap<MemberId, string>> {
    this.calls.push("listMemberNames");
    // Scoped to the society's own roster, so a member of another society cannot be
    // named through this fake — the tenancy the real adapter gets from its join.
    const roster = new Set(
      (this.directories.get(societyId)?.members ?? []).map(
        (member) => member.id,
      ),
    );

    const names = new Map<MemberId, string>();
    for (const memberId of memberIds) {
      if (!roster.has(memberId)) continue;
      names.set(memberId, this.memberNames.get(memberId) ?? memberId);
    }
    return names;
  }
}
