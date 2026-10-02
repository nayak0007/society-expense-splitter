import {
  asExpenseCategoryId,
  asSocietyId,
  asUserId,
  expenseError,
} from "@ses/domain";
import type {
  ExpenseParticipantReader,
  SocietyParticipantDirectory,
} from "@ses/domain";

import type { ExpenseParticipantDeps } from "../use-cases/resolve-participants";
import { resolveParticipantsForExpense } from "../use-cases/resolve-participants";
import {
  expectErr,
  expectOk,
  FakeExpenseCategoryRepository,
} from "./support/fake-category-repository";
import {
  apartmentFixture,
  FakeParticipantDirectory,
  id,
  memberFixture,
} from "./support/fake-participant-directory";

/**
 * The participant-resolution use case, against fakes of its four read ports.
 *
 * The domain suite owns the *rules* (which dimension filters what, who a flat's owner
 * is, the order, the reasons); these tests are for the three things only this layer can
 * get wrong:
 *
 *  1. **Authorization.** Resolution is reachable by exactly the people who may compose
 *     a split — Admin, Treasurer and Committee Member (`expense.create`), not by a
 *     Resident or a Guest, and a refusal must cost no read at all.
 *  2. **Composition of the owner-only flag.** The selector's `ownerOnly` and the
 *     category's `is_owner_only` are one meaning decided here, with the reason recorded
 *     only when the category is what moved the charge. A use case that passed the
 *     category's flag as the *selector's* flag, or that recorded the reason for a
 *     selector-level request, would be wrong in a way no domain test can see.
 *  3. **Reads are from storage, never from the caller.** The category is loaded by id
 *     (another society's, a removed one and an unknown one are all `not_found`), and
 *     `billVacantFlats` comes from the society row — the request cannot supply either.
 */

const SOCIETY = "society-1";
const ADMIN = "user-admin";
const OWNER = "owner-1";
const TENANT = "tenant-1";
const APARTMENT = "ap-201";

function setup(): {
  readonly deps: ExpenseParticipantDeps;
  readonly participants: FakeParticipantDirectory;
  readonly categories: FakeExpenseCategoryRepository;
} {
  const participants = new FakeParticipantDirectory();
  participants.seedMembership(SOCIETY, { userId: ADMIN, role: "admin" });
  // Every society bills vacant flats unless a test says otherwise — the column's own
  // default, so a test that forgets is not accidentally testing the override.
  participants.seedBillVacantFlats(SOCIETY, true);
  const categories = new FakeExpenseCategoryRepository();

  return {
    deps: {
      memberships: participants,
      categories,
      participants,
      society: participants,
    },
    participants,
    categories,
  };
}

/** One rented flat with an owner and a tenant — the PRD §3.5.4 routing case. */
function seedRentedFlat(participants: FakeParticipantDirectory): void {
  participants.seedDirectory(SOCIETY, {
    apartments: [apartmentFixture(APARTMENT, { occupancyStatus: "rented" })],
    members: [
      memberFixture(OWNER, APARTMENT, {
        occupancy: "vacant_owner",
        isPrimary: false,
      }),
      memberFixture(TENANT, APARTMENT, {
        occupancy: "tenant",
        isPrimary: true,
      }),
    ],
  });
}

