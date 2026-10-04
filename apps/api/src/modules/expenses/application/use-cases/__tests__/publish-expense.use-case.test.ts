import {
  Money,
  asApartmentId,
  expenseError,
  asBuildingId,
  asExpenseCategoryId,
  asExpenseId,
  asMemberId,
  asSocietyId,
  asUserId,
  fixedClock,
} from "@ses/domain";
import type {
  ApartmentId,
  ExpenseCategory,
  ExpenseCategoryId,
  ExpenseCategoryRepository,
  ExpenseEvent,
  ExpenseEventPublisher,
  ExpenseId,
  ExpenseMemberNameReader,
  ExpenseMembershipReader,
  ExpenseParticipantReader,
  ExpensePublication,
  ExpensePublicationLookup,
  ExpenseRecord,
  ExpenseRepository,
  ExpenseSocietyReader,
  ExpenseSplitRepository,
  ExpenseSplitSummary,
  MemberId,
  OccupancyType,
  ParticipantApartment,
  ParticipantMember,
  PublishExpenseAllocation,
  PublishExpenseRecordInput,
  SocietyId,
  SocietyMembership,
  SocietyParticipantDirectory,
  UserId,
} from "@ses/domain";

import { AppError } from "../../../../../common/errors/app-error";
import { ParticipantResolverService } from "../../participant-resolver.service";
import {
  PublishExpenseUseCase,
  publishRequestHash,
  type PublishExpenseCommand,
} from "../publish-expense.use-case";

/**
 * T066's publish use case, composed with the **real** resolver and the real split
 * engine.
 *
 * ## What is faked, and what is emphatically not
 *
 * Only the five ports: the expense store, the split store, the name read, the event
 * sink and the participant world (which supplies the four reads the real resolver
 * composes). Everything between the call and those objects is production code —
 * `resolveSplitPlan`, `buildSplitInput`, `computeSplit`, `verifyConservation`, the
 * `Expense` aggregate's `publish()`, the snapshot composition and the post-commit
 * dispatch.
 *
 * A fake at *this* boundary still fails when a rule regresses — a lost paisa, a share
 * attached to the wrong member, an announcement made before the write — and the
 * assertions below are about exactly those facts. What only the integration suite can
 * prove (the definer function, RLS, the deferred `chk_split_total()` trigger, the real
 * `(user_id, idempotency_key)` unique index) is asserted there against PostgreSQL.
 */

const SOCIETY = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const ADMIN = asUserId("11111111-1111-4111-8111-111111111111");
const TREASURER = asUserId("22222222-2222-4222-8222-222222222222");
const COMMITTEE = asUserId("77777777-7777-4777-8777-777777777777");
const RESIDENT = asUserId("33333333-3333-4333-8333-333333333333");
const CLOCK = fixedClock("2026-10-04T09:30:00.000Z");

const CATEGORY = asExpenseCategoryId("55555555-5555-4555-8555-555555555555");
const BUILDING = asBuildingId("66666666-6666-4666-8666-666666666666");

/** The expense every test publishes unless it says otherwise. */
const EXPENSE = asExpenseId("20000000-0000-4000-8000-000000000001");
const OTHER_EXPENSE = asExpenseId("20000000-0000-4000-8000-000000000002");

const ADMIN_MEMBER = asMemberId("10000000-0000-4000-8000-000000000001");
const MEMBER_101 = asMemberId("10000000-0000-4000-8000-000000000101");
const MEMBER_102 = asMemberId("10000000-0000-4000-8000-000000000102");
const TENANT_103 = asMemberId("10000000-0000-4000-8000-000000000103");
const OWNER_104 = asMemberId("10000000-0000-4000-8000-000000000104");

