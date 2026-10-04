import { resolveParticipantsForExpense } from "@ses/application";
import {
  asApartmentId,
  asBuildingId,
  asExpenseCategoryId,
  asExpenseId,
  asMemberId,
  asSocietyId,
  asUserId,
  Expense,
  fixedClock,
  Money,
  paise,
  weight,
} from "@ses/domain";
import type {
  ExpenseCategory,
  ExpenseCategoryId,
  ExpenseCategoryRepository,
  ExpenseMembershipReader,
  ExpenseParticipant,
  ExpenseParticipantReader,
  ExpenseParticipantResolution,
  ExpenseSocietyReader,
  MemberId,
  OccupancyType,
  ParticipantApartment,
  ParticipantMember,
  SocietyId,
  SocietyMembership,
  SocietyParticipantDirectory,
  SplitStrategy,
  UnassignedParticipant,
  UserId,
} from "@ses/domain";
import { computeSplit, splitError } from "@ses/split-engine";
import type { SplitResult } from "@ses/split-engine";

import {
  PreviewSplitUseCase,
  buildSplitInput,
  fromSplitError,
  resolveSplitPlan,
  toPreview,
  verifyConservation,
  type ExpenseSplitPreview,
  type PreviewSplitCommand,
} from "../preview-split.use-case";

/**
 * T064's preview use case, composed with the **real** split engine.
 *
 * ## What is faked, and what is not
 *
 * Only the four read ports — membership, directory, society policy and categories — are
 * in-memory. Resolution, the owner-only composition, the engine input mapping and the
 * engine itself are the production implementations, so a wrong weight, a wrong residual
 * or a lost paisa fails here. Hand-calculated amounts are asserted on purpose (the
 * Roadmap's own test list): the point of a preview is the number, not the shape.
 *
 * The fake reproduces the ports' contract, never their rules: `findMembership` answers
 * `null` for another society (the 404-before-403 rule) and the directory is a value the
 * test sets. A fake that resolved anything would let a broken resolution pass.
 */

const SOCIETY = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const OTHER_SOCIETY = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
const ADMIN = asUserId("11111111-1111-4111-8111-111111111111");
const RESIDENT = asUserId("33333333-3333-4333-8333-333333333333");

