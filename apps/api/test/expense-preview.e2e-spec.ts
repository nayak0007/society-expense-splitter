import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { asMemberId, asSocietyId, asUserId } from "@ses/domain";
import type {
  MemberRole,
  MembershipStatus,
  Society,
  SocietyId,
  SocietyMembership,
  StructureMembershipReader,
  UserId,
} from "@ses/domain";
import request from "supertest";

import type { SocietyAuthorizationContext } from "../src/common/authorization/society-authorization";
import {
  createFakeCategoryRepository,
  type FakeCategoryRepository,
} from "./utils/fake-category-repository";
import {
  FakeParticipantDirectory,
  apartmentFixture,
  id,
  memberFixture,
} from "./utils/fake-participant-directory";
import { createTestAuth, type TestAuth } from "./utils/supabase-auth";
import { createTestApp } from "./utils/test-app";

/**
 * `POST /v1/expenses/preview-split` over real HTTP — Roadmap T064.
 *
 * ## What runs for real
 *
 * The whole guard chain (a real signature over a locally held key pair, `X-Society-Id`
 * resolved to a membership, the matrix asked), the Zod pipe parsing the real contract,
 * the preview use case, T063's resolver composition, the **real split engine**, the
 * response mapper and the envelope. Only storage is faked (the category store and the
 * participant directory), which is the same boundary the T062 suite draws: a fake here
 * still fails when a rule regresses.
 *
 * ## The matrix this file pins
 *
 * The Roadmap's acceptance and test list, plus the tenancy rules the module inherits:
 * authentication and the society header, Guest/Resident refusal and Committee Member
 * acceptance, one preview per strategy with hand-calculated amounts (including the odd
 * paisa), every apartment basis, category defaults, owner-only routing, vacancy policy,
 * missing-metric warnings, an unassigned flat flagged rather than dropped, cross-society
 * references answered `not_found`, engine refusals surfaced as `422` with the field, and
 * byte-identical output for identical input.
 *
 * The one property this suite cannot prove is that nothing was written — the seams are
 * fakes with no write surface. That proof lives in the integration suite, which counts
 * the rows against real PostgreSQL.
 */