/** A uuid-shaped id from a readable label — the domain suites' own helper shape. */
function id(label: string): string {
  const hex = [...label]
    .map((character) => character.charCodeAt(0).toString(16))
    .join("")
    .slice(0, 12)
    .padEnd(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

/**
 * Literal ids, not the `id(label)` helper: that helper hashes the label's first six
 * and a suite whose labels differ only in their last character would give every flat
 * the same uuid — which the engine reports as "a participant twice".
 */
const FLAT_101 = asApartmentId("40000000-0000-4000-8000-000000000101");
const FLAT_102 = asApartmentId("40000000-0000-4000-8000-000000000102");
const FLAT_103 = asApartmentId("40000000-0000-4000-8000-000000000103");
const FLAT_104 = asApartmentId("40000000-0000-4000-8000-000000000104");

function flat(
  apartmentId: ApartmentId,
  apartmentNumber: string,
  overrides: Partial<ParticipantApartment> = {},
): ParticipantApartment {
  return {
    id: apartmentId,
    buildingId: BUILDING,
    wingId: null,
    apartmentNumber,
    floor: 1,
    bhk: 2,
    carpetAreaSqft: 1_000,
    builtupAreaSqft: 1_200,
    parkingSlots: 1,
    shareUnits: 1,
    occupancyStatus: "owner_occupied",
    isBillable: true,
    ...overrides,
  };
}

/** Two owner-occupied flats, one rented (tenant), one vacant-owner — four billable. */
function fixtureFlats(): ParticipantApartment[] {
  return [
    flat(FLAT_101, "101"),
    flat(FLAT_102, "102"),
    flat(FLAT_103, "103", { occupancyStatus: "rented" }),
    flat(FLAT_104, "104", { occupancyStatus: "vacant" }),
  ];
}

function fixtureMembers(): ParticipantMember[] {
  return [
    {
      id: MEMBER_101,
      apartmentId: FLAT_101,
      occupancy: "owner_occupied",
      isPrimary: true,
    },
    {
      id: MEMBER_102,
      apartmentId: FLAT_102,
      occupancy: "owner_occupied",
      isPrimary: true,
    },
    {
      id: TENANT_103,
      apartmentId: FLAT_103,
      occupancy: "tenant",
      isPrimary: true,
    },
    {
      id: OWNER_104,
      apartmentId: FLAT_104,
      occupancy: "vacant_owner",
      isPrimary: true,
    },
  ];
}

function membershipOf(
  actor: UserId,
  role: SocietyMembership["role"],
): SocietyMembership {
  return {
    id: asMemberId(id(`membership-${actor}`)),
    societyId: SOCIETY,
    userId: actor,
    role,
    status: "active",
    occupancyType: "owner" as OccupancyType,
    joinedAt: "2026-01-01T00:00:00.000Z",
  };
}

function categoryFixture(
  overrides: Partial<ExpenseCategory> = {},
): ExpenseCategory {
  return {
    id: CATEGORY,
    societyId: SOCIETY,
    name: "Maintenance",
    icon: null,
    color: null,
    defaultSplitStrategy: "equal",
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

function recordFixture(overrides: Partial<ExpenseRecord> = {}): ExpenseRecord {
  return {
    id: EXPENSE,
    societyId: SOCIETY,
    categoryId: CATEGORY,
    title: "Lift AMC — Q3",
    description: null,
    amount: Money.fromPaise(90_000),
    expenseDate: "2026-09-30",
    vendorName: null,
    paymentSource: "society_account",
    paidByMemberId: null,
    splitStrategy: "equal",
    apartmentBasis: null,
    splitConfig: {},
    participantSelector: {},
    status: "draft",
    createdBy: ADMIN_MEMBER,
    publishedAt: null,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    version: 3,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The ports, in memory
// ─────────────────────────────────────────────────────────────────────────────

/** `ExpenseRepository` — the one read the publish path performs. */
class FakeExpenses implements ExpenseRepository {
  readonly records = new Map<ExpenseId, ExpenseRecord>();
  readonly calls: string[] = [];

  seed(record: ExpenseRecord): void {
    this.records.set(record.id, record);
  }

  async create(): Promise<ExpenseRecord> {
    throw new Error("not used by the publish path");
  }

  async findById(
    expenseId: ExpenseId,
    societyId: SocietyId,
  ): Promise<ExpenseRecord | null> {
    this.calls.push("findById");
    const record = this.records.get(expenseId);
    if (record === undefined || record.societyId !== societyId) return null;
    return record;
  }

  async update(): Promise<ExpenseRecord> {
    throw new Error("not used by the publish path");
  }

  async list(): Promise<never> {
    throw new Error("not used by the publish path");
  }

  async deleteDraft(): Promise<void> {
    throw new Error("not used by the publish path");
  }
}

/**
 * The publishing write path, in memory — writing where the expense fake reads.
 *
 * The transition is stored in the *same* map `findById` serves, because in production
 * the two are one table inside one transaction: a fake with a store of its own would let
 * a suite pass while the row never moved.
 */
class FakeSplits implements ExpenseSplitRepository {
  readonly records = new Map<
    string,
    { hash: string; body: ExpensePublication }
  >();
  readonly splits = new Map<ExpenseId, readonly PublishExpenseAllocation[]>();
  readonly calls: string[] = [];
  /** Runs just before the write decides — the post-commit ordering assertion. */
  beforeWrite?: (() => void) | undefined;
  failNext?: Error | undefined;

  constructor(private readonly expenses: FakeExpenses) {}

  async findPublication(
    input: ExpensePublicationLookup,
    actor: UserId,
  ): Promise<ExpensePublication | null> {
    this.calls.push("findPublication");
    const stored = this.records.get(`${actor}:${input.idempotencyKey}`);
    return stored === undefined ? null : replayOf(stored, input);
  }

  async publish(
    expenseId: ExpenseId,
    societyId: SocietyId,
    input: PublishExpenseRecordInput,
    actor: UserId,
  ): Promise<ExpensePublication> {
    this.calls.push("publish");
    this.beforeWrite?.();

    if (this.failNext !== undefined) {
      const failure = this.failNext;
      this.failNext = undefined;
      throw failure;
    }

    const stored = this.records.get(`${actor}:${input.idempotencyKey}`);
    if (stored !== undefined) return replayOf(stored, input);

    const record = this.expenses.records.get(expenseId);
    if (record === undefined || record.societyId !== societyId) {
      throw new AppError("NOT_FOUND", "That expense is not available to you.");
    }
    if (record.status !== "draft" && record.status !== "pending_approval") {
      throw new AppError(
        "INVALID_TRANSITION",
        `A ${record.status} expense cannot be published.`,
      );
    }
    if (record.version !== input.expectedVersion) {
      throw new AppError(
        "VERSION_MISMATCH",
        "This expense was changed by someone else. Reload it and try again.",
      );
    }

    const summary = summarise(input.allocations);
    if (!summary.total.equals(record.amount)) {
      throw new AppError(
        "SPLIT_MISMATCH",
        "The split allocations do not sum to the expense amount.",
      );
    }

    const published: ExpenseRecord = {
      ...record,
      status: "published",
      publishedAt: CLOCK.nowIso(),
      updatedAt: CLOCK.nowIso(),
      version: record.version + 1,
    };
    this.expenses.records.set(expenseId, published);
    this.splits.set(expenseId, [...input.allocations]);

    const publication: ExpensePublication = {
      expense: published,
      summary,
      replayed: false,
    };
    this.records.set(`${actor}:${input.idempotencyKey}`, {
      hash: input.requestHash,
      body: publication,
    });
    return publication;
  }
}

/** The PRD §8.3 summary, measured over the allocations the write received. */
function summarise(
  allocations: readonly PublishExpenseAllocation[],
): ExpenseSplitSummary {
  const amounts = allocations.map((allocation) => allocation.amount.paise);
  const fold = (pick: (carried: bigint, amount: bigint) => bigint): bigint =>
    amounts.reduce(
      (carried, amount) => pick(carried, amount),
      amounts[0] ?? 0n,
    );
  return {
    participantCount: allocations.length,
    total: Money.fromPaise(amounts.reduce((sum, amount) => sum + amount, 0n)),
    min: Money.fromPaise(fold((low, amount) => (amount < low ? amount : low))),
    max: Money.fromPaise(
      fold((high, amount) => (amount > high ? amount : high)),
    ),
  };
}

/** One stored record → the publication a retry must receive, or a key-reuse 409. */
function replayOf(
  stored: { hash: string; body: ExpensePublication },
  input: ExpensePublicationLookup,
): ExpensePublication {
  if (stored.hash !== input.requestHash) {
    // The domain's own refusal, exactly as the real repository raises it: the use case
    // maps it through `toAppError`, so a fake that threw the *catalogue* code here
    // would be testing a layer boundary that does not exist.
    throw expenseError(
      "idempotency_key_reuse",
      "This Idempotency-Key was already used for a different request. Use a new key.",
      { field: "idempotency-key" },
    );
  }
  return { ...stored.body, replayed: true };
}

/** The name read — one call per publication, and the suite can make it answer short. */
class FakeNames implements ExpenseMemberNameReader {
  readonly names = new Map<MemberId, string>();
  /** Set to drop one member from the answer — the corrupt-read invariant. */
  omit: MemberId | null = null;
  readonly calls: (readonly MemberId[])[] = [];

  async listMemberNames(
    _societyId: SocietyId,
    memberIds: readonly MemberId[],
  ): Promise<ReadonlyMap<MemberId, string>> {
    this.calls.push([...memberIds]);
    const found = new Map<MemberId, string>();
    for (const memberId of memberIds) {
      if (memberId === this.omit) continue;
      found.set(memberId, this.names.get(memberId) ?? memberId);
    }
    return found;
  }
}

/** The post-commit sink, observed. */
class FakeEvents implements ExpenseEventPublisher {
  readonly dispatched: (readonly ExpenseEvent[])[] = [];
  /** Runs inside `dispatch` — the world as it is at announcement time. */
  onDispatch?: ((events: readonly ExpenseEvent[]) => void) | undefined;
  failNext?: Error | undefined;

  async dispatch(events: readonly ExpenseEvent[]): Promise<void> {
    this.onDispatch?.(events);
    if (this.failNext !== undefined) {
      const failure = this.failNext;
      this.failNext = undefined;
      throw failure;
    }
    this.dispatched.push([...events]);
  }
}

/** The four reads the real resolver composes, in memory. */
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
    const membership = this.membership;
    if (membership === null) return null;
    if (membership.societyId !== societyId) return null;
    if (membership.userId !== actor) return null;
    return membership;
  }

  async listSocietyParticipants(
    societyId: SocietyId,
  ): Promise<SocietyParticipantDirectory> {
    this.calls.push("listSocietyParticipants");
    return societyId === SOCIETY
      ? this.directory
      : { apartments: [], members: [], wings: [], buildings: [] };
  }

  async findById(
    societyId: SocietyId,
  ): Promise<{ settings: { billVacantFlats: boolean } } | null> {
    this.calls.push("findById");
    return societyId === SOCIETY
      ? { settings: { billVacantFlats: this.billVacantFlats } }
      : null;
  }

  async findCategory(
    categoryId: ExpenseCategoryId,
    societyId: SocietyId,
  ): Promise<ExpenseCategory | null> {
    this.calls.push("findCategory");
    const category = this.categories.get(categoryId);
    if (category === undefined || category.societyId !== societyId) {
      return null;
    }
    return category;
  }

  async listCategories(): Promise<readonly ExpenseCategory[]> {
    throw new Error("not used by the publish path");
  }

  async findByName(): Promise<ExpenseCategory | null> {
    throw new Error("not used by the publish path");
  }

  async create(): Promise<ExpenseCategory> {
    throw new Error("not used by the publish path");
  }

  async update(): Promise<ExpenseCategory> {
    throw new Error("not used by the publish path");
  }

  async remove(): Promise<void> {
    throw new Error("not used by the publish path");
  }
}

interface Rig {
  readonly world: FakeWorld;
  readonly expenses: FakeExpenses;
  readonly splits: FakeSplits;
  readonly names: FakeNames;
  readonly events: FakeEvents;
  readonly publish: PublishExpenseUseCase;
}

function makeRig(record: ExpenseRecord = recordFixture()): Rig {
  const world = new FakeWorld();
  const expenses = new FakeExpenses();
  const splits = new FakeSplits(expenses);
  const names = new FakeNames();
  const events = new FakeEvents();

  world.categories.set(CATEGORY, categoryFixture());
  expenses.seed(record);
  names.names.set(MEMBER_101, "Asha Menon");
  names.names.set(MEMBER_102, "Bilal Khan");
  names.names.set(TENANT_103, "Carla Dias");
  names.names.set(OWNER_104, "Dev Patel");

  const publish = new PublishExpenseUseCase(
    expenses,
    splits,
    names,
    events,
    CLOCK,
    world,
    new ParticipantResolverService(world, world, world, world),
  );

  return { world, expenses, splits, names, events, publish };
}

function commandOf(
  overrides: Partial<PublishExpenseCommand> = {},
): PublishExpenseCommand {
  return {
    expectedVersion: 3,
    idempotencyKey: "publish-key-0001",
    ...overrides,
  };
}

async function publishOf(
  rig: Rig,
  command: Partial<PublishExpenseCommand> = {},
  actor: UserId = ADMIN,
  expenseId: ExpenseId = EXPENSE,
): Promise<ExpensePublication> {
  return rig.publish.publish(actor, SOCIETY, expenseId, commandOf(command));
}

/** The thrown `AppError`, for asserting the code, status and payload. */
async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error: unknown) {
    return error as AppError;
  }
  throw new Error("Expected the call to be refused.");
}

// ─────────────────────────────────────────────────────────────────────────────
// The publication
// ─────────────────────────────────────────────────────────────────────────────

describe("PublishExpenseUseCase", () => {
  it("publishes a draft, persists one split per participant and conserves the amount", async () => {
    const rig = makeRig();

    const publication = await publishOf(rig);

    expect(publication.replayed).toBe(false);
    expect(publication.expense.status).toBe("published");
    expect(publication.expense.publishedAt).toBe(CLOCK.nowIso());
    expect(publication.expense.version).toBe(4);
    expect(publication.summary.participantCount).toBe(4);
    expect(publication.summary.total.paise).toBe(90_000n);
    // The row really moved: the same store `findById` serves.
    expect(rig.expenses.records.get(EXPENSE)?.status).toBe("published");

    const persisted = rig.splits.splits.get(EXPENSE) ?? [];
    expect(persisted).toHaveLength(4);
    expect(
      persisted.reduce((sum, allocation) => sum + allocation.amount.paise, 0n),
    ).toBe(90_000n);
  });

  it("snapshots each participant's member name and flat number at publish time", async () => {
    const rig = makeRig();

    await publishOf(rig);

    const persisted = rig.splits.splits.get(EXPENSE) ?? [];
    expect(persisted.map((allocation) => allocation.snapshot)).toEqual([
      { memberName: "Asha Menon", apartmentNumber: "101" },
      { memberName: "Bilal Khan", apartmentNumber: "102" },
      { memberName: "Carla Dias", apartmentNumber: "103" },
      { memberName: "Dev Patel", apartmentNumber: "104" },
    ]);
  });

  it("reads names once, for the members the engine allocated to", async () => {
    const rig = makeRig();

    await publishOf(rig);

    expect(rig.names.calls).toHaveLength(1);
    expect([...(rig.names.calls[0] ?? [])].sort()).toEqual(
      [MEMBER_101, MEMBER_102, TENANT_103, OWNER_104].sort(),
    );
  });

  it("takes the persisted row as the authority, not a preview's figures", async () => {
    // The row says 90,000 paise. Whatever a preview computed before the last edit,
    // the published splits must sum to the row's amount.
    const rig = makeRig(recordFixture({ amount: Money.fromPaise(90_000) }));

    const publication = await publishOf(rig);

    expect(publication.summary.total.paise).toBe(90_000n);
    const persisted = rig.splits.splits.get(EXPENSE) ?? [];
    expect(
      persisted.reduce((sum, allocation) => sum + allocation.amount.paise, 0n),
    ).toBe(90_000n);
  });

  it("re-resolves the roster at publish time rather than replaying a preview", async () => {
    // Between the preview and this call, flat 103's tenant was replaced by its owner
    // (a rename of the roster, not of the request). The published allocation follows
    // the *current* roster.
    const rig = makeRig();
    rig.world.directory = {
      ...rig.world.directory,
      members: [
        ...fixtureMembers().slice(0, 2),
        {
          id: MEMBER_101,
          apartmentId: FLAT_103,
          occupancy: "vacant_owner",
          isPrimary: true,
        },
        {
          id: OWNER_104,
          apartmentId: FLAT_104,
          occupancy: "vacant_owner",
          isPrimary: true,
        },
      ],
    };

    await publishOf(rig);

    const persisted = rig.splits.splits.get(EXPENSE) ?? [];
    expect(persisted.map((allocation) => allocation.memberId)).toEqual([
      MEMBER_101,
      MEMBER_102,
      MEMBER_101,
      OWNER_104,
    ]);
  });

  it("publishes a pending_approval expense for a Treasurer", async () => {
    const rig = makeRig(recordFixture({ status: "pending_approval" }));
    rig.world.membership = membershipOf(TREASURER, "treasurer");

    const publication = await publishOf(rig, {}, TREASURER);

    expect(publication.expense.status).toBe("published");
  });

  it("follows the current column values for a per-sqft split", async () => {
    // The parity claim in the small: 90,000 paise over 2,000/1,000/1,000/500 sqft is
    // 40,000/20,000/20,000/10,000 — and the areas are read at publish time.
    const rig = makeRig(
      recordFixture({
        splitStrategy: "apartment",
        apartmentBasis: "per_sqft_carpet",
      }),
    );
    rig.world.directory = {
      ...rig.world.directory,
      apartments: [
        flat(FLAT_101, "101", { carpetAreaSqft: 2_000 }),
        flat(FLAT_102, "102", { carpetAreaSqft: 1_000 }),
        flat(FLAT_103, "103", { carpetAreaSqft: 1_000 }),
        flat(FLAT_104, "104", { carpetAreaSqft: 500 }),
      ],
    };

    await publishOf(rig);

    const persisted = rig.splits.splits.get(EXPENSE) ?? [];
    expect(persisted.map((allocation) => allocation.amount.paise)).toEqual([
      40_000n,
      20_000n,
      20_000n,
      10_000n,
    ]);
  });

  it("records the owner-only routing reason when a category moved the charge", async () => {
    const rig = makeRig();
    rig.world.categories.set(CATEGORY, categoryFixture({ isOwnerOnly: true }));
    rig.world.directory = {
      ...rig.world.directory,
      members: [
        ...fixtureMembers().slice(0, 2),
        {
          id: TENANT_103,
          apartmentId: FLAT_103,
          occupancy: "tenant",
          isPrimary: true,
        },
        {
          id: OWNER_104,
          apartmentId: FLAT_104,
          occupancy: "vacant_owner",
          isPrimary: true,
        },
        {
          id: MEMBER_101,
          apartmentId: FLAT_103,
          occupancy: "vacant_owner",
          isPrimary: true,
        },
      ],
    };

    await publishOf(rig);

    const persisted = rig.splits.splits.get(EXPENSE) ?? [];
    const flat103 = persisted.find(
      (allocation) => allocation.apartmentId === FLAT_103,
    );
    expect(flat103?.memberId).toBe(MEMBER_101);
    expect(flat103?.assignedReason).toBe("owner_only_category");
  });

  it("writes the percentage column only for a percentage split", async () => {
    const rig = makeRig(
      recordFixture({
        splitStrategy: "percentage",
        splitConfig: {
          percentages: [
            { apartmentId: FLAT_101, basisPoints: 2_500 },
            { apartmentId: FLAT_102, basisPoints: 2_500 },
            { apartmentId: FLAT_103, basisPoints: 2_500 },
            { apartmentId: FLAT_104, basisPoints: 2_500 },
          ],
        },
      }),
    );

    await publishOf(rig);

    const persisted = rig.splits.splits.get(EXPENSE) ?? [];
    expect(persisted.map((allocation) => allocation.percent)).toEqual([
      "25.00",
      "25.00",
      "25.00",
      "25.00",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The refusals
// ─────────────────────────────────────────────────────────────────────────────

describe("PublishExpenseUseCase — refusals", () => {
  it("refuses a missing Idempotency-Key before reading anything", async () => {
    const rig = makeRig();

    const error = await failure(publishOf(rig, { idempotencyKey: "" }));

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.status).toBe(422);
    expect(error.payload.field).toBe("idempotency-key");
    expect(rig.expenses.calls).toEqual([]);
    expect(rig.splits.calls).toEqual([]);
  });

  it("refuses a blank Idempotency-Key — whitespace is not a key", async () => {
    const rig = makeRig();

    const error = await failure(publishOf(rig, { idempotencyKey: "   " }));

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(rig.splits.calls).toEqual([]);
  });

  it("refuses a key longer than the stored bound", async () => {
    const rig = makeRig();

    const error = await failure(
      publishOf(rig, { idempotencyKey: "k".repeat(129) }),
    );

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(rig.splits.calls).toEqual([]);
  });

  it("refuses a caller with no membership as not_found", async () => {
    const rig = makeRig();
    rig.world.membership = null;

    const error = await failure(publishOf(rig, {}, RESIDENT));

    expect(error.code).toBe("NOT_FOUND");
    expect(error.status).toBe(404);
    expect(rig.expenses.calls).toEqual([]);
  });

  it("refuses a Committee Member — draft-only is not publishing", async () => {
    const rig = makeRig();
    rig.world.membership = membershipOf(COMMITTEE, "committee_member");

    const error = await failure(publishOf(rig, {}, COMMITTEE));

    expect(error.code).toBe("FORBIDDEN");
    expect(error.status).toBe(403);
    // The refusal cost no read of the row, no resolution and no write.
    expect(rig.expenses.calls).toEqual([]);
    expect(rig.splits.calls).toEqual([]);
  });

  it("refuses a Resident", async () => {
    const rig = makeRig();
    rig.world.membership = membershipOf(RESIDENT, "resident");

    const error = await failure(publishOf(rig, {}, RESIDENT));

    expect(error.code).toBe("FORBIDDEN");
  });

  it("refuses a pending membership — the society has not admitted it", async () => {
    const rig = makeRig();
    rig.world.membership = {
      ...membershipOf(ADMIN, "admin"),
      status: "pending",
    };

    const error = await failure(publishOf(rig));

    expect(error.code).toBe("FORBIDDEN");
  });

  it("answers not_found for an expense of another society", async () => {
    const rig = makeRig(recordFixture({ id: OTHER_EXPENSE }));
    rig.expenses.records.clear();

    const error = await failure(publishOf(rig));

    expect(error.code).toBe("NOT_FOUND");
    expect(rig.splits.calls).toEqual([]);
  });

  it("refuses an already published expense", async () => {
    const rig = makeRig(recordFixture({ status: "published" }));

    const error = await failure(publishOf(rig));

    expect(error.code).toBe("INVALID_TRANSITION");
    expect(error.status).toBe(409);
    expect(rig.splits.calls).toEqual(["findPublication"]);
  });

  it("refuses a void expense", async () => {
    const rig = makeRig(recordFixture({ status: "void" }));

    const error = await failure(publishOf(rig));

    expect(error.code).toBe("INVALID_TRANSITION");
  });

  it("refuses a stale expectedVersion, naming the current one", async () => {
    const rig = makeRig(recordFixture({ version: 7 }));

    const error = await failure(publishOf(rig, { expectedVersion: 3 }));

    expect(error.code).toBe("VERSION_MISMATCH");
    expect(error.status).toBe(409);
    expect(error.payload.details?.[0]).toMatchObject({
      field: "expectedVersion",
      code: "STALE",
      received: 3,
      current: 7,
    });
    expect(rig.splits.calls).toEqual(["findPublication"]);
  });

  it("fails closed while a billable flat has nobody to charge", async () => {
    const rig = makeRig();
    // Flat 104's owner is removed from the roster; the flat is still billable.
    rig.world.directory = {
      ...rig.world.directory,
      members: fixtureMembers().slice(0, 3),
    };

    const error = await failure(publishOf(rig));

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.status).toBe(422);
    expect(error.payload.field).toBe("participantSelector");
    expect(error.payload.details).toHaveLength(1);
    expect(error.payload.details?.[0]).toMatchObject({
      code: "UNASSIGNED_PARTICIPANTS",
    });
    // Nothing was written, and the row is still a draft.
    expect(rig.splits.splits.size).toBe(0);
    expect(rig.expenses.records.get(EXPENSE)?.status).toBe("draft");
    expect(rig.events.dispatched).toEqual([]);
  });

  it("fails closed for an owner-only category with no owner on the flat", async () => {
    const rig = makeRig();
    rig.world.categories.set(CATEGORY, categoryFixture({ isOwnerOnly: true }));
    rig.world.directory = {
      ...rig.world.directory,
      members: [
        ...fixtureMembers().slice(0, 2),
        // 103 keeps its tenant but gains no owner: an owner-only charge has nobody.
        {
          id: TENANT_103,
          apartmentId: FLAT_103,
          occupancy: "tenant",
          isPrimary: true,
        },
        {
          id: OWNER_104,
          apartmentId: FLAT_104,
          occupancy: "vacant_owner",
          isPrimary: true,
        },
      ],
    };

    const error = await failure(publishOf(rig));

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.payload.details?.[0]?.message).toContain("103");
  });

  it("refuses when the stored strategy is apartment with no basis", async () => {
    const rig = makeRig(
      recordFixture({ splitStrategy: "apartment", apartmentBasis: null }),
    );

    const error = await failure(publishOf(rig));

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.payload.field).toBe("apartmentBasis");
    expect(rig.splits.calls).not.toContain("publish");
  });

  it("refuses a selector that matches no billable flat", async () => {
    const rig = makeRig(
      recordFixture({
        participantSelector: {
          excludeApartments: [FLAT_101, FLAT_102, FLAT_103, FLAT_104],
        },
      }),
    );

    const error = await failure(publishOf(rig));

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(rig.splits.calls).not.toContain("publish");
  });

  it("treats a name read that cannot answer as an invariant, writing nothing", async () => {
    const rig = makeRig();
    rig.names.omit = MEMBER_102;

    const error = await failure(publishOf(rig));

    expect(error.code).toBe("INTERNAL");
    expect(rig.splits.splits.size).toBe(0);
    expect(rig.events.dispatched).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency — SAD §7.7
// ─────────────────────────────────────────────────────────────────────────────

describe("PublishExpenseUseCase — idempotency", () => {
  it("replays the stored response for a repeated key, writing nothing", async () => {
    const rig = makeRig();

    const first = await publishOf(rig);
    const second = await publishOf(rig);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.expense).toEqual(first.expense);
    expect(second.summary).toEqual(first.summary);
    // One publish call, and the version did not move again.
    expect(rig.splits.calls.filter((call) => call === "publish")).toHaveLength(
      1,
    );
    expect(rig.expenses.records.get(EXPENSE)?.version).toBe(4);
  });

  it("answers a replay from the record, without re-resolving the roster", async () => {
    // The retry must not be able to fail for a reason the original never met: the
    // roster is broken *after* the first publication and the replay still succeeds.
    const rig = makeRig();
    await publishOf(rig);
    rig.world.directory = { ...rig.world.directory, members: [] };

    const replay = await publishOf(rig);

    expect(replay.replayed).toBe(true);
    expect(replay.summary.total.paise).toBe(90_000n);
  });

  it("announces nothing on a replay — the first call already did", async () => {
    const rig = makeRig();

    await publishOf(rig);
    await publishOf(rig);

    expect(rig.events.dispatched).toHaveLength(1);
  });

  it("refuses a key reused for a different request with 409", async () => {
    const rig = makeRig();
    await publishOf(rig, { expectedVersion: 3 });

    // Same key, a different expectedVersion — a different request.
    const error = await failure(publishOf(rig, { expectedVersion: 4 }));

    expect(error.code).toBe("IDEMPOTENCY_KEY_REUSE");
    expect(error.status).toBe(409);
  });

  it("scopes keys per caller — another member's key is not this caller's replay", async () => {
    const rig = makeRig();
    await publishOf(rig, {}, ADMIN);

    // A Treasurer sends the same key string: no record exists for *this* actor, so it
    // is a fresh attempt rather than a replay — and the lifecycle refuses it, because
    // the row is already published.
    rig.world.membership = membershipOf(TREASURER, "treasurer");
    const error = await failure(publishOf(rig, {}, TREASURER));

    expect(error.code).toBe("INVALID_TRANSITION");
  });

  it("turns a lost concurrent race into a replay of the winner's publication", async () => {
    const rig = makeRig();
    // Both requests read "no record"; the winner commits, then the loser's write
    // re-reads the record and answers it.
    const winner = await publishOf(rig);
    rig.splits.calls.length = 0;
    const loser = await publishOf(rig);

    expect(loser.replayed).toBe(true);
    expect(loser.expense.version).toBe(winner.expense.version);
    expect(rig.splits.splits.get(EXPENSE)).toHaveLength(4);
  });

  it("does not treat a failed publish as a committed one", async () => {
    const rig = makeRig();
    rig.splits.failNext = new AppError("INTERNAL", "the transaction died");

    const error = await failure(publishOf(rig));

    expect(error.code).toBe("INTERNAL");
    expect(rig.splits.records.size).toBe(0);

    // The same key is still usable: nothing committed, so nothing is recorded.
    const retry = await publishOf(rig);
    expect(retry.replayed).toBe(false);
    expect(retry.expense.status).toBe("published");
  });

  it("writes nothing at all when the write fails mid-transaction", async () => {
    const rig = makeRig();
    rig.splits.failNext = new AppError("INTERNAL", "constraint violated");

    await failure(publishOf(rig));

    expect(rig.splits.splits.size).toBe(0);
    expect(rig.splits.records.size).toBe(0);
    expect(rig.expenses.records.get(EXPENSE)?.status).toBe("draft");
    expect(rig.expenses.records.get(EXPENSE)?.version).toBe(3);
    expect(rig.events.dispatched).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Events — SAD §3.2's ordering
// ─────────────────────────────────────────────────────────────────────────────

describe("PublishExpenseUseCase — domain events", () => {
  it("dispatches expense.published once, after the row is committed", async () => {
    const rig = makeRig();
    const seen: { status: string | undefined; writes: number }[] = [];
    rig.splits.beforeWrite = () => {
      seen.push({
        status: rig.expenses.records.get(EXPENSE)?.status,
        writes: 0,
      });
    };
    rig.events.onDispatch = () => {
      seen.push({
        status: rig.expenses.records.get(EXPENSE)?.status,
        writes: rig.splits.splits.size,
      });
    };

    await publishOf(rig);

    expect(seen).toEqual([
      { status: "draft", writes: 0 },
      { status: "published", writes: 1 },
    ]);
    expect(rig.events.dispatched).toHaveLength(1);
    expect(rig.events.dispatched[0]?.[0]).toMatchObject({
      name: "expense.published",
      expenseId: EXPENSE,
      societyId: SOCIETY,
      occurredAt: CLOCK.nowIso(),
      amount: { paise: 90_000n },
    });
  });

  it("never dispatches for a refused publication", async () => {
    const rig = makeRig(recordFixture({ status: "published" }));

    await failure(publishOf(rig));

    expect(rig.events.dispatched).toEqual([]);
  });

  it("leaves the bill published when the notification fails", async () => {
    const rig = makeRig();
    rig.events.failNext = new Error("push service is down");

    const publication = await publishOf(rig);

    // SAD §3.2: a failed notification never rolls back the bill.
    expect(publication.expense.status).toBe("published");
    expect(rig.expenses.records.get(EXPENSE)?.status).toBe("published");
    expect(rig.splits.splits.get(EXPENSE)).toHaveLength(4);
    // The key still names a committed publication, so a retry is a replay.
    const replay = await publishOf(rig);
    expect(replay.replayed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The request hash
// ─────────────────────────────────────────────────────────────────────────────

describe("publishRequestHash", () => {
  it("is stable for the same request and different for another version", () => {
    const a = publishRequestHash(EXPENSE, 3);
    const b = publishRequestHash(EXPENSE, 3);
    const c = publishRequestHash(EXPENSE, 4);
    const d = publishRequestHash(OTHER_EXPENSE, 3);

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
