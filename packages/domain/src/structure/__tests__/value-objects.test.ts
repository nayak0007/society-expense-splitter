import type { MemberRole, SocietyMembership } from "../../society/society";
import { asMemberId, asSocietyId, asUserId } from "../../shared/ids";
import {
  BUILDING_NAME_MAX_LENGTH,
  TOTAL_FLOORS_MAX,
  compareBuildings,
  type Building,
} from "../building";
import {
  canManageStructure,
  canViewStructure,
  evaluateStructureCapabilities,
} from "../rules";
import {
  createBuildingName,
  createDisplayOrder,
  createTotalFloors,
  DEFAULT_DISPLAY_ORDER,
} from "../value-objects";

/**
 * Building value objects and capability rules.
 *
 * These are the first line of defence the API, the mobile form and a seed script
 * all run, so the assertions are about the *rules* rather than about the strings:
 * that a four-digit floor count is refused with the field named, that "unknown"
 * and "zero" are different answers, and that no role but Admin can edit.
 *
 * Wings and apartments have no value objects here on purpose — see the note on
 * the `Building` entity for why they land with T043/T044.
 */

function membership(
  role: MemberRole,
  status: SocietyMembership["status"] = "active",
) {
  return {
    id: asMemberId("m1"),
    societyId: asSocietyId("s1"),
    userId: asUserId("u1"),
    role,
    status,
    occupancyType: "owner",
    joinedAt: "2026-01-01T00:00:00.000Z",
  } satisfies SocietyMembership;
}

function building(overrides: Partial<Building> = {}): Building {
  return {
    id: "b1" as Building["id"],
    societyId: asSocietyId("s1"),
    name: "A",
    totalFloors: null,
    displayOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

describe("createBuildingName", () => {
  it("keeps a bare number, which is a legitimate building name", () => {
    // The rule that differs from a society name on purpose: "12" is the number on
    // the gate, and refusing it would push the user into inventing a word.
    expect(createBuildingName("12")).toEqual({ ok: true, value: "12" });
    expect(createBuildingName("  Block   A  ")).toEqual({
      ok: true,
      value: "Block A",
    });
  });

  it("refuses an empty or whitespace-only name, naming the field", () => {
    const result = createBuildingName("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
      expect(result.error.details?.field).toBe("name");
    }
  });

  it("refuses a name longer than the column", () => {
    const result = createBuildingName("A".repeat(BUILDING_NAME_MAX_LENGTH + 1));
    expect(result.ok).toBe(false);
  });

  it("refuses control characters, which mean a paste rather than a name", () => {
    expect(createBuildingName("Block\u0000A").ok).toBe(false);
  });
});

describe("createTotalFloors", () => {
  it("preserves 'not recorded' rather than inventing a number", () => {
    expect(createTotalFloors(undefined)).toEqual({ ok: true, value: null });
    expect(createTotalFloors(null)).toEqual({ ok: true, value: null });
  });

  it("accepts a plausible count", () => {
    expect(createTotalFloors(12)).toEqual({ ok: true, value: 12 });
  });

  it("refuses zero instead of reading it as 'unknown'", () => {
    // A building with no floors is a data-entry mistake. Converting it to `null`
    // would hide the mistake behind a plausible-looking result, and every
    // per-floor generator downstream would silently produce nothing.
    const result = createTotalFloors(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.details?.field).toBe("totalFloors");
  });

  it("refuses a digit typed one place too far", () => {
    expect(createTotalFloors(1200).ok).toBe(false);
    expect(createTotalFloors(TOTAL_FLOORS_MAX).ok).toBe(true);
  });

  it("refuses a fraction", () => {
    expect(createTotalFloors(3.5).ok).toBe(false);
  });
});

describe("createDisplayOrder", () => {
  it("resolves the column default rather than leaving it to the database", () => {
    // So a test asserting order does not depend on which adapter ran.
    expect(createDisplayOrder(undefined)).toEqual({
      ok: true,
      value: DEFAULT_DISPLAY_ORDER,
    });
  });

  it("refuses a negative or absurd order", () => {
    expect(createDisplayOrder(-1).ok).toBe(false);
    expect(createDisplayOrder(1000).ok).toBe(false);
  });
});

describe("compareBuildings", () => {
  it("sorts by display order, then by name", () => {
    const rows = [
      building({ name: "C", displayOrder: 2 }),
      building({ name: "B", displayOrder: 1 }),
      building({ name: "A", displayOrder: 1 }),
    ];
    expect([...rows].sort(compareBuildings).map((row) => row.name)).toEqual([
      "A",
      "B",
      "C",
    ]);
  });
});

describe("structure capabilities", () => {
  it("gives Admin both halves", () => {
    expect(evaluateStructureCapabilities(membership("admin"))).toEqual({
      canManage: true,
      canView: true,
    });
  });

  it("lets a Resident read but not edit", () => {
    expect(evaluateStructureCapabilities(membership("resident"))).toEqual({
      canManage: false,
      canView: true,
    });
  });

  it("gives a Guest neither — the narrowest role in the PRD's matrix", () => {
    expect(evaluateStructureCapabilities(membership("guest"))).toEqual({
      canManage: false,
      canView: false,
    });
  });

  it("gives a pending member nothing, even an Admin-to-be", () => {
    // The join flow's building picker is addressed by the join code, not by the
    // society; a member-scoped read is refused until the request is approved.
    expect(
      evaluateStructureCapabilities(membership("admin", "pending")),
    ).toEqual({
      canManage: false,
      canView: false,
    });
  });

  it("gives a removed membership nothing", () => {
    expect(
      evaluateStructureCapabilities(membership("admin", "removed")),
    ).toEqual({
      canManage: false,
      canView: false,
    });
  });

  it("denies a null membership", () => {
    expect(evaluateStructureCapabilities(null)).toEqual({
      canManage: false,
      canView: false,
    });
  });
});

describe("capability rules return a reason, not a bare boolean", () => {
  it("explains a refusal so the UI can say why", () => {
    const outcome = canManageStructure("treasurer");
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) expect(outcome.reason).toContain("Admin");
  });

  it("holds structure.edit to Admin alone", () => {
    const roles: readonly MemberRole[] = [
      "treasurer",
      "committee_member",
      "resident",
      "tenant",
      "guest",
    ];
    expect(roles.filter((role) => canManageStructure(role).allowed)).toEqual(
      [],
    );
  });

  it("holds structure.view to every role but Guest", () => {
    expect(canViewStructure("admin").allowed).toBe(true);
    expect(canViewStructure("tenant").allowed).toBe(true);
    expect(canViewStructure("guest").allowed).toBe(false);
    expect(canViewStructure(null).allowed).toBe(false);
  });
});
