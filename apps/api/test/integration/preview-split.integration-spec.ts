import type {
  ApartmentId,
  BuildingId,
  ExpenseCategoryId,
  ExpenseCategoryRepository,
  SocietyId,
  UserId,
} from "@ses/domain";
import type postgres from "postgres";

import { EXPENSE_CATEGORY_REPOSITORY } from "../../src/modules/expenses/application/expense-category.tokens";
import {
  PreviewSplitUseCase,
  type ExpenseSplitPreview,
  type PreviewSplitCommand,
} from "../../src/modules/expenses/application/use-cases/preview-split.use-case";

import { resetData } from "../utils/integration-db";
import {
  insertBuilding,
  insertMember,
  seedSociety,
  type SocietyFixture,
} from "../utils/integration-fixtures";
import {
  startIntegrationHarness,
  type IntegrationHarness,
} from "../utils/integration-harness";

/**
 * The split preview against real PostgreSQL, real RLS and the real engine — Roadmap
 * T064.
 *
 * ## What only this suite can prove
 *
 * The e2e suite fakes storage, so it can prove the contract, the guard chain, the
 * mapping and the engine over a world a test wrote down. Three claims need the real
 * database, and they are why this file exists:
 *
 *  1. **A preview writes nothing at all.** Every financial table is counted before
 *     and after a preview, with the preview's own allocations asserted in between —
 *     the Roadmap's first acceptance criterion, measured on the schema rather than
 *     argued from the absence of a repository in the wiring.
 *  2. **The apartment facts cross the numeric columns exactly.** `share_units` is
 *     `numeric(8, 3)`: the shares test reads a stored `2`, `1.5` and `1` through the
 *     real adapter and requires the engine to have weighed them as thousandths
 *     (`2_000 : 1_500 : 1_000`). A stored `1.5` that reached the engine as a float —
 *     or as a `BigInt` cast — would fail here, not in a fixture.
 *  3. **T063's real routing composes with T062's real category row and the 500-flat
 *     latency budget holds.** The owner-only test bills the trigger-seeded Sinking
 *     Fund against a rented flat with an owner and a tenant, and the load test runs
 *     500 participants through the whole operation end to end.
 *
 * Fixtures are written on the **owner** connection; every call under test runs
 * through `UnitOfWork` as the society's own Admin. `resetData` truncates between
 * tests, so each starts from empty.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
let preview: PreviewSplitUseCase;

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  preview = harness.app.get(PreviewSplitUseCase);
}, 60_000);

afterAll(async () => {
  await harness.stop();
});

/** The five tables a preview must leave untouched. */
const FINANCIAL_TABLES = [
  "expenses",
  "expense_splits",
  "expense_gst_details",
  "expense_revisions",
  "dues",
] as const;

async function financialCounts(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of FINANCIAL_TABLES) {
    const [row] = await owner<{ count: string }[]>`
      select count(*)::text as count from public.${owner(table)}
    `;
    counts[table] = Number(row?.count ?? "0");
  }
  return counts;
}

interface FlatSpec {
  readonly buildingId: BuildingId;
  readonly number: string;
  readonly floor: number;
  readonly occupancy?: "owner_occupied" | "rented" | "vacant";
  readonly bhk?: string;
  readonly carpetAreaSqft?: string;
  readonly builtupAreaSqft?: string;
  readonly parkingSlots?: number;
  readonly shareUnits?: string;
}

/** One flat, inserted as the owner — the real columns a basis reads. */
async function insertFlat(
  societyId: SocietyId,
  spec: FlatSpec,
): Promise<ApartmentId> {
  const [row] = await owner<{ id: string }[]>`
    insert into public.apartments (
      society_id, building_id, apartment_number, floor, bhk,
      carpet_area_sqft, builtup_area_sqft, parking_slots, share_units,
      occupancy_status, is_billable
    )
    values (
      ${societyId}::uuid,
      ${spec.buildingId}::uuid,
      ${spec.number},
      ${spec.floor}::smallint,
      ${spec.bhk ?? null}::numeric(3, 1),
      ${spec.carpetAreaSqft ?? null}::numeric(8, 2),
      ${spec.builtupAreaSqft ?? null}::numeric(8, 2),
      ${spec.parkingSlots ?? 0}::smallint,
      ${spec.shareUnits ?? "1"}::numeric(8, 3),
      ${spec.occupancy ?? "owner_occupied"}::public.occupancy_status,
      true::boolean
    )
    returning id
  `;
  return row!.id as ApartmentId;
}

async function categoryIdOf(
  societyId: SocietyId,
  actor: string,
  name: string,
): Promise<ExpenseCategoryId> {
  const categories = harness.app.get<ExpenseCategoryRepository>(
    EXPENSE_CATEGORY_REPOSITORY,
  );
  const listed = await categories.listCategories(societyId, actor as UserId);
  const category = listed.find((entry) => entry.name === name);
  if (category === undefined) {
    throw new Error(`The seeded category "${name}" is missing.`);
  }
  return category.id;
}