/** A uuid-shaped id from a readable label — the domain suites' own helper shape. */
function id(label: string): string {
  const hex = [...label]
    .map((character) => character.charCodeAt(0).toString(16))
    .join("")
    .slice(0, 12)
    .padEnd(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

const BUILDING = asBuildingId(id("building-1"));

interface FlatOverrides {
  readonly floor?: number | null;
  readonly carpetAreaSqft?: number | null;
  readonly builtupAreaSqft?: number | null;
  readonly bhk?: number | null;
  readonly parkingSlots?: number;
  readonly shareUnits?: number;
  readonly occupancyStatus?: ParticipantApartment["occupancyStatus"];
  readonly isBillable?: boolean;
}

/** The four test flats: two owners, one tenant, one with nobody attached. */
function fixtureFlats(overrides: FlatOverrides = {}): ParticipantApartment[] {
  const base = (label: string, spec: FlatOverrides): ParticipantApartment => ({
    id: asApartmentId(id(label)),
    buildingId: BUILDING,
    wingId: null,
    apartmentNumber: label,
    floor: spec.floor ?? 1,
    bhk: spec.bhk ?? 2,
    carpetAreaSqft: spec.carpetAreaSqft ?? 700,
    builtupAreaSqft: spec.builtupAreaSqft ?? 875,
    parkingSlots: spec.parkingSlots ?? 0,
    shareUnits: spec.shareUnits ?? 1,
    occupancyStatus: spec.occupancyStatus ?? "owner_occupied",
    isBillable: spec.isBillable ?? true,
    ...overrides,
  });

  return [
    base("101", {
      floor: 1,
      carpetAreaSqft: 700,
      bhk: 2,
      parkingSlots: 1,
      shareUnits: 2,
    }),
    base("102", { floor: 2, carpetAreaSqft: 350, bhk: 1, shareUnits: 1 }),
    base("103", {
      floor: 2,
      carpetAreaSqft: 350,
      bhk: 1,
      shareUnits: 1,
      occupancyStatus: "rented",
    }),
    base("104", { floor: 3, carpetAreaSqft: 350, bhk: 1 }),
  ];
}

const MEMBER_101 = asMemberId(id("member-101"));
const MEMBER_102 = asMemberId(id("member-102"));
const TENANT_103 = asMemberId(id("tenant-103"));

function fixtureMembers(): ParticipantMember[] {
  return [
    {
      id: MEMBER_101,
      apartmentId: asApartmentId(id("101")),
      occupancy: "owner_occupied",
      isPrimary: true,
    },
    {
      id: MEMBER_102,
      apartmentId: asApartmentId(id("102")),
      occupancy: "owner_occupied",
      isPrimary: true,
    },
    {
      id: TENANT_103,
      apartmentId: asApartmentId(id("103")),
      occupancy: "tenant",
      isPrimary: true,
    },
  ];
}

function membershipOf(
  userId: UserId,
  role: SocietyMembership["role"],
  status: SocietyMembership["status"] = "active",
): SocietyMembership {
  return {
    id: asMemberId(id(`membership-${userId}`)),
    societyId: SOCIETY,
    userId,
    role,
    status,
    occupancyType: "owner" as OccupancyType,
    joinedAt: "2026-01-01T00:00:00.000Z",
  };
}

function categoryFixture(
  overrides: Partial<ExpenseCategory> = {},
): ExpenseCategory {
  return {
    id: asExpenseCategoryId(id("category-1")),
    societyId: SOCIETY,
    name: "Maintenance",
    icon: null,
    color: null,
    defaultSplitStrategy: "equal" as SplitStrategy,
    defaultApartmentBasis: null,
    isOwnerOnly: false,
    isCapital: false,
    gstApplicable: false,
    isActive: true,
    displayOrder: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

/** The four read ports, in memory. */
class FakeWorld
  implements
    ExpenseParticipantReader,
    ExpenseSocietyReader,
    ExpenseMembershipReader,
    ExpenseCategoryRepository
{
  readonly calls: string[] = [];
  membership: SocietyMembership | null = membershipOf(ADMIN, "admin");
  directory: SocietyParticipantDirectory = {
    apartments: fixtureFlats(),
    members: fixtureMembers(),
    wings: [],
    buildings: [BUILDING],
  };
  billVacantFlats = true;
  readonly categories = new Map<string, ExpenseCategory>();

  callsOf(method: string): number {
    return this.calls.filter((call) => call === method).length;
  }

  async findMembership(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyMembership | null> {
    this.calls.push("findMembership");
    if (societyId !== SOCIETY || this.membership?.userId !== actor) {
      return null;
    }
    return this.membership;
  }

  async listSocietyParticipants(
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<SocietyParticipantDirectory> {
    this.calls.push("listSocietyParticipants");
    return societyId === SOCIETY
      ? this.directory
      : { apartments: [], members: [], wings: [], buildings: [] };
  }

  async findById(
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<{ settings: { billVacantFlats: boolean } } | null> {
    this.calls.push("findById");
    return societyId === SOCIETY
      ? { settings: { billVacantFlats: this.billVacantFlats } }
      : null;
  }

  async findCategory(
    categoryId: ExpenseCategoryId,
    societyId: SocietyId,
    _actor: UserId,
  ): Promise<ExpenseCategory | null> {
    this.calls.push("findCategory");
    const category = this.categories.get(categoryId);
    if (category === undefined || category.societyId !== societyId) {
      return null;
    }
    return category;
  }

  // ── the rest of the category port: present so the fake is the interface, unused ──

  async listCategories(): Promise<readonly ExpenseCategory[]> {
    throw new Error("not used by the preview");
  }

  async findByName(): Promise<ExpenseCategory | null> {
    throw new Error("not used by the preview");
  }

  async create(): Promise<ExpenseCategory> {
    throw new Error("not used by the preview");
  }

  async update(): Promise<ExpenseCategory> {
    throw new Error("not used by the preview");
  }

  async remove(): Promise<void> {
    throw new Error("not used by the preview");
  }
}

function previewUseCaseFor(world: FakeWorld): PreviewSplitUseCase {
  return new PreviewSplitUseCase(world, world, world, world);
}

function commandOf(
  overrides: Partial<PreviewSplitCommand> = {},
): PreviewSplitCommand {
  return { amountPaise: 10_000, selector: {}, ...overrides };
}

async function previewOf(
  world: FakeWorld,
  overrides: Partial<PreviewSplitCommand> = {},
  actor: UserId = ADMIN,
): Promise<ExpenseSplitPreview> {
  return previewUseCaseFor(world).preview(actor, SOCIETY, commandOf(overrides));
}

// ─────────────────────────────────────────────────────────────────────────────
// The plan
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveSplitPlan", () => {
  it("takes a category's default strategy and basis when the request omits both", () => {
    const plan = resolveSplitPlan(
      commandOf(),
      categoryFixture({
        defaultSplitStrategy: "apartment",
        defaultApartmentBasis: "per_bhk",
      }),
    );

    expect(plan.ok && plan.value).toEqual({
      strategy: "apartment",
      basis: "per_bhk",
    });
  });

  it("prefers an explicit request over the category's default", () => {
    const plan = resolveSplitPlan(
      commandOf({ splitStrategy: "shares" }),
      categoryFixture({ defaultSplitStrategy: "equal" }),
    );

    expect(plan.ok && plan.value).toEqual({ strategy: "shares", basis: null });
  });

  it("defaults to equal when no category is named", () => {
    const plan = resolveSplitPlan(commandOf(), null);

    expect(plan.ok && plan.value).toEqual({ strategy: "equal", basis: null });
  });

  it("refuses an apartment split with no basis anywhere, naming the field", () => {
    const plan = resolveSplitPlan(
      commandOf({ splitStrategy: "apartment" }),
      null,
    );

    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.error.code).toBe("validation");
      expect(plan.error.details?.field).toBe("apartmentBasis");
    }
  });

  it("drops a basis supplied beside a strategy that never reads one", () => {
    const plan = resolveSplitPlan(
      commandOf({ splitStrategy: "equal", apartmentBasis: "per_flat" }),
      null,
    );

    expect(plan.ok && plan.value).toEqual({ strategy: "equal", basis: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The engine input
// ─────────────────────────────────────────────────────────────────────────────

/** One resolved participant, addressed to a member of the flat. */
function participantOf(
  label: string,
  memberId: MemberId,
  overrides: Partial<ExpenseParticipant> = {},
): ExpenseParticipant {
  const flat = fixtureFlats().find((entry) => entry.apartmentNumber === label)!;
  return {
    memberId,
    apartmentId: flat.id,
    apartmentNumber: label,
    assignedReason: null,
    routedFromMemberId: null,
    floor: flat.floor,
    carpetAreaSqft: flat.carpetAreaSqft,
    builtupAreaSqft: flat.builtupAreaSqft,
    bhk: flat.bhk,
    parkingSlots: flat.parkingSlots,
    shareUnits: flat.shareUnits,
    ...overrides,
  };
}

function resolutionOf(
  participants: readonly ExpenseParticipant[],
  unassigned: readonly UnassignedParticipant[] = [],
): ExpenseParticipantResolution {
  return { participants, unassigned };
}

describe("the engine input mapping", () => {
  const three = () =>
    resolutionOf([
      participantOf("101", MEMBER_101),
      participantOf("102", MEMBER_102),
      participantOf("103", TENANT_103),
    ]);

  it("runs the real engine for each strategy and returns the typed allocation", () => {
    // The mapping's contract is `SplitInput`; this asserts it by running the engine, not
    // by inspecting the object — the property that matters is the money.
    const equal = buildSplitInput(
      three(),
      { strategy: "equal", basis: null },
      10_000,
      undefined,
    );
    expect(equal.ok).toBe(true);
    if (equal.ok) {
      const result = computeSplit(equal.value);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.allocations.map((a) => a.amount.paise)).toEqual([
          3334n,
          3333n,
          3333n,
        ]);
      }
    }
  });

  it("defaults an omitted percentage to zero and refuses an unknown reference", () => {
    const mapped = buildSplitInput(
      three(),
      { strategy: "percentage", basis: null },
      10_000,
      { percentages: [{ apartmentId: id("101"), basisPoints: 10_000 }] },
    );
    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      const result = computeSplit(mapped.value);
      expect(
        result.ok && result.value.allocations.map((a) => a.amount.paise),
      ).toEqual([10_000n, 0n, 0n]);
    }

    const unknown = buildSplitInput(
      three(),
      { strategy: "percentage", basis: null },
      10_000,
      { percentages: [{ apartmentId: id("999"), basisPoints: 10_000 }] },
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.code).toBe("validation");
      expect(unknown.error.details?.field).toBe("splitConfig.percentages");
    }
  });

  it("refuses a duplicate reference, which would otherwise be silently collapsed", () => {
    const duplicated = buildSplitInput(
      three(),
      { strategy: "shares", basis: null },
      10_000,
      {
        shares: [
          { apartmentId: id("101"), shareUnits: 1000 },
          { apartmentId: id("101"), shareUnits: 2000 },
        ],
      },
    );

    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) {
      expect(duplicated.error.details?.field).toBe("splitConfig.shares");
    }
  });

  it("maps explicit shares from the request and omitted ones from the flat's stored units", () => {
    // The two scales are different and the crossing is this mapping's job: a request
    // entry is already thousandths (`3_000` is three shares, the contract's own unit)
    // while `apartments.share_units` is `numeric(8, 3)` — the fixture's stored `2` and
    // `1` are two and one whole shares, so the weights must come out 3 : 1 : 1 and not
    // 3000 : 2 : 1.
    const mapped = buildSplitInput(
      three(),
      { strategy: "shares", basis: null },
      10_000,
      { shares: [{ apartmentId: id("101"), shareUnits: 3_000 }] },
    );

    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      const result = computeSplit(mapped.value);
      expect(
        result.ok && result.value.allocations.map((a) => a.amount.paise),
      ).toEqual([6_000n, 2_000n, 2_000n]);
    }
  });

  it("keeps a fractional stored share exact — 1.5 shares is 1_500 thousandths", () => {
    const mapped = buildSplitInput(
      resolutionOf([
        participantOf("101", MEMBER_101),
        participantOf("102", MEMBER_102, { shareUnits: 1.5 }),
      ]),
      { strategy: "shares", basis: null },
      10_000,
      undefined,
    );

    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      const result = computeSplit(mapped.value);
      // Stored 2 and 1.5 shares → 2_000 : 1_500. 10_000 × 4 ÷ 7 = 5714.28…,
      // × 3 ÷ 7 = 4285.71…; floors sum to 9999, and the larger remainder
      // (the 1_500 side) takes the residual paisa.
      expect(
        result.ok && result.value.allocations.map((a) => a.amount.paise),
      ).toEqual([5_714n, 4_286n]);
    }
  });

  it("excludes an omitted custom participant rather than defaulting it", () => {
    const mapped = buildSplitInput(
      three(),
      { strategy: "custom", basis: null },
      10_000,
      {
        customAmounts: [
          { apartmentId: id("101"), amountPaise: 6000 },
          { apartmentId: id("102"), amountPaise: 4000 },
        ],
      },
    );

    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      const result = computeSplit(mapped.value);
      expect(
        result.ok && result.value.allocations.map((a) => a.apartmentNumber),
      ).toEqual(["101", "102"]);
    }
  });

  it("carries floor bands into the per_floor_band arm", () => {
    const mapped = buildSplitInput(
      three(),
      { strategy: "apartment", basis: "per_floor_band" },
      10_000,
      {
        floorBands: [
          { from: 0, to: 0, mult: 0 },
          { from: 1, to: 1, mult: 1 },
          { from: 2, to: 2, mult: 3 },
        ],
      },
    );

    expect(mapped.ok).toBe(true);
    if (mapped.ok) {
      const result = computeSplit(mapped.value);
      // Weights 1 : 3 : 3 over 10_000 paise → 1428.57 / 4285.71 / 4285.71; the two
      // residual paise go to the largest remainders (the two floor-2 flats).
      expect(
        result.ok && result.value.allocations.map((a) => a.amount.paise),
      ).toEqual([1428n, 4286n, 4286n]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conservation and error translation
// ─────────────────────────────────────────────────────────────────────────────

describe("verifyConservation", () => {
  it("passes a real engine result through", () => {
    const mapped = buildSplitInput(
      resolutionOf([participantOf("101", MEMBER_101)]),
      { strategy: "equal", basis: null },
      10_000,
      undefined,
    );
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;

    const result = computeSplit(mapped.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(verifyConservation(result.value).ok).toBe(true);
  });

  it("refuses a successful result that does not sum to the amount", () => {
    const fabricated: SplitResult = Object.freeze({
      total: Money.fromPaise(paise(10_000)),
      allocations: Object.freeze([
        {
          memberId: MEMBER_101,
          apartmentId: asApartmentId(id("101")),
          apartmentNumber: "101",
          amount: Money.fromPaise(paise(9_999)),
          weight: weight(1n),
        },
      ]),
      residualPaise: paise(1),
      warnings: Object.freeze([]),
    });

    const checked = verifyConservation(fabricated);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.error.code).toBe("invariant");
    }
  });
});

describe("fromSplitError", () => {
  it("keeps every engine code meaning what the API's catalogue says it means", () => {
    expect(fromSplitError(splitError("validation", "x")).code).toBe(
      "validation",
    );
    expect(fromSplitError(splitError("conflict", "x")).code).toBe("conflict");
    expect(fromSplitError(splitError("invariant", "x")).code).toBe("invariant");
  });
});

describe("toPreview", () => {
  it("counts allocations, forwards warnings and flags the unassigned flats", () => {
    const resolution = resolutionOf(
      [participantOf("101", MEMBER_101)],
      [
        {
          apartmentId: asApartmentId(id("104")),
          apartmentNumber: "104",
          reason: "unassigned_no_member",
          floor: 3,
          carpetAreaSqft: 350,
          builtupAreaSqft: 437,
          bhk: 1,
          parkingSlots: 0,
          shareUnits: 1,
        },
      ],
    );
    const mapped = buildSplitInput(
      resolution,
      { strategy: "equal", basis: null },
      10_000,
      undefined,
    );
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    const result = computeSplit(mapped.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const preview = toPreview(result.value, resolution);

    expect(preview.participantCount).toBe(1);
    expect(preview.allocations).toHaveLength(1);
    expect(preview.residualPaise).toBe(0n);
    expect(preview.unassigned).toEqual([
      {
        apartmentId: asApartmentId(id("104")),
        apartmentNumber: "104",
        reason: "unassigned_no_member",
      },
    ]);
    expect(Object.isFrozen(preview)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────────────────

describe("PreviewSplitUseCase.preview", () => {
  let world: FakeWorld;

  beforeEach(() => {
    world = new FakeWorld();
  });

  it("previews an equal split with hand-calculated amounts, residual included", async () => {
    const preview = await previewOf(world);

    expect(preview.total.paise).toBe(10_000n);
    expect(preview.participantCount).toBe(3);
    expect(preview.allocations.map((a) => a.memberId)).toEqual([
      MEMBER_101,
      MEMBER_102,
      TENANT_103,
    ]);
    // 10_000 ÷ 3 = 3333 each, the odd paisa to the first flat in apartment order.
    expect(preview.allocations.map((a) => a.amount.paise)).toEqual([
      3334n,
      3333n,
      3333n,
    ]);
    expect(preview.residualPaise).toBe(0n);
    // 104 has nobody attached: flagged, never dropped, and not charged.
    expect(preview.unassigned).toEqual([
      {
        apartmentId: asApartmentId(id("104")),
        apartmentNumber: "104",
        reason: "unassigned_no_member",
      },
    ]);
  });

  it("is a function of the set, not of the row order the directory returned", async () => {
    const first = await previewOf(world);

    const scrambled = new FakeWorld();
    scrambled.directory = {
      ...scrambled.directory,
      apartments: [...scrambled.directory.apartments].reverse(),
      members: [...scrambled.directory.members].reverse(),
    };
    const second = await previewOf(scrambled);

    expect(second.allocations).toEqual(first.allocations);
    expect(second.unassigned).toEqual(first.unassigned);
  });

  it("flags a tenant's flat as unassigned under an owner-only category with no owner", async () => {
    const category = categoryFixture({ isOwnerOnly: true });
    world.categories.set(category.id, category);

    const preview = await previewOf(world, { categoryId: category.id });

    // 103's tenant is not billed (the category is owner-only) and the flat has no owner
    // membership, so it joins 104 in the flagged list — in flat order, and both carry
    // `unassigned_no_owner`, because the reason is the *policy* that refused them (an
    // owner-only bill needs an owner), not a fact about who happens to be attached.
    expect(preview.unassigned).toEqual([
      {
        apartmentId: asApartmentId(id("103")),
        apartmentNumber: "103",
        reason: "unassigned_no_owner",
      },
      {
        apartmentId: asApartmentId(id("104")),
        apartmentNumber: "104",
        reason: "unassigned_no_owner",
      },
    ]);
    expect(preview.allocations.map((a) => a.memberId)).toEqual([
      MEMBER_101,
      MEMBER_102,
    ]);
    expect(preview.allocations.map((a) => a.amount.paise)).toEqual([
      5000n,
      5000n,
    ]);
  });

  it("routes a rented flat's charge to its owner when one exists", async () => {
    const owner = asMemberId(id("owner-103"));
    world.directory = {
      ...world.directory,
      members: [
        ...world.directory.members,
        {
          id: owner,
          apartmentId: asApartmentId(id("103")),
          occupancy: "vacant_owner",
          isPrimary: false,
        },
      ],
    };
    const category = categoryFixture({ isOwnerOnly: true });
    world.categories.set(category.id, category);

    const preview = await previewOf(world, { categoryId: category.id });

    expect(
      preview.allocations.find((a) => a.apartmentNumber === "103")?.memberId,
    ).toBe(owner);
    expect(preview.unassigned.map((entry) => entry.apartmentNumber)).toEqual([
      "104",
    ]);
  });

  it("takes the strategy and basis from the category's defaults when omitted", async () => {
    const category = categoryFixture({
      defaultSplitStrategy: "apartment",
      defaultApartmentBasis: "per_bhk",
    });
    world.categories.set(category.id, category);

    const preview = await previewOf(world, { categoryId: category.id });

    // 2 : 1 : 1 BHK over 10_000 paise → 5000 / 2500 / 2500, weights in tenths.
    expect(preview.allocations.map((a) => a.amount.paise)).toEqual([
      5000n,
      2500n,
      2500n,
    ]);
    expect(preview.allocations.map((a) => a.weight)).toEqual([20n, 10n, 10n]);
    // The defaults read, plus the resolver's own owner-only read.
    expect(world.callsOf("findCategory")).toBe(2);
  });

  it("does not read a category for defaults the request already carries", async () => {
    const category = categoryFixture();
    world.categories.set(category.id, category);

    await previewOf(world, { categoryId: category.id, splitStrategy: "equal" });

    // Exactly the resolver's owner-only read: the use case's defaults read is skipped
    // when the request is complete, which is the happy path's whole read budget.
    expect(world.callsOf("findCategory")).toBe(1);
  });

  it("surfaces a missing metric as an engine warning and excludes the flat", async () => {
    world.directory = {
      ...world.directory,
      apartments: world.directory.apartments.map((flat) =>
        flat.apartmentNumber === "102"
          ? { ...flat, carpetAreaSqft: null }
          : flat,
      ),
    };

    const preview = await previewOf(world, {
      splitStrategy: "apartment",
      apartmentBasis: "per_sqft_carpet",
    });

    expect(preview.warnings).toEqual([
      {
        code: "MISSING_AREA",
        message: expect.any(String) as unknown as string,
        apartmentIds: [asApartmentId(id("102"))],
      },
    ]);
    expect(preview.allocations.map((a) => a.apartmentNumber)).toEqual([
      "101",
      "103",
    ]);
    // 700 : 350 over the remaining flats — 6666.67 / 3333.33, residual to the larger.
    expect(preview.allocations.map((a) => a.amount.paise)).toEqual([
      6667n,
      3333n,
    ]);
  });

  it("warns NO_FLOOR_BAND for a floor the band table does not cover", async () => {
    const preview = await previewOf(world, {
      splitStrategy: "apartment",
      apartmentBasis: "per_floor_band",
      splitConfig: { floorBands: [{ from: 1, to: 1, mult: 1 }] },
    });

    expect(preview.warnings.map((warning) => warning.code)).toEqual([
      "NO_FLOOR_BAND",
    ]);
    expect(preview.warnings[0]?.apartmentIds).toEqual([
      asApartmentId(id("102")),
      asApartmentId(id("103")),
    ]);
    expect(preview.allocations.map((a) => a.apartmentNumber)).toEqual(["101"]);
    expect(preview.allocations[0]?.amount.paise).toBe(10_000n);
  });

  it("computes a custom split exactly, excluding by omission", async () => {
    const preview = await previewOf(world, {
      splitStrategy: "custom",
      splitConfig: {
        customAmounts: [
          { apartmentId: id("101"), amountPaise: 6000 },
          { apartmentId: id("102"), amountPaise: 4000 },
        ],
      },
    });

    expect(preview.allocations.map((a) => a.memberId)).toEqual([
      MEMBER_101,
      MEMBER_102,
    ]);
    expect(preview.allocations.map((a) => a.amount.paise)).toEqual([
      6000n,
      4000n,
    ]);
  });

  it("surfaces the engine's refusal for a custom sum that does not balance", async () => {
    await expect(
      previewOf(world, {
        splitStrategy: "custom",
        splitConfig: {
          customAmounts: [{ apartmentId: id("101"), amountPaise: 6000 }],
        },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("answers the same not_found for a non-member and a removed one", async () => {
    await expect(previewOf(world, {}, RESIDENT)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    world.membership = {
      ...membershipOf(ADMIN, "admin"),
      status: "removed",
    };
    await expect(previewOf(world)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses an active member whose role cannot compose an expense", async () => {
    world.membership = membershipOf(ADMIN, "resident");

    await expect(previewOf(world)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("refuses a pending membership too — the grant is on an unadmitted member", async () => {
    world.membership = membershipOf(ADMIN, "admin", "pending");

    await expect(previewOf(world)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("answers not_found for another society's category and for a missing one", async () => {
    const other = categoryFixture({ societyId: OTHER_SOCIETY });
    world.categories.set(other.id, other);

    await expect(
      previewOf(world, { categoryId: other.id, splitStrategy: "apartment" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      previewOf(world, {
        categoryId: asExpenseCategoryId(id("missing")),
        splitStrategy: "apartment",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("is deterministic: the same request over the same state is the same preview", async () => {
    const first = await previewOf(world);
    const second = await previewOf(world);

    expect(second).toEqual(first);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The preview/publish contract
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Roadmap T064's blocking acceptance test: "the preview output equals the published
 * output for identical input".
 *
 * Publishing itself is T066 and does not exist yet, so the publish side is composed
 * here from the two authorities a publish will actually call: T063's resolution (the
 * same use case the preview calls) and `buildSplitInput` → `computeSplit` (the same
 * composition), with the engine's allocations carried through **T061's real `publish`
 * transition** — the door T066 will hand them to when it writes `expense_splits` and
 * `dues`. What the test pins is that the endpoint's rows *are* the publish rows: the
 * same five facts per participant, in the same order, down to the weight — not a
 * second projection maintained beside the first, which is the way a preview and a
 * bill drift apart.
 *
 * The one thing deliberately out of scope is persistence: no repository is written,
 * which is exactly the point of a preview. The integration suite counts the rows to
 * prove the preview itself wrote nothing.
 */
describe("the preview/publish contract", () => {
  it("returns exactly the allocations the publish path stores, fact for fact", async () => {
    const world = new FakeWorld();
    const amount = 10_000;
    const command = commandOf({
      amountPaise: amount,
      splitStrategy: "apartment",
      apartmentBasis: "per_sqft_carpet",
    });

    // The publish path, composed from the same pieces the preview uses.
    const resolution = await resolveParticipantsForExpense(
      {
        participants: world,
        society: world,
        categories: world,
        memberships: world,
      },
      ADMIN,
      SOCIETY,
      { selector: command.selector, categoryId: null },
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;

    const input = buildSplitInput(
      resolution.value,
      { strategy: "apartment", basis: "per_sqft_carpet" },
      amount,
      undefined,
    );
    expect(input.ok).toBe(true);
    if (!input.ok) return;

    const engine = computeSplit(input.value);
    expect(engine.ok).toBe(true);
    if (!engine.ok) return;

    const clock = fixedClock("2026-10-02T10:00:00.000Z");
    const expense = Expense.create({
      id: asExpenseId(id("expense-1")),
      societyId: SOCIETY,
      categoryId: asExpenseCategoryId(id("category-1")),
      title: "Split preview contract",
      amount: Money.fromPaise(paise(amount)),
      expenseDate: "2026-10-02",
      createdBy: MEMBER_101,
      clock,
    });
    expect(expense.ok).toBe(true);
    if (!expense.ok) return;

    // T061's own conservation door: a set that did not sum to the amount would be
    // refused here, before a `dues` row could exist.
    const published = expense.value.publish(engine.value.allocations, clock);
    expect(published.ok).toBe(true);
    if (!published.ok) return;

    const preview = await previewOf(world, command);
    const stored = expense.value.splits.map((split) => ({
      memberId: split.memberId,
      apartmentId: split.apartmentId,
      apartmentNumber: split.apartmentNumber,
      amountPaise: split.amount.paise,
      weight: split.weight,
    }));
    const shown = preview.allocations.map((allocation) => ({
      memberId: allocation.memberId,
      apartmentId: allocation.apartmentId,
      apartmentNumber: allocation.apartmentNumber,
      amountPaise: allocation.amount.paise,
      weight: allocation.weight,
    }));

    expect(shown).toEqual(stored);
    expect(shown).toHaveLength(3);
  });
});
