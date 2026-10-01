import type { MemberRole, SocietyMembership } from "../../society/society";
import { asMemberId, asSocietyId, asUserId } from "../../shared/ids";
import {
  CATEGORY_DISPLAY_ORDER_MAX,
  CATEGORY_NAME_MAX_LENGTH,
  CATEGORY_ICON_MAX_LENGTH,
  DEFAULT_CATEGORY_DISPLAY_ORDER,
  compareExpenseCategories,
  type ExpenseCategory,
} from "../expense-category";
import {
  DEFAULT_CATEGORY_SPLIT_STRATEGY,
  createCategoryColor,
  createCategoryDisplayOrder,
  createCategoryIcon,
  createCategoryName,
  resolveCategoryApartmentBasis,
} from "../category-value-objects";
import {
  canManageExpenseCategories,
  canViewExpenseCategories,
  evaluateExpenseCategoryCapabilities,
} from "../rules";

/**
 * Expense-category value objects and capability rules (Roadmap T062).
 *
 * These are the first line of defence the API, the mobile form and a seed script all
 * run, so the assertions are about the *rules* rather than about the strings: that the
 * name is normalised the way the unique index will store it, that a colour must be a
 * hex literal, that a basis cannot survive beside a non-apartment strategy, and that
 * category writes are Admin **or Treasurer** — which is where this module differs from
 * structure, and so is the one thing most worth pinning.
 */

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

