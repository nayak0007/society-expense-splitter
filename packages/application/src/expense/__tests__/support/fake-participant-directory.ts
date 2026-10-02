import {
  asApartmentId,
  asBuildingId,
  asMemberId,
  asSocietyId,
  asUserId,
} from "@ses/domain";
import type {
  BuildingId,
  ExpenseMembershipReader,
  ExpenseParticipantReader,
  ExpenseSocietyPolicy,
  ExpenseSocietyReader,
  MemberRole,
  MembershipStatus,
  OccupancyType,
  ParticipantApartment,
  ParticipantMember,
  ParticipantWing,
  SocietyId,
  SocietyMembership,
  SocietyParticipantDirectory,
  UserId,
} from "@ses/domain";

/**
 * A hand-written fake of the three reads the participant-resolution use case depends on.
 *
 * The ports are the seam, so a test asserts against the real call surface (`calls`,
 * `callsOf`) rather than a mocked module's internals — the same reasoning
 * `fake-category-repository.ts` records.
 *
 * What it reproduces is what the *ports promise*, and nothing more: a caller with no live
 * membership answers `null` (never `forbidden`, the 404-before-403 rule), a directory is
 * addressed by society, and a society's policy is a value the test sets rather than one
 * the use case could take from its argument. What it deliberately does **not** do is
 * apply any resolution rule: eligibility, routing and the ordering are the domain's, and
 * a fake that re-implemented them would let a broken resolution pass.
 *
 * `MAX`-shaped fixtures are not needed here — the domain suite owns the rules — so the
 * builders below exist only to keep the use-case assertions about *composition*.
 */

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

/** A uuid-shaped id from a readable label — see the domain suite's own helper. */
export function id(label: string): string {
  const hex = [...label]
    .map((character) => character.charCodeAt(0).toString(16))
    .join("")
    .slice(0, 12)
    .padEnd(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

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
    ExpenseMembershipReader
{
  private readonly memberships = new Map<string, SocietyMembership>();
  private readonly directories = new Map<string, SocietyParticipantDirectory>();
  private readonly policies = new Map<string, boolean>();

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
    actor: UserId,
  ): Promise<SocietyParticipantDirectory> {
    this.calls.push("listSocietyParticipants");
    void actor;
    return this.directories.get(societyId) ?? EMPTY_DIRECTORY;
  }

  async findById(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<ExpenseSocietyPolicy | null> {
    this.calls.push("findById");
    void actor;
    const policy = this.policies.get(societyId);
    return policy === undefined
      ? null
      : { settings: { billVacantFlats: policy } };
  }
}
