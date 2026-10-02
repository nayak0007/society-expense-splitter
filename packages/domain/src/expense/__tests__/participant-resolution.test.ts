import type { MemberRole, SocietyMembership } from "../../society/society";
import {
  asApartmentId,
  asBuildingId,
  asMemberId,
  asSocietyId,
  asUserId,
  asWingId,
} from "../../shared/ids";
import {
  SELECTOR_MAX_TERMS,
  createParticipantSelector,
  type ParticipantSelector,
} from "../participant-selector";
import {
  resolveExpenseParticipants,
  selectFlatOccupant,
  selectFlatOwner,
  type ExpenseParticipant,
  type ExpenseParticipantResolution,
  type ParticipantResolutionPolicy,
} from "../participant-resolution";
import {
  canResolveExpenseParticipants,
  evaluateExpenseParticipantCapabilities,
} from "../rules";
import type {
  ParticipantApartment,
  ParticipantMember,
  ParticipantWing,
  SocietyParticipantDirectory,
} from "../ports";

/**
 * Participant resolution (Roadmap T063, PRD §3.5.4) — the rules, at the level they are
 * decided.
 *
 * The suite is deliberately *not* about the SQL: what a reader returns is the
 * integration suite's subject, and this file's subjects are the things a wrong
 * implementation would get wrong here — which flats a dimension selects, who a flat's
 * charge is addressed to, when a tenant's share moves to the owner (and when it does
 * not), when a flat is flagged rather than dropped, and the order of the result.
 *
 * Two of the assertions are the acceptance criteria themselves, quoted where they are
 * tested: "Owner-only categories route a tenant's share to the apartment's owner with
 * `assigned_reason` recorded" and "Unassignable dues (no owner membership) flagged
 * rather than dropped".
 */

const BUILDING_ONE = asBuildingId("11111111-1111-4111-8111-111111111111");
const BUILDING_TWO = asBuildingId("22222222-2222-4222-8222-222222222222");
const WING_A = asWingId("33333333-3333-4333-8333-333333333333");
const WING_B = asWingId("44444444-4444-4444-8444-444444444444");
const UNKNOWN_ID = "99999999-9999-4999-8999-999999999999";

/**
 * A uuid-shaped id derived from a readable label.
 *
 * The selector validates ids as uuids (`buildings`, `excludeApartments`), so a fixture's
 * id has to be one — and `ap-101` reads an assertion better than a literal uuid. The
 * derivation preserves the labels' byte order, which the id-tiebreak assertion relies on.
 */