const SOCIETY_A = asSocietyId("b1f0c8e2-4a7d-4f1e-9b23-6c5d8e9f0a12");
const SOCIETY_B = asSocietyId("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

const ADMIN: UserId = asUserId("11111111-1111-4111-8111-111111111111");
const TREASURER: UserId = asUserId("22222222-2222-4222-8222-222222222222");
const RESIDENT: UserId = asUserId("33333333-3333-4333-8333-333333333333");
const COMMITTEE: UserId = asUserId("77777777-7777-4777-8777-777777777777");
const GUEST: UserId = asUserId("44444444-4444-4444-8444-444444444444");
const PENDING: UserId = asUserId("55555555-5555-4555-8555-555555555555");
const OUTSIDER: UserId = asUserId("66666666-6666-4666-8666-666666666666");

const societies = new Map<string, Society>([
  [
    SOCIETY_A,
    {
      id: SOCIETY_A,
      name: "Green Meadows",
      city: "Pune",
    } as unknown as Society,
  ],
  [
    SOCIETY_B,
    { id: SOCIETY_B, name: "Palm Grove", city: "Pune" } as unknown as Society,
  ],
]);

function membershipOf(
  actor: UserId,
  role: MemberRole,
  status: MembershipStatus = "active",
): SocietyMembership {
  return {
    id: asMemberId(id(`membership-${actor}`)),
    societyId: SOCIETY_A,
    userId: actor,
    role,
    status,
    occupancyType: "owner",
    joinedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** (society, actor) → membership, read by the guard and the use cases alike. */
const memberships = new Map<string, SocietyMembership>();
const key = (societyId: string, actor: string) => `${societyId}:${actor}`;

const reader = {
  load(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyAuthorizationContext | null> {
    const membership = memberships.get(key(societyId, actor));
    const society = societies.get(societyId);
    if (membership === undefined || society === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve({ society, membership });
  },
};

const membershipReader: StructureMembershipReader = {
  findMembership(societyId, actor) {
    return Promise.resolve(memberships.get(key(societyId, actor)) ?? null);
  },
};

let app: NestFastifyApplication;
let auth: TestAuth;
let categories: FakeCategoryRepository;
let directory: FakeParticipantDirectory;

beforeAll(async () => {
  auth = await createTestAuth();
  categories = createFakeCategoryRepository();
  directory = new FakeParticipantDirectory();
  app = await createTestApp({
    jwks: auth.jwks,
    reader,
    membershipReader,
    categories,
    participants: directory,
  });
});

afterAll(async () => {
  await app.close();
});

/** The base world: two owner-occupied flats, one rented (tenant only), one empty. */
function seedBaseWorld(): void {
  directory.seedDirectory(SOCIETY_A, {
    apartments: [
      apartmentFixture("101", {
        floor: 1,
        carpetAreaSqft: 700,
        builtupAreaSqft: 800,
        bhk: 2,
        parkingSlots: 2,
        shareUnits: 2,
      }),
      apartmentFixture("102", {
        floor: 2,
        carpetAreaSqft: 350,
        builtupAreaSqft: 400,
        bhk: 1,
        parkingSlots: 1,
        shareUnits: 1,
      }),
      apartmentFixture("103", {
        floor: 2,
        carpetAreaSqft: 350,
        builtupAreaSqft: 400,
        bhk: 1,
        parkingSlots: 0,
        shareUnits: 1,
        occupancyStatus: "rented",
      }),
      apartmentFixture("104", {
        floor: 3,
        carpetAreaSqft: 350,
        builtupAreaSqft: 400,
        bhk: 1,
        parkingSlots: 0,
      }),
    ],
    members: [
      memberFixture("m101", "101"),
      memberFixture("m102", "102"),
      memberFixture("t103", "103", { occupancy: "tenant" }),
    ],
  });
  directory.seedBillVacantFlats(SOCIETY_A, true);
}

beforeEach(() => {
  memberships.clear();
  categories.state.categories.clear();
  categories.state.references.clear();
  categories.state.calls.length = 0;
  directory.reset();

  memberships.set(key(SOCIETY_A, ADMIN), membershipOf(ADMIN, "admin"));
  memberships.set(
    key(SOCIETY_A, TREASURER),
    membershipOf(TREASURER, "treasurer"),
  );
  memberships.set(key(SOCIETY_A, RESIDENT), membershipOf(RESIDENT, "resident"));
  memberships.set(
    key(SOCIETY_A, COMMITTEE),
    membershipOf(COMMITTEE, "committee_member"),
  );
  memberships.set(key(SOCIETY_A, GUEST), membershipOf(GUEST, "guest"));
  memberships.set(
    key(SOCIETY_A, PENDING),
    membershipOf(PENDING, "resident", "pending"),
  );
  memberships.set(key(SOCIETY_B, ADMIN), {
    ...membershipOf(ADMIN, "admin"),
    societyId: SOCIETY_B,
  });

  seedBaseWorld();
});

const server = () => request(app.getHttpServer());

async function call(
  path: string,
  options: {
    readonly userId?: UserId;
    readonly societyId?: string | null;
    readonly body?: unknown;
  } = {},
) {
  let pending = server().post(path);

  if (options.userId !== undefined) {
    pending = pending.set(
      "Authorization",
      `Bearer ${await auth.token(options.userId)}`,
    );
  }
  if (options.societyId !== null && options.societyId !== undefined) {
    pending = pending.set("X-Society-Id", options.societyId);
  }
  if (options.body !== undefined) {
    pending = pending.send(options.body as object);
  }
  return pending;
}

const PREVIEW = "/v1/expenses/preview-split";

interface CallOptions {
  readonly userId?: UserId;
  readonly societyId?: string | null;
  readonly body?: unknown;
}

function preview(body: unknown, options: Omit<CallOptions, "body"> = {}) {
  return call(PREVIEW, {
    userId: options.userId ?? ADMIN,
    societyId: options.societyId === undefined ? SOCIETY_A : options.societyId,
    body,
  });
}

const equalBody = (overrides: Record<string, unknown> = {}) => ({
  amountPaise: 10_000,
  participantSelector: {},
  ...overrides,
});

function amountsOf(response: request.Response): number[] {
  return (response.body.data.allocations as { amountPaise: number }[]).map(
    (allocation) => allocation.amountPaise,
  );
}

function numbersOf(response: request.Response): string[] {
  return (response.body.data.allocations as { apartmentNumber: string }[]).map(
    (allocation) => allocation.apartmentNumber,
  );
}

describe("authentication and the society header", () => {
  it("requires a session before anything else", async () => {
    const response = await call(PREVIEW, {
      societyId: SOCIETY_A,
      body: equalBody(),
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("requires X-Society-Id, with the field named", async () => {
    const response = await call(PREVIEW, { userId: ADMIN, body: equalBody() });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("x-society-id");
  });

  it("answers 404 — not 403 — for a society the caller is not in", async () => {
    const response = await preview(equalBody(), { userId: OUTSIDER });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("refuses a pending membership with MEMBER_INACTIVE", async () => {
    const response = await preview(equalBody(), { userId: PENDING });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("MEMBER_INACTIVE");
  });
});

describe("permissions", () => {
  it("refuses a Guest — expense.create is not theirs", async () => {
    const response = await preview(equalBody(), { userId: GUEST });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("refuses a Resident — composing an expense is staff work", async () => {
    const response = await preview(equalBody(), { userId: RESIDENT });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("lets a Committee Member preview — the cell is draft-only, and this is a draft", async () => {
    const response = await preview(equalBody(), { userId: COMMITTEE });

    expect(response.status).toBe(200);
    expect(response.body.data.participantCount).toBe(3);
  });

  it("lets a Treasurer preview", async () => {
    const response = await preview(equalBody(), { userId: TREASURER });

    expect(response.status).toBe(200);
    expect(response.body.data.totalPaise).toBe(10_000);
  });
});

describe("equal split", () => {
  it("returns the PRD's shape with hand-calculated amounts and the residual placed", async () => {
    const response = await preview(equalBody());

    expect(response.status).toBe(200);
    expect(response.body.data.totalPaise).toBe(10_000);
    expect(response.body.data.participantCount).toBe(3);
    expect(numbersOf(response)).toEqual(["101", "102", "103"]);
    // 10_000 ÷ 3 = 3333 each; the odd paisa goes to the first flat in apartment order.
    expect(amountsOf(response)).toEqual([3334, 3333, 3333]);
    expect(response.body.data.residualPaise).toBe(0);
    expect(response.body.data.warnings).toEqual([]);
  });

  it("flags a flat with nobody attached instead of dropping it", async () => {
    const response = await preview(equalBody());

    expect(response.body.data.unassigned).toEqual([
      {
        apartmentId: id("104"),
        apartmentNumber: "104",
        reason: "unassigned_no_member",
      },
    ]);
  });

  it("is the same preview for the same input, byte for byte", async () => {
    const first = await preview(equalBody());
    const second = await preview(equalBody());

    // `meta` is the envelope's own per-request stamp (`requestId`, `timestamp`), so the
    // determinism claim is about the payload: the same rows and the same amounts, in
    // the same order, including which flat carries the residual paisa.
    expect(second.status).toBe(first.status);
    expect(second.body.data).toEqual(first.body.data);
    expect(Array.isArray(second.body.data.allocations)).toBe(true);
  });
});

describe("percentage split", () => {
  it("computes an explicit 60/40 split and leaves an omitted flat at 0%", async () => {
    const response = await preview(
      equalBody({
        splitStrategy: "percentage",
        splitConfig: {
          percentages: [
            { apartmentId: id("101"), basisPoints: 6000 },
            { apartmentId: id("102"), basisPoints: 4000 },
          ],
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(amountsOf(response)).toEqual([6000, 4000, 0]);
  });

  it("surfaces the engine's refusal when the percentages do not reach 100%", async () => {
    const response = await preview(
      equalBody({
        splitStrategy: "percentage",
        splitConfig: {
          percentages: [{ apartmentId: id("101"), basisPoints: 5000 }],
        },
      }),
    );

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("participants.percentage");
  });

  it("refuses a reference to a flat outside the resolved set", async () => {
    const response = await preview(
      equalBody({
        splitStrategy: "percentage",
        splitConfig: {
          percentages: [{ apartmentId: id("999"), basisPoints: 10_000 }],
        },
      }),
    );

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("splitConfig.percentages");
  });

  it("refuses the same flat twice", async () => {
    const response = await preview(
      equalBody({
        splitStrategy: "percentage",
        splitConfig: {
          percentages: [
            { apartmentId: id("101"), basisPoints: 5000 },
            { apartmentId: id("101"), basisPoints: 5000 },
          ],
        },
      }),
    );

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("splitConfig.percentages");
  });
});

describe("shares split", () => {
  it("takes explicit shares and defaults the rest to the flat's stored units", async () => {
    const response = await preview(
      equalBody({
        splitStrategy: "shares",
        splitConfig: {
          shares: [
            { apartmentId: id("101"), shareUnits: 3000 },
            { apartmentId: id("102"), shareUnits: 1500 },
          ],
        },
      }),
    );

    expect(response.status).toBe(200);
    // 3 : 1.5 : 1 shares over 10_000 paise → 5454.54 / 2727.27 / 1818.18; the residual
    // paisa goes to the largest remainder (the 3-share flat).
    expect(amountsOf(response)).toEqual([5455, 2727, 1818]);
  });

  it("refuses a flat whose stored share is zero, naming the engine's field", async () => {
    directory.seedDirectory(SOCIETY_A, {
      apartments: [
        apartmentFixture("101", { shareUnits: 0 }),
        apartmentFixture("102", { shareUnits: 1 }),
      ],
      members: [memberFixture("m101", "101"), memberFixture("m102", "102")],
    });

    const response = await preview(equalBody({ splitStrategy: "shares" }));

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("participants.share");
  });
});

describe("custom split", () => {
  it("allocates the treasurer's exact figures and excludes by omission", async () => {
    const response = await preview(
      equalBody({
        splitStrategy: "custom",
        splitConfig: {
          customAmounts: [
            { apartmentId: id("101"), amountPaise: 6000 },
            { apartmentId: id("102"), amountPaise: 4000 },
          ],
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(numbersOf(response)).toEqual(["101", "102"]);
    expect(amountsOf(response)).toEqual([6000, 4000]);
  });

  it("surfaces a sum that does not balance as a validation error", async () => {
    const response = await preview(
      equalBody({
        splitStrategy: "custom",
        splitConfig: {
          customAmounts: [{ apartmentId: id("101"), amountPaise: 6000 }],
        },
      }),
    );

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("participants.amount");
  });
});

function weightsOf(response: request.Response): number[] {
  return (response.body.data.allocations as { weight: number }[]).map(
    (allocation) => allocation.weight,
  );
}

function unassignedOf(
  response: request.Response,
): { apartmentNumber: string; reason: string }[] {
  return (
    response.body.data.unassigned as {
      apartmentNumber: string;
      reason: string;
    }[]
  ).map(({ apartmentNumber, reason }) => ({ apartmentNumber, reason }));
}

/**
 * A bare three-flat world — no 104, so a basis test reads only the flats it seeded.
 * The members are the same three the base world has: two owners and a tenant.
 */
function seedThreeFlats(
  flats: readonly [
    ReturnType<typeof apartmentFixture>,
    ReturnType<typeof apartmentFixture>,
    ReturnType<typeof apartmentFixture>,
  ],
): void {
  directory.seedDirectory(SOCIETY_A, {
    apartments: flats,
    members: [
      memberFixture("m101", "101"),
      memberFixture("m102", "102"),
      memberFixture("t103", "103", { occupancy: "tenant" }),
    ],
  });
  directory.seedBillVacantFlats(SOCIETY_A, true);
}

const apartmentBody = (basis: string, extra: Record<string, unknown> = {}) => ({
  splitStrategy: "apartment",
  apartmentBasis: basis,
  ...extra,
});

describe("apartment strategy, one basis at a time", () => {
  it("per_flat weighs every resolved flat equally — equal, scoped to flats", async () => {
    const response = await preview(equalBody(apartmentBody("per_flat")));

    expect(response.status).toBe(200);
    expect(numbersOf(response)).toEqual(["101", "102", "103"]);
    expect(amountsOf(response)).toEqual([3334, 3333, 3333]);
    expect(weightsOf(response)).toEqual([1, 1, 1]);
    expect(response.body.data.warnings).toEqual([]);
  });

  it("per_sqft_carpet weighs hundredths of a square foot", async () => {
    seedThreeFlats([
      apartmentFixture("101", { floor: 1, carpetAreaSqft: 600 }),
      apartmentFixture("102", { floor: 2, carpetAreaSqft: 300 }),
      apartmentFixture("103", {
        floor: 3,
        carpetAreaSqft: 100,
        occupancyStatus: "rented",
      }),
    ]);

    const response = await preview(equalBody(apartmentBody("per_sqft_carpet")));

    expect(response.status).toBe(200);
    // 600 : 300 : 100 = 6 : 3 : 1 over 10_000 paise.
    expect(amountsOf(response)).toEqual([6000, 3000, 1000]);
    expect(weightsOf(response)).toEqual([60_000, 30_000, 10_000]);
  });

  it("per_sqft_builtup weighs the built-up column, not the carpet one", async () => {
    seedThreeFlats([
      apartmentFixture("101", {
        floor: 1,
        carpetAreaSqft: 700,
        builtupAreaSqft: 800,
      }),
      apartmentFixture("102", {
        floor: 2,
        carpetAreaSqft: 350,
        builtupAreaSqft: 600,
      }),
      apartmentFixture("103", {
        floor: 3,
        carpetAreaSqft: 350,
        builtupAreaSqft: 200,
        occupancyStatus: "rented",
      }),
    ]);

    const response = await preview(
      equalBody(apartmentBody("per_sqft_builtup")),
    );

    expect(amountsOf(response)).toEqual([5000, 3750, 1250]);
    expect(weightsOf(response)).toEqual([80_000, 60_000, 20_000]);
  });

  it("per_bhk weighs the configuration in tenths", async () => {
    seedThreeFlats([
      apartmentFixture("101", { floor: 1, bhk: 3 }),
      apartmentFixture("102", { floor: 2, bhk: 2 }),
      apartmentFixture("103", { floor: 3, bhk: 1, occupancyStatus: "rented" }),
    ]);

    const response = await preview(equalBody(apartmentBody("per_bhk")));

    // 3 : 2 : 1 BHK over 10_000 paise — 5000 / 3333.33 / 1666.67, the residual
    // paisa to the largest remainder (the 1-BHK flat's .66…).
    expect(amountsOf(response)).toEqual([5000, 3333, 1667]);
    expect(weightsOf(response)).toEqual([30, 20, 10]);
  });

  it("per_floor_band matches floors against the configured bands", async () => {
    // Base world floors: 101 → 1, 102 and 103 → 2.
    const response = await preview(
      equalBody(
        apartmentBody("per_floor_band", {
          splitConfig: {
            floorBands: [
              { from: 0, to: 0, mult: 0 },
              { from: 1, to: 1, mult: 1 },
              { from: 2, to: 5, mult: 3 },
            ],
          },
        }),
      ),
    );

    expect(response.status).toBe(200);
    // A band's multiplier is weighed in thousandths: 1× is 1000, 3× is 3000.
    expect(weightsOf(response)).toEqual([1000, 3000, 3000]);
    expect(amountsOf(response)).toEqual([1428, 4286, 4286]);
  });

  it("per_parking_slot weighs the slot count and keeps a slot-less flat at ₹0", async () => {
    // Base world slots: 101 → 2, 102 → 1, 103 → 0.
    const response = await preview(
      equalBody(apartmentBody("per_parking_slot")),
    );

    expect(response.status).toBe(200);
    expect(weightsOf(response)).toEqual([2, 1, 0]);
    expect(amountsOf(response)).toEqual([6667, 3333, 0]);
    // The zero is a considered answer, not an omission: the flat is in the split.
    expect(numbersOf(response)).toEqual(["101", "102", "103"]);
  });
});

describe("the category's defaults and its owner-only rule", () => {
  it("takes the strategy and the basis from the category when the request omits both", async () => {
    const category = categories.seed(SOCIETY_A, {
      name: "Sinking Fund",
      defaultSplitStrategy: "apartment",
      defaultApartmentBasis: "per_bhk",
    });

    const response = await preview(equalBody({ categoryId: category.id }));

    expect(response.status).toBe(200);
    // Base world BHK 2 : 1 : 1 — the category's own default priced it.
    expect(amountsOf(response)).toEqual([5000, 2500, 2500]);
    expect(weightsOf(response)).toEqual([20, 10, 10]);
  });

  it("lets the request override the category's default strategy", async () => {
    const category = categories.seed(SOCIETY_A, {
      name: "Sinking Fund",
      defaultSplitStrategy: "apartment",
      defaultApartmentBasis: "per_bhk",
    });

    const response = await preview(
      equalBody({ categoryId: category.id, splitStrategy: "equal" }),
    );

    expect(response.status).toBe(200);
    expect(amountsOf(response)).toEqual([3334, 3333, 3333]);
  });

  it("answers 404 for another society's category and for a deleted one", async () => {
    const foreign = categories.seed(SOCIETY_B, { name: "Water" });
    const deleted = categories.seed(SOCIETY_A, {
      name: "Retired head",
      deleted: true,
    });

    const crossTenant = await preview(equalBody({ categoryId: foreign.id }));
    expect(crossTenant.status).toBe(404);
    expect(crossTenant.body.error.code).toBe("NOT_FOUND");

    const softDeleted = await preview(equalBody({ categoryId: deleted.id }));
    expect(softDeleted.status).toBe(404);
    expect(softDeleted.body.error.code).toBe("NOT_FOUND");
  });

  it("bills an owner-only category's rented flat to its owner, not its tenant", async () => {
    directory.seedDirectory(SOCIETY_A, {
      apartments: [
        apartmentFixture("101", { floor: 1 }),
        apartmentFixture("102", { floor: 2 }),
        apartmentFixture("103", { floor: 2, occupancyStatus: "rented" }),
      ],
      members: [
        memberFixture("m101", "101"),
        memberFixture("m102", "102"),
        memberFixture("owner-103", "103", { occupancy: "vacant_owner" }),
        memberFixture("t103", "103", {
          occupancy: "tenant",
          isPrimary: false,
        }),
      ],
    });
    directory.seedBillVacantFlats(SOCIETY_A, true);
    const category = categories.seed(SOCIETY_A, {
      name: "Sinking Fund",
      isOwnerOnly: true,
    });

    const response = await preview(equalBody({ categoryId: category.id }));

    expect(response.status).toBe(200);
    expect(numbersOf(response)).toEqual(["101", "102", "103"]);
    expect(amountsOf(response)).toEqual([3334, 3333, 3333]);
    const charged = (
      response.body.data.allocations as {
        apartmentNumber: string;
        memberId: string;
      }[]
    ).find((allocation) => allocation.apartmentNumber === "103");
    expect(charged?.memberId).toBe(id("owner-103"));
  });

  it("flags both member-less flats as unassigned_no_owner under an owner-only category", async () => {
    // Base world: 103 has only a tenant, 104 has nobody at all. Neither has an owner
    // to address an owner-only charge to, so both are flagged — never dropped, and
    // never charged to the tenant who is not the owner this bill is about.
    const category = categories.seed(SOCIETY_A, {
      name: "Sinking Fund",
      isOwnerOnly: true,
    });

    const response = await preview(equalBody({ categoryId: category.id }));

    expect(response.status).toBe(200);
    expect(numbersOf(response)).toEqual(["101", "102"]);
    expect(amountsOf(response)).toEqual([5000, 5000]);
    expect(unassignedOf(response)).toEqual([
      { apartmentNumber: "103", reason: "unassigned_no_owner" },
      { apartmentNumber: "104", reason: "unassigned_no_owner" },
    ]);
  });
});

describe("the society's vacancy policy", () => {
  /** Two owners plus a vacant flat nobody is linked to. */
  function seedWithVacant(): void {
    directory.seedDirectory(SOCIETY_A, {
      apartments: [
        apartmentFixture("101", { floor: 1 }),
        apartmentFixture("102", { floor: 2 }),
        apartmentFixture("105", { floor: 4, occupancyStatus: "vacant" }),
      ],
      members: [memberFixture("m101", "101"), memberFixture("m102", "102")],
    });
  }

  it("bills a vacant flat by default and reports it unassigned rather than dropping it", async () => {
    seedWithVacant();
    directory.seedBillVacantFlats(SOCIETY_A, true);

    const response = await preview(equalBody());

    expect(numbersOf(response)).toEqual(["101", "102"]);
    expect(amountsOf(response)).toEqual([5000, 5000]);
    expect(unassignedOf(response)).toEqual([
      { apartmentNumber: "105", reason: "unassigned_no_member" },
    ]);
  });

  it("lets the selector opt out of vacant flats", async () => {
    seedWithVacant();
    directory.seedBillVacantFlats(SOCIETY_A, true);

    const response = await preview(
      equalBody({ participantSelector: { includeVacant: false } }),
    );

    expect(numbersOf(response)).toEqual(["101", "102"]);
    expect(unassignedOf(response)).toEqual([]);
  });

  it("keeps the setting as the floor — a selector cannot opt in", async () => {
    seedWithVacant();
    directory.seedBillVacantFlats(SOCIETY_A, false);

    const response = await preview(
      equalBody({ participantSelector: { includeVacant: true } }),
    );

    expect(numbersOf(response)).toEqual(["101", "102"]);
    expect(unassignedOf(response)).toEqual([]);
  });
});

describe("missing and impossible apartment facts", () => {
  it("excludes a flat with no carpet area and reports MISSING_AREA naming it", async () => {
    seedThreeFlats([
      apartmentFixture("101", { floor: 1, carpetAreaSqft: 700 }),
      apartmentFixture("102", { floor: 2, carpetAreaSqft: null }),
      apartmentFixture("103", {
        floor: 3,
        carpetAreaSqft: 350,
        occupancyStatus: "rented",
      }),
    ]);

    const response = await preview(equalBody(apartmentBody("per_sqft_carpet")));

    expect(response.status).toBe(200);
    expect(numbersOf(response)).toEqual(["101", "103"]);
    // 700 : 350 over the flats that have an area — 6666.67 / 3333.33.
    expect(amountsOf(response)).toEqual([6667, 3333]);
    expect(response.body.data.warnings).toEqual([
      {
        code: "MISSING_AREA",
        message: expect.any(String) as unknown as string,
        apartmentIds: [id("102")],
      },
    ]);
  });

  it("refuses a recorded but impossible area as a field error, not a warning", async () => {
    seedThreeFlats([
      apartmentFixture("101", { floor: 1, carpetAreaSqft: 700 }),
      apartmentFixture("102", { floor: 2, carpetAreaSqft: 0 }),
      apartmentFixture("103", {
        floor: 3,
        carpetAreaSqft: 350,
        occupancyStatus: "rented",
      }),
    ]);

    const response = await preview(equalBody(apartmentBody("per_sqft_carpet")));

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("participants.carpetAreaSqft");
  });
});

describe("request validation and its order", () => {
  it("refuses a non-positive or fractional amount in the contract", async () => {
    // Two failure kinds, two statuses (SAD §7.8): a value the rule refuses is
    // semantic (422), while a value of the wrong *shape* is syntactic (400) — a
    // fractional paise is not an integer, so the payload itself is malformed.
    const zero = await preview(equalBody({ amountPaise: 0 }));
    expect(zero.status).toBe(422);
    expect(zero.body.error.code).toBe("VALIDATION_ERROR");

    const fractional = await preview(equalBody({ amountPaise: 100.5 }));
    expect(fractional.status).toBe(400);
    expect(fractional.body.error.code).toBe("VALIDATION_ERROR");
    expect(fractional.body.error.field).toBe("amountPaise");
  });

  it("requires the participant selector", async () => {
    const response = await preview({ amountPaise: 10_000 });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("is strict about the strategy vocabulary and unknown keys", async () => {
    // An unknown enum member is a value the vocabulary refuses → 422; an unknown
    // key is a malformed payload (strict schemas reject it) → 400.
    const strategy = await preview(equalBody({ splitStrategy: "allocation" }));
    expect(strategy.status).toBe(422);
    expect(strategy.body.error.code).toBe("VALIDATION_ERROR");

    const extra = await preview(equalBody({ societyId: SOCIETY_A }));
    expect(extra.status).toBe(400);
    expect(extra.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("asks for a basis before it reads the directory at all", async () => {
    const response = await preview(equalBody({ splitStrategy: "apartment" }));

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("apartmentBasis");
    // The plan is decided before resolution: a missing basis costs no participant read.
    expect(directory.callsOf("listSocietyParticipants")).toBe(0);
  });

  it("surfaces the engine's own floor-band refusals", async () => {
    const empty = await preview(equalBody(apartmentBody("per_floor_band")));
    expect(empty.status).toBe(422);
    expect(empty.body.error.field).toBe("floorBands");

    const overlapping = await preview(
      equalBody(
        apartmentBody("per_floor_band", {
          splitConfig: {
            floorBands: [
              { from: 1, to: 3, mult: 1 },
              { from: 3, to: 5, mult: 2 },
            ],
          },
        }),
      ),
    );
    expect(overlapping.status).toBe(422);
    expect(overlapping.body.error.field).toBe("floorBands");
  });

  it("refuses a selector that matches no billable flat", async () => {
    const response = await preview(
      equalBody({
        participantSelector: {
          excludeApartments: ["101", "102", "103", "104"].map(id),
        },
      }),
    );

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe("selector");
  });
});

describe("tenant isolation", () => {
  it("answers 404 for a building this society does not have", async () => {
    // A literal uuid, not `id(...)`: the helper truncates to twelve hex digits, so
    // `id("building-9")` would collide with the `id("building-1")` the fixtures use.
    const response = await preview(
      equalBody({
        participantSelector: {
          buildings: ["99999999-9999-4999-8999-999999999999"],
        },
      }),
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(response.body.error.field).toBe("selector.buildings");
  });

  it("answers 404 for another society's apartment in excludeApartments", async () => {
    const foreign = apartmentFixture("b1");
    directory.seedDirectory(SOCIETY_B, { apartments: [foreign], members: [] });

    const response = await preview(
      equalBody({
        participantSelector: { excludeApartments: [foreign.id] },
      }),
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
    expect(response.body.error.field).toBe("selector.excludeApartments");
  });

  it("refuses a strategy config entry for another society's flat", async () => {
    const foreign = apartmentFixture("b1");
    directory.seedDirectory(SOCIETY_B, { apartments: [foreign], members: [] });

    const response = await preview(
      equalBody({
        splitStrategy: "custom",
        splitConfig: {
          customAmounts: [{ apartmentId: foreign.id, amountPaise: 10_000 }],
        },
      }),
    );

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
    expect(response.body.error.field).toBe("splitConfig.customAmounts");
  });

  it("has nowhere to put a member id — the contract keys entries by flat", async () => {
    const response = await preview(
      equalBody({
        splitStrategy: "custom",
        splitConfig: {
          customAmounts: [
            {
              apartmentId: id("101"),
              memberId: id("m101"),
              amountPaise: 10_000,
            },
          ],
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("the envelope and conservation", () => {
  it("wraps exactly the PRD's data fields in the standard envelope", async () => {
    const response = await preview(equalBody());

    expect(Object.keys(response.body as object).sort()).toEqual([
      "data",
      "meta",
    ]);
    expect(Object.keys(response.body.data as object).sort()).toEqual([
      "allocations",
      "participantCount",
      "residualPaise",
      "totalPaise",
      "unassigned",
      "warnings",
    ]);
    expect(
      Object.keys(response.body.data.allocations[0] as object).sort(),
    ).toEqual([
      "amountPaise",
      "apartmentId",
      "apartmentNumber",
      "memberId",
      "weight",
    ]);
  });

  it("conserves even a single paisa, with the residual placed deterministically", async () => {
    const response = await preview(equalBody({ amountPaise: 1 }));

    expect(response.body.data.totalPaise).toBe(1);
    expect(amountsOf(response)).toEqual([1, 0, 0]);
    const sum = amountsOf(response).reduce(
      (total, amount) => total + amount,
      0,
    );
    expect(sum).toBe(response.body.data.totalPaise);
    expect(response.body.data.residualPaise).toBe(0);
  });
});