function previewFor(
  fixture: SocietyFixture,
  command: PreviewSplitCommand,
): Promise<ExpenseSplitPreview> {
  return preview.preview(fixture.adminUserId, fixture.societyId, command);
}

interface Fixture extends SocietyFixture {
  readonly north: BuildingId;
  readonly flats: {
    readonly P101: ApartmentId;
    readonly P102: ApartmentId;
    readonly P103: ApartmentId;
    readonly P104: ApartmentId;
  };
  readonly members: {
    readonly owner101: string;
    readonly owner102: string;
    readonly owner103: string;
    readonly tenant103: string;
  };
  readonly liftCategoryId: ExpenseCategoryId;
  readonly sinkingFundCategoryId: ExpenseCategoryId;
}

async function seed(): Promise<Fixture> {
  const society = await seedSociety(
    harness,
    "Preview Court",
    "admin@preview.ses.test",
  );
  const societyId = society.societyId;
  const north = await insertBuilding(owner, societyId, "North Block");

  // P101 and P102 owner-occupied; P103 rented with an owner *and* a tenant; P104
  // vacant with nobody attached.
  const P101 = await insertFlat(societyId, {
    buildingId: north,
    number: "P101",
    floor: 1,
    bhk: "2.0",
    carpetAreaSqft: "700.00",
    builtupAreaSqft: "875.00",
    parkingSlots: 1,
    shareUnits: "2",
  });
  const P102 = await insertFlat(societyId, {
    buildingId: north,
    number: "P102",
    floor: 1,
    bhk: "1.0",
    carpetAreaSqft: "400.00",
    builtupAreaSqft: "500.00",
    parkingSlots: 1,
    shareUnits: "1.5",
  });
  const P103 = await insertFlat(societyId, {
    buildingId: north,
    number: "P103",
    floor: 2,
    occupancy: "rented",
    bhk: "1.0",
    carpetAreaSqft: "350.00",
    builtupAreaSqft: "437.50",
    parkingSlots: 0,
    shareUnits: "1",
  });
  const P104 = await insertFlat(societyId, {
    buildingId: north,
    number: "P104",
    floor: 3,
    occupancy: "vacant",
    bhk: "1.0",
    carpetAreaSqft: "350.00",
    builtupAreaSqft: "437.50",
    parkingSlots: 0,
    shareUnits: "1",
  });

  const owner101 = await insertMember(owner, societyId, {
    apartmentId: P101,
    occupancy: "owner_occupied",
    isPrimary: true,
    displayName: "Owner 101",
  });
  const owner102 = await insertMember(owner, societyId, {
    apartmentId: P102,
    occupancy: "owner_occupied",
    isPrimary: true,
    displayName: "Owner 102",
  });
  const owner103 = await insertMember(owner, societyId, {
    apartmentId: P103,
    occupancy: "vacant_owner",
    isPrimary: false,
    displayName: "Owner 103",
  });
  const tenant103 = await insertMember(owner, societyId, {
    apartmentId: P103,
    occupancy: "tenant",
    isPrimary: true,
    displayName: "Tenant 103",
  });

  const liftCategoryId = await categoryIdOf(
    societyId,
    society.adminUserId,
    "Lift",
  );
  const sinkingFundCategoryId = await categoryIdOf(
    societyId,
    society.adminUserId,
    "Sinking Fund",
  );

  // The Lift row gets a stored default pair, so the preview's category-defaults
  // read is exercised against a real `expense_categories` row.
  await owner`
    update public.expense_categories
       set default_split_strategy = 'apartment',
           default_apartment_basis = 'per_sqft_carpet'
     where id = ${liftCategoryId}::uuid
  `;

  return {
    ...society,
    north,
    flats: { P101, P102, P103, P104 },
    members: { owner101, owner102, owner103, tenant103 },
    liftCategoryId,
    sinkingFundCategoryId,
  };
}