function id(label: string): string {
  const hex = [...label]
    .map((character) => character.charCodeAt(0).toString(16))
    .join("")
    .slice(0, 12)
    .padEnd(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

function apartment(
  label: string,
  overrides: Partial<ParticipantApartment> = {},
): ParticipantApartment {
  return {
    id: asApartmentId(id(label)),
    buildingId: BUILDING_ONE,
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

function member(
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

function directory(input: {
  readonly apartments: readonly ParticipantApartment[];
  readonly members?: readonly ParticipantMember[];
  readonly wings?: readonly ParticipantWing[];
  readonly buildings?: readonly SocietyParticipantDirectory["buildings"][number][];
}): SocietyParticipantDirectory {
  return {
    apartments: input.apartments,
    members: input.members ?? [],
    wings: input.wings ?? [],
    buildings: input.buildings ?? [BUILDING_ONE, BUILDING_TWO],
  };
}

function selector(input: unknown): ParticipantSelector {
  const parsed = createParticipantSelector(input);
  if (!parsed.ok) {
    throw new Error(`selector refused: ${parsed.error.message}`);
  }
  return parsed.value;
}

function policy(
  overrides: Partial<ParticipantResolutionPolicy> = {},
): ParticipantResolutionPolicy {
  return {
    selector: selector({}),
    billVacantFlats: true,
    ownerOnly: false,
    ownerOnlyAssignedReason: null,
    ...overrides,
  };
}

function resolve(
  facts: SocietyParticipantDirectory,
  overrides: Partial<ParticipantResolutionPolicy> = {},
): ExpenseParticipantResolution {
  const resolved = resolveExpenseParticipants(facts, policy(overrides));
  if (!resolved.ok) {
    throw new Error(`resolution refused: ${resolved.error.message}`);
  }
  return resolved.value;
}

function refusal(
  facts: SocietyParticipantDirectory,
  overrides: Partial<ParticipantResolutionPolicy> = {},
): { readonly code: string; readonly field: unknown } {
  const resolved = resolveExpenseParticipants(facts, policy(overrides));
  if (resolved.ok) {
    throw new Error("expected a refusal, got a resolution");
  }
  return {
    code: resolved.error.code,
    field: resolved.error.details?.["field"],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The selector
// ─────────────────────────────────────────────────────────────────────────────

describe("createParticipantSelector", () => {
  it("reads an empty selector as society-wide with nothing filtered out", () => {
    const parsed = selector({});

    expect(parsed.scope).toBe("society");
    expect(parsed.buildings).toEqual([]);
    expect(parsed.wings).toEqual([]);
    expect(parsed.floors).toEqual([]);
    expect(parsed.occupancy).toEqual([]);
    expect(parsed.excludeApartments).toEqual([]);
    // `null`, not `false`: "not stated" is what lets the society's own setting decide.
    expect(parsed.includeVacant).toBeNull();
    expect(parsed.ownerOnly).toBe(false);
  });

  it("accepts PRD §3.5.4's own example", () => {
    const parsed = selector({
      scope: "society",
      buildings: [UNKNOWN_ID],
      wings: ["A"],
      floors: [1, 2, 3],
      occupancy: ["owner_occupied", "rented"],
      excludeApartments: [UNKNOWN_ID],
      includeVacant: false,
      ownerOnly: true,
    });

    expect(parsed.buildings).toEqual([asBuildingId(UNKNOWN_ID)]);
    expect(parsed.wings).toEqual(["A"]);
    expect(parsed.floors).toEqual([1, 2, 3]);
    expect(parsed.occupancy).toEqual(["owner_occupied", "rented"]);
    expect(parsed.includeVacant).toBe(false);
    expect(parsed.ownerOnly).toBe(true);
  });

  it("normalises: de-duplicated, sorted, and in the column's own order", () => {
    const parsed = selector({
      buildings: [BUILDING_TWO, BUILDING_ONE, BUILDING_TWO],
      wings: ["B", "A", "B"],
      floors: [3, 1, 3, 2],
      occupancy: ["rented", "owner_occupied"],
    });

    expect(parsed.buildings).toEqual([BUILDING_ONE, BUILDING_TWO]);
    expect(parsed.wings).toEqual(["A", "B"]);
    expect(parsed.floors).toEqual([1, 2, 3]);
    // `OCCUPANCY_STATUSES` order, not the order the caller typed.
    expect(parsed.occupancy).toEqual(["owner_occupied", "rented"]);
  });

  it("refuses a scope it does not have", () => {
    expect(selectorRefusal({ scope: "wing" })).toContain(
      "scope must be one of",
    );
  });

  it("refuses a building scope with no buildings", () => {
    expect(selectorRefusal({ scope: "building" })).toContain(
      "must name at least one building",
    );
  });

  it("refuses ids that are not ids", () => {
    expect(selectorRefusal({ buildings: ["not-a-uuid"] })).toContain(
      "is not a building id",
    );
    expect(selectorRefusal({ excludeApartments: ["nope"] })).toContain(
      "is not an apartment id",
    );
  });

  it("refuses a wing label the column could not hold", () => {
    expect(selectorRefusal({ wings: ["   "] })).toContain("1–40 characters");
    expect(selectorRefusal({ wings: ["A".repeat(41)] })).toContain(
      "1–40 characters",
    );
  });

  it("refuses a floor that is not a floor", () => {
    expect(selectorRefusal({ floors: [1.5] })).toContain("whole number");
    expect(selectorRefusal({ floors: [201] })).toContain("whole number");
    expect(selectorRefusal({ floors: [-6] })).toContain("whole number");
  });

  it("refuses a member-occupancy value where a flat status belongs", () => {
    // `family_member` is a membership, never a flat's status — the distinction the
    // PRD's own example (`rented`) settles.
    expect(selectorRefusal({ occupancy: ["family_member"] })).toContain(
      "occupancy must be one of",
    );
  });

  it("refuses a flag that is not a flag", () => {
    expect(selectorRefusal({ includeVacant: "yes" })).toContain(
      "includeVacant must be true or false",
    );
    expect(selectorRefusal({ ownerOnly: 1 })).toContain(
      "ownerOnly must be true or false",
    );
  });

  it("refuses a selector that is not an object", () => {
    expect(selectorRefusal(null)).toContain("selector is required");
    expect(selectorRefusal(["society"])).toContain("selector is required");
  });

  it("refuses a dimension that is not an array at all", () => {
    // The scalar where a list belongs is the shape a form sends when a select was
    // rendered single-valued, so it is named rather than coerced into a one-element
    // list — which would silently bill the wrong flats.
    expect(selectorRefusal({ buildings: "society" })).toContain(
      "selector.buildings must be an array",
    );
    expect(selectorRefusal({ floors: 3 })).toContain(
      "selector.floors must be an array",
    );
    expect(selectorRefusal({ occupancy: "rented" })).toContain(
      "selector.occupancy must be an array",
    );
    expect(selectorRefusal({ wings: "A" })).toContain(
      "selector.wings must be an array",
    );
  });

  it("refuses a term that is not text, and a selector that asks for a scan", () => {
    expect(selectorRefusal({ wings: [1] })).toContain(
      "selector.wings must contain text values",
    );
    expect(
      selectorRefusal({
        buildings: Array.from(
          { length: SELECTOR_MAX_TERMS + 1 },
          () => UNKNOWN_ID,
        ),
      }),
    ).toContain(`more than ${SELECTOR_MAX_TERMS} terms`);
  });

  it("refuses a scope that is not text", () => {
    expect(selectorRefusal({ scope: 1 })).toContain("scope must be one of");
  });
});

function selectorRefusal(input: unknown): string {
  const parsed = createParticipantSelector(input);
  if (parsed.ok) {
    throw new Error("expected the selector to be refused");
  }
  return parsed.error.message;
}

// ─────────────────────────────────────────────────────────────────────────────
// Eligibility
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveExpenseParticipants eligibility", () => {
  const threeFlats = [
    apartment("ap-101", { apartmentNumber: "101" }),
    apartment("ap-102", { apartmentNumber: "102", buildingId: BUILDING_TWO }),
    apartment("ap-103", { apartmentNumber: "103", floor: 4 }),
  ];

  it("bills every billable flat when nothing is filtered", () => {
    const resolution = resolve(
      directory({
        apartments: threeFlats,
        members: [
          member("m101", "ap-101"),
          member("m102", "ap-102"),
          member("m103", "ap-103"),
        ],
      }),
    );

    expect(resolution.participants.map((p) => p.apartmentNumber)).toEqual([
      "101",
      "102",
      "103",
    ]);
    expect(resolution.unassigned).toEqual([]);
  });

  it("filters by building, and refuses a building this society does not have", () => {
    const facts = directory({
      apartments: threeFlats,
      members: [
        member("m101", "ap-101"),
        member("m102", "ap-102"),
        member("m103", "ap-103"),
      ],
    });

    expect(
      resolve(facts, {
        selector: selector({ buildings: [BUILDING_TWO] }),
      }).participants.map((p) => p.apartmentNumber),
    ).toEqual(["102"]);

    // Silently matching nothing would bill the whole society instead of one building,
    // which is the direction that cannot be allowed to pass.
    expect(
      refusal(facts, { selector: selector({ buildings: [UNKNOWN_ID] }) }),
    ).toEqual({ code: "not_found", field: "selector.buildings" });
  });

  it("filters by wing label, and a wing-less flat never matches one", () => {
    const facts = directory({
      apartments: [
        apartment("ap-a1", { apartmentNumber: "A-1", wingId: WING_A }),
        apartment("ap-b1", { apartmentNumber: "B-1", wingId: WING_B }),
        apartment("ap-c1", { apartmentNumber: "C-1", wingId: null }),
      ],
      members: [
        member("ma1", "ap-a1"),
        member("mb1", "ap-b1"),
        member("mc1", "ap-c1"),
      ],
      wings: [
        { id: WING_A, buildingId: BUILDING_ONE, name: "A" },
        { id: WING_B, buildingId: BUILDING_ONE, name: "B" },
      ],
    });

    expect(
      resolve(facts, { selector: selector({ wings: ["A"] }) }).participants.map(
        (p) => p.apartmentNumber,
      ),
    ).toEqual(["A-1"]);

    expect(refusal(facts, { selector: selector({ wings: ["C"] }) })).toEqual({
      code: "not_found",
      field: "selector.wings",
    });
  });

  it("filters by floor, and an unrecorded floor never matches one", () => {
    const facts = directory({
      apartments: [
        apartment("ap-1", { apartmentNumber: "1", floor: 0 }),
        apartment("ap-2", { apartmentNumber: "2", floor: 4 }),
        apartment("ap-3", { apartmentNumber: "3", floor: null }),
      ],
      members: [
        member("m1", "ap-1"),
        member("m2", "ap-2"),
        member("m3", "ap-3"),
      ],
    });

    expect(
      resolve(facts, { selector: selector({ floors: [4] }) }).participants.map(
        (p) => p.apartmentNumber,
      ),
    ).toEqual(["2"]);
  });

  it("filters by the flat's occupancy status", () => {
    const facts = directory({
      apartments: [
        apartment("ap-o", {
          apartmentNumber: "1",
          occupancyStatus: "owner_occupied",
        }),
        apartment("ap-r", { apartmentNumber: "2", occupancyStatus: "rented" }),
        apartment("ap-v", { apartmentNumber: "3", occupancyStatus: "vacant" }),
      ],
      members: [
        member("mo", "ap-o"),
        member("mr", "ap-r", { occupancy: "tenant" }),
      ],
    });

    expect(
      resolve(facts, {
        selector: selector({ occupancy: ["rented"], includeVacant: false }),
      }).participants.map((p) => p.apartmentNumber),
    ).toEqual(["2"]);
  });

  it("excludes a named flat, and refuses one this society does not have", () => {
    const facts = directory({
      apartments: threeFlats,
      members: [
        member("m101", "ap-101"),
        member("m102", "ap-102"),
        member("m103", "ap-103"),
      ],
    });

    expect(
      resolve(facts, {
        selector: selector({ excludeApartments: [id("ap-102")] }),
      }).participants.map((p) => p.apartmentNumber),
    ).toEqual(["101", "103"]);

    expect(
      refusal(facts, {
        selector: selector({ excludeApartments: [UNKNOWN_ID] }),
      }),
    ).toEqual({ code: "not_found", field: "selector.excludeApartments" });
  });

  it("never bills a flat a society has switched off", () => {
    const facts = directory({
      apartments: [
        apartment("ap-1", { apartmentNumber: "1" }),
        apartment("ap-2", { apartmentNumber: "2", isBillable: false }),
      ],
      members: [member("m1", "ap-1"), member("m2", "ap-2")],
    });

    expect(resolve(facts).participants.map((p) => p.apartmentNumber)).toEqual([
      "1",
    ]);
  });

  it("respects bill_vacant_flats as a floor and includeVacant as the override", () => {
    const facts = directory({
      apartments: [
        apartment("ap-v", { apartmentNumber: "1", occupancyStatus: "vacant" }),
      ],
      members: [member("mv", "ap-v", { occupancy: "vacant_owner" })],
    });

    // Vacant flats are billable by default (PRD §3.3) — and an explicit `true` is the
    // same answer as not saying anything.
    expect(resolve(facts).participants).toHaveLength(1);
    expect(
      resolve(facts, { selector: selector({ includeVacant: true }) })
        .participants,
    ).toHaveLength(1);

    // The per-expense opt-out.
    // The per-expense opt-out — and with one vacant flat and nothing else it is a
    // refusal, not an empty resolution.
    expect(
      refusal(facts, { selector: selector({ includeVacant: false }) }).code,
    ).toBe("validation");

    // The society's own switch wins over a selector that asks for them, which is the
    // "bill_vacant_flats setting respected" half of the acceptance criteria.
    expect(
      refusal(facts, {
        selector: selector({ includeVacant: true }),
        billVacantFlats: false,
      }).code,
    ).toBe("validation");
  });

  it("does not treat an under-construction flat as vacant", () => {
    // No document calls `under_construction` vacant — the PRD's switch is named for
    // vacant flats and its enum lists the two separately — so it participates.
    const resolution = resolve(
      directory({
        apartments: [
          apartment("ap-u", {
            apartmentNumber: "1",
            occupancyStatus: "under_construction",
          }),
        ],
        members: [member("mu", "ap-u")],
      }),
      { selector: selector({ includeVacant: false }) },
    );

    expect(resolution.participants).toHaveLength(1);
  });

  it("refuses a selector that matches no billable flat", () => {
    const facts = directory({
      apartments: [apartment("ap-1", { occupancyStatus: "vacant" })],
      members: [member("m1", "ap-1")],
    });

    expect(
      refusal(facts, { selector: selector({ includeVacant: false }) }),
    ).toEqual({ code: "validation", field: "selector" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Who the charge is addressed to
// ─────────────────────────────────────────────────────────────────────────────

describe("selectFlatOwner / selectFlatOccupant", () => {
  const owner = member("owner-1", "ap-1", { occupancy: "owner_occupied" });
  const tenant = member("tenant-1", "ap-1", { occupancy: "tenant" });
  const family = member("family-1", "ap-1", {
    occupancy: "family_member",
    isPrimary: false,
  });

  it("addresses the flat to its occupant, by the flat's own status", () => {
    expect(selectFlatOccupant([owner, tenant], "rented")?.id).toBe(tenant.id);
    expect(selectFlatOccupant([owner, tenant], "owner_occupied")?.id).toBe(
      owner.id,
    );
    expect(selectFlatOccupant([owner, tenant], "vacant")?.id).toBe(owner.id);
  });

  it("falls back when the status and the roster disagree", () => {
    // A stale status must not leave a billable flat with no addressee.
    expect(selectFlatOccupant([owner], "rented")?.id).toBe(owner.id);
    expect(selectFlatOccupant([tenant], "owner_occupied")?.id).toBe(tenant.id);
  });

  it("never bills a family member (PRD §3.3)", () => {
    expect(selectFlatOccupant([family], "owner_occupied")).toBeNull();
    expect(selectFlatOwner([family])).toBeNull();
  });

  it("prefers the primary claim, then the lowest id", () => {
    const primary = member("b-primary", "ap-1", { isPrimary: true });
    const other = member("a-not-primary", "ap-1", { isPrimary: false });

    expect(selectFlatOwner([other, primary])?.id).toBe(primary.id);
    // Two non-primary owners have no documented addressee, so the rule is a total
    // order rather than a preference — and it is the same answer in any array order.
    expect(
      selectFlatOwner([other, member("c-other", "ap-1", { isPrimary: false })])
        ?.id,
    ).toBe(id("a-not-primary"));
  });

  it("counts a vacant_owner as the owner", () => {
    const elsewhere = member("owner-2", "ap-1", {
      occupancy: "vacant_owner",
      isPrimary: true,
    });

    expect(selectFlatOwner([tenant, elsewhere])?.id).toBe(elsewhere.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Owner-only routing
// ─────────────────────────────────────────────────────────────────────────────

describe("owner-only routing", () => {
  const ownerMember = member("owner-1", "ap-1", {
    occupancy: "owner_occupied",
  });
  const tenantMember = member("tenant-1", "ap-1", { occupancy: "tenant" });

  function rentedFlat(): SocietyParticipantDirectory {
    return directory({
      apartments: [
        apartment("ap-1", {
          apartmentNumber: "101",
          occupancyStatus: "rented",
        }),
      ],
      members: [ownerMember, tenantMember],
    });
  }

  it("routes a tenant's share to the owner, with the PRD's reason recorded", () => {
    const resolution = resolve(rentedFlat(), {
      ownerOnly: true,
      ownerOnlyAssignedReason: "owner_only_category",
    });

    expect(resolution.participants).toHaveLength(1);
    expect(resolution.participants[0]?.memberId).toBe(ownerMember.id);
    expect(resolution.participants[0]?.assignedReason).toBe(
      "owner_only_category",
    );
    // The member the charge moved from, which is what a snapshot and the tenant's own
    // screen are built from.
    expect(resolution.participants[0]?.routedFromMemberId).toBe(
      tenantMember.id,
    );
  });

  it("records nothing when no charge moved", () => {
    // An owner-occupied flat under an owner-only category: the owner was already the
    // addressee, so there is no tenant to move a share from and no reason to record.
    const owned = resolve(
      directory({
        apartments: [apartment("ap-1", { apartmentNumber: "101" })],
        members: [ownerMember],
      }),
      { ownerOnly: true, ownerOnlyAssignedReason: "owner_only_category" },
    );

    expect(owned.participants[0]?.assignedReason).toBeNull();
    expect(owned.participants[0]?.routedFromMemberId).toBeNull();
  });

  it("records nothing when the selector — not the category — asked for owners", () => {
    const resolution = resolve(rentedFlat(), { ownerOnly: true });

    expect(resolution.participants[0]?.memberId).toBe(ownerMember.id);
    expect(resolution.participants[0]?.assignedReason).toBeNull();
  });

  it("flags a flat whose owner membership does not exist (PRD §3.5.4)", () => {
    const resolution = resolve(
      directory({
        apartments: [
          apartment("ap-1", {
            apartmentNumber: "101",
            occupancyStatus: "rented",
          }),
        ],
        members: [tenantMember],
      }),
      { ownerOnly: true, ownerOnlyAssignedReason: "owner_only_category" },
    );

    // "the due attaches to the apartment and shows as 'unassigned'" — flagged, and
    // carrying the facts the publish path needs to weigh it.
    expect(resolution.participants).toEqual([]);
    expect(resolution.unassigned).toEqual([
      expect.objectContaining({
        apartmentId: asApartmentId(id("ap-1")),
        apartmentNumber: "101",
        reason: "unassigned_no_owner",
        carpetAreaSqft: 700,
      }),
    ]);
  });

  it("flags a flat with no memberships at all, with its own reason", () => {
    const resolution = resolve(
      directory({
        apartments: [apartment("ap-1", { apartmentNumber: "101" })],
      }),
    );

    expect(resolution.unassigned[0]?.reason).toBe("unassigned_no_member");
  });

  it("does not move a charge when nobody asked for the owner", () => {
    const resolution = resolve(rentedFlat());

    expect(resolution.participants[0]?.memberId).toBe(tenantMember.id);
    expect(resolution.unassigned).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One flat, one participant, one order
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveExpenseParticipants shape and order", () => {
  it("produces exactly one participant per flat, whatever the roster holds", () => {
    const resolution = resolve(
      directory({
        apartments: [
          apartment("ap-1", {
            apartmentNumber: "101",
            occupancyStatus: "rented",
          }),
        ],
        members: [
          member("owner-1", "ap-1", { occupancy: "owner_occupied" }),
          member("tenant-1", "ap-1", { occupancy: "tenant" }),
          member("family-1", "ap-1", {
            occupancy: "family_member",
            isPrimary: false,
          }),
        ],
      }),
    );

    expect(resolution.participants).toHaveLength(1);
  });

  it("orders by floor, then label byte-wise, then id", () => {
    const resolution = resolve(
      directory({
        apartments: [
          apartment("ap-3", { apartmentNumber: "2", floor: 1 }),
          apartment("ap-1", { apartmentNumber: "10", floor: 1 }),
          apartment("ap-2", { apartmentNumber: "1", floor: 0 }),
          apartment("ap-4", { apartmentNumber: "9", floor: null }),
        ],
        members: [
          member("m1", "ap-1"),
          member("m2", "ap-2"),
          member("m3", "ap-3"),
          member("m4", "ap-4"),
        ],
      }),
    );

    // `"10"` before `"2"` is `COLLATE "C"` — the order the server indexes and the
    // order the split engine ties its residual by. `floor: null` sorts last.
    expect(resolution.participants.map((p) => p.apartmentNumber)).toEqual([
      "1",
      "10",
      "2",
      "9",
    ]);
  });

  it("is a function of the data, not of any array's order", () => {
    const apartments = [
      apartment("ap-1", { apartmentNumber: "101" }),
      apartment("ap-2", { apartmentNumber: "102" }),
    ];
    const members = [member("m1", "ap-1"), member("m2", "ap-2")];

    const first = resolve(directory({ apartments, members }));
    const second = resolve(
      directory({
        apartments: [...apartments].reverse(),
        members: [...members].reverse(),
      }),
    );

    expect(second).toEqual(first);
    expect(resolve(directory({ apartments, members }))).toEqual(first);
  });

  it("carries exactly the facts the engine's apartment participants need", () => {
    const resolution = resolve(
      directory({
        apartments: [
          apartment("ap-1", {
            apartmentNumber: "101",
            floor: 3,
            carpetAreaSqft: 720.5,
            builtupAreaSqft: 900.25,
            bhk: 2.5,
            parkingSlots: 2,
            shareUnits: 1.5,
          }),
        ],
        members: [member("m1", "ap-1")],
      }),
    );

    const participant = resolution.participants[0];
    expect(participant).toMatchObject({
      memberId: asMemberId(id("m1")),
      apartmentId: asApartmentId(id("ap-1")),
      apartmentNumber: "101",
      floor: 3,
      carpetAreaSqft: 720.5,
      builtupAreaSqft: 900.25,
      bhk: 2.5,
      parkingSlots: 2,
      shareUnits: 1.5,
      assignedReason: null,
      routedFromMemberId: null,
    });

    // The engine's `SplitParticipant`/`ApartmentParticipant` fields are all present
    // under those names, which is what makes T064/T066 pass one straight through.
    const engineFields: readonly (keyof ExpenseParticipant)[] = [
      "memberId",
      "apartmentId",
      "apartmentNumber",
      "floor",
      "carpetAreaSqft",
      "builtupAreaSqft",
      "bhk",
      "parkingSlots",
    ];
    for (const field of engineFields) {
      expect(participant).toHaveProperty(field);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities
// ─────────────────────────────────────────────────────────────────────────────

describe("expense-participant capabilities", () => {
  function membership(
    role: MemberRole,
    status: SocietyMembership["status"] = "active",
  ): SocietyMembership {
    return {
      id: asMemberId("m1"),
      societyId: asSocietyId("s1"),
      userId: asUserId("u1"),
      role,
      status,
      occupancyType: "owner",
      joinedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("lets Admin, Treasurer and Committee Member resolve — expense.create, not expense.publish", () => {
    // The matrix's `expense.create` cell: Admin and Treasurer full, Committee Member
    // scoped. Resolution is what composing a draft needs, so a Committee Member may
    // run it — the choice `expense.publish` would have made impossible.
    for (const role of ["admin", "treasurer", "committee_member"] as const) {
      expect(evaluateExpenseParticipantCapabilities(membership(role))).toEqual({
        canResolve: true,
      });
    }
  });

  it("gives every other role, and a non-member, nothing", () => {
    for (const role of ["resident", "tenant", "guest"] as const) {
      expect(evaluateExpenseParticipantCapabilities(membership(role))).toEqual({
        canResolve: false,
      });
    }
    expect(evaluateExpenseParticipantCapabilities(null)).toEqual({
      canResolve: false,
    });
  });

  it("gives a pending or removed membership nothing, whatever the role says", () => {
    expect(
      evaluateExpenseParticipantCapabilities(
        membership("treasurer", "pending"),
      ),
    ).toEqual({ canResolve: false });
    expect(
      evaluateExpenseParticipantCapabilities(membership("admin", "removed")),
    ).toEqual({ canResolve: false });
  });

  it("holds resolution to exactly the roles the matrix gives `expense.create`", () => {
    const roles: readonly MemberRole[] = [
      "admin",
      "treasurer",
      "committee_member",
      "resident",
      "tenant",
      "guest",
    ];
    expect(
      roles.filter((role) => canResolveExpenseParticipants(role).allowed),
    ).toEqual(["admin", "treasurer", "committee_member"]);
    // No action was invented beside the matrix's own, so `null` is refused for the
    // reason every rule refuses it: there is no role to ask the matrix about.
    expect(canResolveExpenseParticipants(null).allowed).toBe(false);
  });

  it("explains a refusal so the UI can say why", () => {
    const outcome = canResolveExpenseParticipants("resident");
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) {
      expect(outcome.reason).toContain("Admin, Treasurer or Committee Member");
    }
  });
});