describe("resolveParticipantsForExpense", () => {
  it("resolves the whole society for a selector that says nothing", async () => {
    const { deps, participants } = setup();
    participants.seedDirectory(SOCIETY, {
      apartments: [apartmentFixture("ap-101"), apartmentFixture("ap-102")],
      members: [
        memberFixture("owner-101", "ap-101"),
        memberFixture("owner-102", "ap-102"),
      ],
    });

    const resolution = expectOk(
      await resolveParticipantsForExpense(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        { selector: {} },
      ),
    );

    expect(
      resolution.participants.map((entry) => entry.apartmentNumber),
    ).toEqual(["101", "102"]);
    expect(resolution.unassigned).toEqual([]);
    // The flat facts the six bases read travel with the participant, so T064/T066 can
    // hand it to the engine without a mapping step.
    expect(resolution.participants[0]).toMatchObject({
      floor: 1,
      carpetAreaSqft: 700,
      builtupAreaSqft: 875,
      bhk: 2,
      parkingSlots: 1,
      shareUnits: 1,
    });
    expect(participants.callsOf("listSocietyParticipants")).toBe(1);
    expect(participants.callsOf("findById")).toBe(1);
  });

  it("resolves for a Treasurer and a Committee Member — expense.create is the rule", async () => {
    const { deps, participants } = setup();
    participants.seedMembership(SOCIETY, {
      userId: "user-treasurer",
      role: "treasurer",
    });
    participants.seedMembership(SOCIETY, {
      userId: "user-committee",
      role: "committee_member",
    });
    participants.seedDirectory(SOCIETY, {
      apartments: [apartmentFixture("ap-101")],
      members: [memberFixture("owner-101", "ap-101")],
    });

    for (const actor of ["user-treasurer", "user-committee"]) {
      const resolution = expectOk(
        await resolveParticipantsForExpense(
          deps,
          asUserId(actor),
          asSocietyId(SOCIETY),
          { selector: {} },
        ),
      );
      expect(resolution.participants).toHaveLength(1);
    }
  });

  it("refuses a Resident and a Guest without reading the directory", async () => {
    const { deps, participants } = setup();
    participants.seedMembership(SOCIETY, {
      userId: "user-resident",
      role: "resident",
    });
    participants.seedMembership(SOCIETY, {
      userId: "user-guest",
      role: "guest",
    });

    for (const actor of ["user-resident", "user-guest"]) {
      const error = expectErr(
        await resolveParticipantsForExpense(
          deps,
          asUserId(actor),
          asSocietyId(SOCIETY),
          { selector: {} },
        ),
      );
      expect(error.code).toBe("forbidden");
      expect(error.message).toContain("Admin, Treasurer or Committee Member");
    }
    expect(participants.callsOf("listSocietyParticipants")).toBe(0);
    expect(participants.callsOf("findById")).toBe(0);
  });

  it("answers not_found — never forbidden — for a non-member and a removed member", async () => {
    const { deps, participants } = setup();
    participants.seedMembership(SOCIETY, {
      userId: "user-removed",
      role: "treasurer",
      status: "removed",
    });

    for (const actor of ["user-stranger", "user-removed"]) {
      const error = expectErr(
        await resolveParticipantsForExpense(
          deps,
          asUserId(actor),
          asSocietyId(SOCIETY),
          { selector: {} },
        ),
      );
      expect(error.code).toBe("not_found");
    }
  });

  it("validates the selector before any read, naming the dimension", async () => {
    const { deps, participants, categories } = setup();

    const error = expectErr(
      await resolveParticipantsForExpense(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        { selector: { scope: "block" }, categoryId: asExpenseCategoryId("x") },
      ),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("selector.scope");
    expect(participants.callsOf("listSocietyParticipants")).toBe(0);
    expect(participants.callsOf("findById")).toBe(0);
    expect(categories.callCount("findCategory")).toBe(0);
  });

  it("routes a tenant's share to the owner for an owner-only category, recording the reason", async () => {
    const { deps, participants, categories } = setup();
    seedRentedFlat(participants);
    const category = await categories.create(
      asSocietyId(SOCIETY),
      { name: "Sinking Fund", isOwnerOnly: true },
      asUserId(ADMIN),
    );

    const resolution = expectOk(
      await resolveParticipantsForExpense(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        { selector: {}, categoryId: category.id },
      ),
    );

    expect(resolution.participants).toHaveLength(1);
    expect(resolution.participants[0]?.memberId).toBe(
      memberFixture(OWNER, APARTMENT).id,
    );
    // PRD §3.5.4's own value, and the member the charge moved *from* — what the
    // publish path snapshots so both parties can be shown the routing.
    expect(resolution.participants[0]?.assignedReason).toBe(
      "owner_only_category",
    );
    expect(resolution.participants[0]?.routedFromMemberId).toBe(
      memberFixture(TENANT, APARTMENT).id,
    );
    expect(categories.callCount("findCategory")).toBe(1);
  });

  it("routes for a selector-level ownerOnly without claiming the category's reason", async () => {
    const { deps, participants } = setup();
    seedRentedFlat(participants);

    const resolution = expectOk(
      await resolveParticipantsForExpense(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        { selector: { ownerOnly: true } },
      ),
    );

    expect(resolution.participants[0]?.memberId).toBe(
      memberFixture(OWNER, APARTMENT).id,
    );
    // Nothing in the PRD moved this charge: the selector simply asked for owners, so
    // the row carries the move but no `assigned_reason` to explain a category rule.
    expect(resolution.participants[0]?.assignedReason).toBeNull();
    expect(resolution.participants[0]?.routedFromMemberId).toBe(
      memberFixture(TENANT, APARTMENT).id,
    );
  });

  it("records no reason on an owner-occupied flat under an owner-only category", async () => {
    const { deps, participants, categories } = setup();
    participants.seedDirectory(SOCIETY, {
      apartments: [apartmentFixture("ap-301")],
      members: [memberFixture("owner-301", "ap-301")],
    });
    const category = await categories.create(
      asSocietyId(SOCIETY),
      { name: "Sinking Fund", isOwnerOnly: true },
      asUserId(ADMIN),
    );

    const resolution = expectOk(
      await resolveParticipantsForExpense(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        { selector: {}, categoryId: category.id },
      ),
    );

    // The owner was always the addressee, so no charge moved and no reason is invented.
    expect(resolution.participants[0]?.assignedReason).toBeNull();
    expect(resolution.participants[0]?.routedFromMemberId).toBeNull();
  });

  it("refuses an unknown, another society's or a removed category — before any directory read", async () => {
    const { deps, participants, categories } = setup();
    const foreign = categories.seedCategory("society-2", { name: "Lift AMC" });
    const removed = categories.seedCategory(SOCIETY, {
      name: "Gone",
      deleted: true,
    });

    for (const categoryId of [
      asExpenseCategoryId("category-unknown"),
      foreign.id,
      removed.id,
    ]) {
      const error = expectErr(
        await resolveParticipantsForExpense(
          deps,
          asUserId(ADMIN),
          asSocietyId(SOCIETY),
          { selector: {}, categoryId },
        ),
      );
      expect(error.code).toBe("not_found");
    }
    expect(participants.callsOf("listSocietyParticipants")).toBe(0);
  });

  it("lets an inactive category resolve — deactivation must not strand a historical expense", async () => {
    const { deps, participants, categories } = setup();
    participants.seedDirectory(SOCIETY, {
      apartments: [apartmentFixture("ap-101")],
      members: [memberFixture("owner-101", "ap-101")],
    });
    const category = categories.seedCategory(SOCIETY, {
      name: "Festival & Events",
      isActive: false,
    });

    const resolution = expectOk(
      await resolveParticipantsForExpense(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        { selector: {}, categoryId: category.id },
      ),
    );

    expect(resolution.participants).toHaveLength(1);
  });

  it("takes bill_vacant_flats from the society row — a selector cannot switch it on", async () => {
    const { deps, participants } = setup();
    participants.seedBillVacantFlats(SOCIETY, false);
    participants.seedDirectory(SOCIETY, {
      apartments: [
        apartmentFixture("ap-101"),
        apartmentFixture("ap-102", { occupancyStatus: "vacant" }),
      ],
      members: [
        memberFixture("owner-101", "ap-101"),
        memberFixture("owner-102", "ap-102"),
      ],
    });

    const resolution = expectOk(
      await resolveParticipantsForExpense(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        // The setting is the floor: a society that does not bill vacant flats never
        // does, whatever a selector asks for.
        { selector: { includeVacant: true } },
      ),
    );

    expect(
      resolution.participants.map((entry) => entry.apartmentNumber),
    ).toEqual(["101"]);
  });

  it("lets a selector opt out of vacant flats even when the society bills them", async () => {
    const { deps, participants } = setup();
    participants.seedDirectory(SOCIETY, {
      apartments: [
        apartmentFixture("ap-101"),
        apartmentFixture("ap-102", { occupancyStatus: "vacant" }),
      ],
      members: [
        memberFixture("owner-101", "ap-101"),
        memberFixture("owner-102", "ap-102"),
      ],
    });

    const resolution = expectOk(
      await resolveParticipantsForExpense(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        { selector: { includeVacant: false } },
      ),
    );

    expect(
      resolution.participants.map((entry) => entry.apartmentNumber),
    ).toEqual(["101"]);
  });

  it("flags a flat with no owner instead of dropping it from an owner-only expense", async () => {
    const { deps, participants, categories } = setup();
    participants.seedDirectory(SOCIETY, {
      apartments: [apartmentFixture(APARTMENT, { occupancyStatus: "rented" })],
      members: [memberFixture(TENANT, APARTMENT, { occupancy: "tenant" })],
    });
    const category = await categories.create(
      asSocietyId(SOCIETY),
      { name: "Sinking Fund", isOwnerOnly: true },
      asUserId(ADMIN),
    );

    const resolution = expectOk(
      await resolveParticipantsForExpense(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        { selector: {}, categoryId: category.id },
      ),
    );

    expect(resolution.participants).toEqual([]);
    // The PRD's Treasurer-queue case: still owed, but by nobody yet.
    expect(resolution.unassigned).toHaveLength(1);
    expect(resolution.unassigned[0]).toMatchObject({
      apartmentNumber: "201",
      reason: "unassigned_no_owner",
    });
  });

  it("flags a vacant flat nobody is linked to", async () => {
    const { deps, participants } = setup();
    participants.seedDirectory(SOCIETY, {
      apartments: [apartmentFixture("ap-101", { occupancyStatus: "vacant" })],
      members: [],
    });

    const resolution = expectOk(
      await resolveParticipantsForExpense(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        { selector: {} },
      ),
    );

    expect(resolution.participants).toEqual([]);
    expect(resolution.unassigned[0]?.reason).toBe("unassigned_no_member");
  });

  it("refuses a selector that matches nothing rather than returning an empty bill", async () => {
    const { deps, participants } = setup();
    participants.seedDirectory(SOCIETY, {
      apartments: [apartmentFixture("ap-101", { isBillable: false })],
      members: [memberFixture("owner-101", "ap-101")],
    });

    const error = expectErr(
      await resolveParticipantsForExpense(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        { selector: {} },
      ),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("selector");
  });

  it("refuses a selector naming a building, a wing or an exclusion this society does not have", async () => {
    const { deps, participants } = setup();
    participants.seedDirectory(SOCIETY, {
      apartments: [apartmentFixture("ap-101")],
      members: [memberFixture("owner-101", "ap-101")],
    });

    const unknownBuilding = expectErr(
      await resolveParticipantsForExpense(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        // A label whose id cannot collide with the fixture building's — `id()` keeps
        // the first six bytes, so `building-1` and `building-9` are one uuid.
        { selector: { buildings: [id("tower-9")] } },
      ),
    );
    expect(unknownBuilding.code).toBe("not_found");
    expect(unknownBuilding.details?.field).toBe("selector.buildings");

    const unknownWing = expectErr(
      await resolveParticipantsForExpense(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        { selector: { wings: ["Z"] } },
      ),
    );
    expect(unknownWing.code).toBe("not_found");
    expect(unknownWing.details?.field).toBe("selector.wings");

    const unknownExclusion = expectErr(
      await resolveParticipantsForExpense(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        { selector: { excludeApartments: [id("ap-999")] } },
      ),
    );
    expect(unknownExclusion.code).toBe("not_found");
    expect(unknownExclusion.details?.field).toBe("selector.excludeApartments");
  });

  it("orders the resolution itself rather than trusting the directory's row order", async () => {
    const { deps, participants } = setup();
    // Handed over deliberately scrambled: the same society state must resolve to the
    // same sequence however the database happened to return it.
    participants.seedDirectory(SOCIETY, {
      apartments: [
        apartmentFixture("ap-2", { floor: 1 }),
        apartmentFixture("ap-10", { floor: 1 }),
        apartmentFixture("ap-1", { floor: 2 }),
        apartmentFixture("ap-9", { floor: null }),
      ],
      members: [
        memberFixture("owner-2", "ap-2"),
        memberFixture("owner-10", "ap-10"),
        memberFixture("owner-1", "ap-1"),
        memberFixture("owner-9", "ap-9"),
      ],
    });

    const resolution = expectOk(
      await resolveParticipantsForExpense(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        { selector: {} },
      ),
    );

    // Floor first, then the label byte-wise (`"10"` before `"2"`, as it sorts on the
    // server), and an unrecorded floor last.
    expect(
      resolution.participants.map((entry) => entry.apartmentNumber),
    ).toEqual(["10", "2", "1", "9"]);
  });

  it("answers not_found when the society row is not available, without inventing a policy", async () => {
    const participants = new FakeParticipantDirectory();
    participants.seedMembership(SOCIETY, { userId: ADMIN, role: "admin" });
    participants.seedDirectory(SOCIETY, {
      apartments: [apartmentFixture("ap-101")],
      members: [memberFixture("owner-101", "ap-101")],
    });
    // No `seedBillVacantFlats`: the read answers `null`, which is the soft-deleted or
    // cross-tenant society — never a default that would bill people.
    const deps: ExpenseParticipantDeps = {
      memberships: participants,
      categories: new FakeExpenseCategoryRepository(),
      participants,
      society: participants,
    };
    const error = expectErr(
      await resolveParticipantsForExpense(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        { selector: {} },
      ),
    );

    expect(error.code).toBe("not_found");
  });

  it("converts an adapter failure into the module's vocabulary rather than leaking it", async () => {
    const { participants, categories } = setup();
    const failing: ExpenseParticipantReader = {
      async listSocietyParticipants(): Promise<SocietyParticipantDirectory> {
        throw new Error("connection reset");
      },
    };

    const error = expectErr(
      await resolveParticipantsForExpense(
        {
          memberships: participants,
          categories,
          participants: failing,
          society: participants,
        },
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        { selector: {} },
      ),
    );

    expect(error.code).toBe("unknown");
  });

  it("keeps a typed adapter refusal as the typed refusal it was", async () => {
    const { participants, categories } = setup();
    const failing: ExpenseParticipantReader = {
      async listSocietyParticipants(): Promise<SocietyParticipantDirectory> {
        throw expenseError(
          "not_found",
          "That society is not available to you.",
        );
      },
    };

    const error = expectErr(
      await resolveParticipantsForExpense(
        {
          memberships: participants,
          categories,
          participants: failing,
          society: participants,
        },
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        { selector: {} },
      ),
    );

    expect(error.code).toBe("not_found");
  });
});