describe("PreviewSplitUseCase against real storage", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  it("computes a split from real rows and writes nothing at all", async () => {
    const before = await financialCounts();
    // The precondition, asserted rather than assumed: the fixture seeded no money.
    expect(Object.values(before)).toEqual([0, 0, 0, 0, 0]);

    const result = await previewFor(fixture, {
      amountPaise: 10_000,
      selector: {},
    });

    expect(result.allocations.map((entry) => entry.apartmentNumber)).toEqual([
      "P101",
      "P102",
      "P103",
    ]);
    // 10_000 ÷ 3 over the tenant of the rented flat; the odd paisa to P101.
    expect(result.allocations.map((entry) => entry.amount.paise)).toEqual([
      3334n,
      3333n,
      3333n,
    ]);
    expect(result.residualPaise).toBe(0n);
    // The vacant P104 is billable and has nobody to address the charge to.
    expect(result.unassigned).toEqual([
      {
        apartmentId: fixture.flats.P104,
        apartmentNumber: "P104",
        reason: "unassigned_no_member",
      },
    ]);

    // The whole acceptance criterion, measured: not one row in any financial table.
    expect(await financialCounts()).toEqual(before);
  });

  it("takes the basis from the category's stored row and weighs the real carpet areas", async () => {
    const result = await previewFor(fixture, {
      amountPaise: 10_000,
      selector: {},
      categoryId: fixture.liftCategoryId,
    });

    // 700 : 400 : 350 = 14 : 8 : 7 over 10_000 paise — 4827.58 / 2758.62 / 2413.79;
    // the two residual paise go to the largest remainders (P103, then P102).
    expect(result.allocations.map((entry) => entry.amount.paise)).toEqual([
      4827n,
      2759n,
      2414n,
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("crosses the stored numeric(8,3) share units into the engine's thousandths", async () => {
    const result = await previewFor(fixture, {
      amountPaise: 10_000,
      selector: {},
      splitStrategy: "shares",
    });

    // Stored 2 : 1.5 : 1 shares → 2000 : 1500 : 1000 thousandths →
    // 4444.44 / 3333.33 / 2222.22; the residual paisa to P101's larger remainder.
    expect(result.allocations.map((entry) => entry.amount.paise)).toEqual([
      4445n,
      3333n,
      2222n,
    ]);
    expect(result.allocations.map((entry) => entry.weight)).toEqual([
      2000n,
      1500n,
      1000n,
    ]);
  });

  it("routes the rented flat to its owner for the trigger-seeded owner-only category", async () => {
    const result = await previewFor(fixture, {
      amountPaise: 10_000,
      selector: {},
      categoryId: fixture.sinkingFundCategoryId,
    });

    const charged = result.allocations.find(
      (entry) => entry.apartmentNumber === "P103",
    );
    expect(charged?.memberId).toBe(fixture.members.owner103);
    // The vacant, member-less flat has no owner either, so it is flagged rather than
    // billed to anybody.
    expect(result.unassigned.map((entry) => entry.apartmentNumber)).toEqual([
      "P104",
    ]);
    expect(result.unassigned[0]?.reason).toBe("unassigned_no_owner");
  });

  it("meets the latency budget: p95 under 150 ms for 500 participants", async () => {
    // A second society, large enough to be the acceptance case, seeded in two bulk
    // statements: 500 flats, then one owner per flat.
    const large = await seedSociety(
      harness,
      "Scale Court",
      "admin@scale.ses.test",
    );
    const building = await insertBuilding(
      owner,
      large.societyId,
      "Scale Block",
    );
    await owner`
      insert into public.apartments (
        society_id, building_id, apartment_number, floor, bhk,
        carpet_area_sqft, builtup_area_sqft, parking_slots, share_units,
        occupancy_status, is_billable
      )
      select
        ${large.societyId}::uuid,
        ${building}::uuid,
        'B' || lpad(series::text, 3, '0'),
        1 + (series % 20),
        '2.0'::numeric(3, 1),
        '600.00'::numeric(8, 2),
        '750.00'::numeric(8, 2),
        (series % 3)::smallint,
        '1'::numeric(8, 3),
        'owner_occupied'::public.occupancy_status,
        true::boolean
      from generate_series(1, 500) as series
    `;
    await owner`
      insert into public.members (
        society_id, apartment_id, display_name, role, status, occupancy, is_primary
      )
      select
        apartment.society_id,
        apartment.id,
        'Owner ' || apartment.apartment_number,
        'resident'::public.member_role,
        'active'::public.member_status,
        'owner_occupied'::public.occupancy_type,
        true
      from public.apartments apartment
      where apartment.society_id = ${large.societyId}::uuid
        and apartment.apartment_number like 'B%'
    `;

    // A warm-up call, so the samples measure the operation rather than the first
    // statement's parse.
    const warmUp = await previewFor(large, {
      amountPaise: 60_000_000,
      selector: {},
    });
    expect(warmUp.participantCount).toBe(500);
    expect(warmUp.allocations[0]?.amount.paise).toBe(120_000n);

    const samples: number[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const started = performance.now();
      const result = await previewFor(large, {
        amountPaise: 60_000_000,
        selector: {},
      });
      samples.push(performance.now() - started);
      expect(result.participantCount).toBe(500);
    }

    const ordered = [...samples].sort((left, right) => left - right);
    const p95 = ordered[Math.ceil(ordered.length * 0.95) - 1]!;
    // One assertion over the measurement rather than `expect(p95).toBeLessThan`,
    // so a failure prints every sample instead of only the percentile.
    expect({
      withinBudget: p95 < 150,
      measuredP95Ms: p95,
      samples: ordered,
    }).toMatchObject({ withinBudget: true });
  }, 120_000);
});