function category(overrides: Partial<ExpenseCategory> = {}): ExpenseCategory {
  return {
    id: "c1" as ExpenseCategory["id"],
    societyId: asSocietyId("s1"),
    name: "A",
    icon: null,
    color: null,
    defaultSplitStrategy: "equal",
    defaultApartmentBasis: null,
    isOwnerOnly: false,
    isCapital: false,
    gstApplicable: false,
    isActive: true,
    displayOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

describe("createCategoryName", () => {
  it("collapses whitespace, because the unique index compares the stored text", () => {
    // `"Water"` and `"Water "` are two names to the database and one to a reader, so
    // normalising before the write is what keeps the two rules from disagreeing.
    expect(createCategoryName("  Water  ")).toEqual({
      ok: true,
      value: "Water",
    });
    expect(createCategoryName("Bank   Charges")).toEqual({
      ok: true,
      value: "Bank Charges",
    });
  });

  it("leaves the case alone, matching the exact-string index", () => {
    // Lower-casing here would be a rule the database does not share, so it would
    // refuse creates the index would accept.
    expect(createCategoryName("  Sinking Fund ")).toEqual({
      ok: true,
      value: "Sinking Fund",
    });
  });

  it("refuses an empty or whitespace-only name, naming the field", () => {
    const result = createCategoryName("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("validation");
      expect(result.error.details?.field).toBe("name");
    }
  });

  it("refuses a name longer than the column", () => {
    expect(createCategoryName("A".repeat(CATEGORY_NAME_MAX_LENGTH)).ok).toBe(
      true,
    );
    expect(
      createCategoryName("A".repeat(CATEGORY_NAME_MAX_LENGTH + 1)).ok,
    ).toBe(false);
  });

  it("refuses control characters, which mean a paste rather than a name", () => {
    expect(createCategoryName("Water\u0000").ok).toBe(false);
  });
});

describe("createCategoryIcon", () => {
  it("treats absent, null and empty as one answer: no icon", () => {
    // The column's representation of "none" is `null`, so `""` must not become a
    // second spelling every reader would have to know about.
    expect(createCategoryIcon(undefined)).toEqual({ ok: true, value: null });
    expect(createCategoryIcon(null)).toEqual({ ok: true, value: null });
    expect(createCategoryIcon("   ")).toEqual({ ok: true, value: null });
  });

  it("keeps an emoji or a short identifier, trimmed", () => {
    expect(createCategoryIcon("  💧  ")).toEqual({ ok: true, value: "💧" });
    expect(createCategoryIcon("wrench")).toEqual({ ok: true, value: "wrench" });
  });

  it("refuses an icon longer than the column", () => {
    expect(
      createCategoryIcon("x".repeat(CATEGORY_ICON_MAX_LENGTH + 1)).ok,
    ).toBe(false);
  });
});

describe("createCategoryColor", () => {
  it("accepts the two forms the column's width implies, lower-cased", () => {
    // `varchar(9)` is exactly `#RRGGBBAA`, so the width is the format's authority.
    expect(createCategoryColor("#4F46E5")).toEqual({
      ok: true,
      value: "#4f46e5",
    });
    expect(createCategoryColor("  #4F46E5FF ")).toEqual({
      ok: true,
      value: "#4f46e5ff",
    });
  });

  it("treats absent, null and empty as no colour", () => {
    expect(createCategoryColor(undefined)).toEqual({ ok: true, value: null });
    expect(createCategoryColor(null)).toEqual({ ok: true, value: null });
    expect(createCategoryColor("")).toEqual({ ok: true, value: null });
  });

  it("refuses a colour word or a short hex, naming the field", () => {
    for (const value of ["red", "#abc", "#4F46E", "4f46e5", "#4F46E5F"]) {
      const result = createCategoryColor(value);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("validation");
        expect(result.error.details?.field).toBe("color");
      }
    }
  });
});

describe("resolveCategoryApartmentBasis", () => {
  it("keeps a basis only for the strategy that reads one", () => {
    expect(resolveCategoryApartmentBasis("apartment", "per_sqft_carpet")).toBe(
      "per_sqft_carpet",
    );
  });

  it("drops a basis supplied for a strategy that never reads one", () => {
    // Normalised rather than refused: a form that posts the whole category object
    // sends a basis on every save, including when the strategy is `equal`.
    expect(
      resolveCategoryApartmentBasis("equal", "per_sqft_carpet"),
    ).toBeNull();
    expect(resolveCategoryApartmentBasis("percentage", "per_bhk")).toBeNull();
    expect(resolveCategoryApartmentBasis("custom", "per_flat")).toBeNull();
  });

  it("allows an apartment default with no basis yet chosen", () => {
    // A default is allowed to be incomplete in a way an expense is not: T063's
    // expense form is what asks for the basis.
    expect(resolveCategoryApartmentBasis("apartment", null)).toBeNull();
  });
});

describe("createCategoryDisplayOrder", () => {
  it("resolves the column default rather than leaving it to the database", () => {
    expect(createCategoryDisplayOrder(undefined)).toEqual({
      ok: true,
      value: DEFAULT_CATEGORY_DISPLAY_ORDER,
    });
    expect(createCategoryDisplayOrder(null)).toEqual({
      ok: true,
      value: DEFAULT_CATEGORY_DISPLAY_ORDER,
    });
  });

  it("accepts the seeded range and refuses a negative or absurd order", () => {
    expect(createCategoryDisplayOrder(19)).toEqual({ ok: true, value: 19 });
    expect(createCategoryDisplayOrder(-1).ok).toBe(false);
    expect(createCategoryDisplayOrder(CATEGORY_DISPLAY_ORDER_MAX + 1).ok).toBe(
      false,
    );
    expect(createCategoryDisplayOrder(1.5).ok).toBe(false);
  });
});

describe("compareExpenseCategories", () => {
  it("sorts by display order, then by name", () => {
    const rows = [
      category({ name: "C", displayOrder: 2 }),
      category({ name: "B", displayOrder: 1 }),
      category({ name: "A", displayOrder: 1 }),
    ];
    expect(
      [...rows].sort(compareExpenseCategories).map((row) => row.name),
    ).toEqual(["A", "B", "C"]);
  });
});

describe("expense-category capabilities", () => {
  it('gives Admin and Treasurer both halves — the PRD\'s "Admin and treasurer can write"', () => {
    for (const role of ["admin", "treasurer"] as const) {
      expect(evaluateExpenseCategoryCapabilities(membership(role))).toEqual({
        canManage: true,
        canView: true,
      });
    }
  });

  it('lets every other member read and not write — "all members can read"', () => {
    for (const role of ["committee_member", "resident", "tenant"] as const) {
      expect(evaluateExpenseCategoryCapabilities(membership(role))).toEqual({
        canManage: false,
        canView: true,
      });
    }
  });

  it("gives a Guest neither — the narrowest role in the PRD's matrix", () => {
    expect(evaluateExpenseCategoryCapabilities(membership("guest"))).toEqual({
      canManage: false,
      canView: false,
    });
  });

  it("gives a pending or removed membership nothing, whatever the role says", () => {
    expect(
      evaluateExpenseCategoryCapabilities(membership("treasurer", "pending")),
    ).toEqual({ canManage: false, canView: false });
    expect(
      evaluateExpenseCategoryCapabilities(membership("admin", "removed")),
    ).toEqual({ canManage: false, canView: false });
  });

  it("denies a null membership", () => {
    expect(evaluateExpenseCategoryCapabilities(null)).toEqual({
      canManage: false,
      canView: false,
    });
  });
});

describe("the capability rules delegate to the matrix", () => {
  it("holds category writes to Admin and Treasurer, and no further", () => {
    // The one place this module differs from structure, where the same set of roles
    // is refused: T060's `can_publish_expenses()` is the predicate behind every
    // category policy, and its own comment says it covers "category writes".
    const roles: readonly MemberRole[] = [
      "admin",
      "treasurer",
      "committee_member",
      "resident",
      "tenant",
      "guest",
    ];
    expect(
      roles.filter((role) => canManageExpenseCategories(role).allowed),
    ).toEqual(["admin", "treasurer"]);
  });

  it("holds category reads to every role but Guest", () => {
    expect(canViewExpenseCategories("committee_member").allowed).toBe(true);
    expect(canViewExpenseCategories("tenant").allowed).toBe(true);
    expect(canViewExpenseCategories("guest").allowed).toBe(false);
    expect(canViewExpenseCategories(null).allowed).toBe(false);
  });

  it("explains a refusal so the UI can say why", () => {
    const outcome = canManageExpenseCategories("committee_member");
    expect(outcome.allowed).toBe(false);
    if (!outcome.allowed) {
      expect(outcome.reason).toContain("Admin or Treasurer");
    }
  });
});

describe("the resolved defaults are the columns' defaults", () => {
  it("is `equal`, which is what a new expense starts as", () => {
    expect(DEFAULT_CATEGORY_SPLIT_STRATEGY).toBe("equal");
  });
});
