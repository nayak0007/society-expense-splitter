import {
  asExpenseCategoryId,
  asSocietyId,
  asUserId,
  expenseError,
} from "@ses/domain";

import { createExpenseCategory } from "../use-cases/create-category";
import { deleteExpenseCategory } from "../use-cases/delete-category";
import { listExpenseCategories } from "../use-cases/list-categories";
import type { ExpenseCategoryDeps } from "../use-cases/support";
import { updateExpenseCategory } from "../use-cases/update-category";
import {
  expectErr,
  expectOk,
  FakeExpenseCategoryRepository,
} from "./support/fake-category-repository";

/**
 * The four expense-category use cases, against a fake repository.
 *
 * What these tests are *for*, in order of value:
 *
 *  1. **The write rule is Admin *or* Treasurer**, which is where this module differs
 *     from structure (Admin only) and where a copy-paste from that module would be
 *     silently wrong. A Resident and a Committee Member are refused; a Treasurer is not.
 *  2. **A referenced category cannot be deleted**, and the refusal is a typed
 *     `category_has_expenses` with the count — not a `conflict`, and not a message a UI
 *     would have to string-match. Deactivation is what the copy points at.
 *  3. **Validation happens before I/O**, asserted through `callCount(...) === 0` rather
 *     than through the absence of a row.
 *  4. **A partial patch stays partial**, and the strategy/basis pair is resolved against
 *     the *stored* row — the two rules that make reading before writing necessary.
 */

const SOCIETY = "society-1";
const ADMIN = "user-admin";

function setup(): {
  readonly deps: ExpenseCategoryDeps;
  readonly repository: FakeExpenseCategoryRepository;
} {
  const repository = new FakeExpenseCategoryRepository();
  repository.seedMembership(SOCIETY, { userId: ADMIN, role: "admin" });
  return {
    deps: {
      categories: repository,
      expenses: repository,
      memberships: repository,
    },
    repository,
  };
}

describe("createExpenseCategory", () => {
  it("creates for an Admin and resolves every column default", async () => {
    const { deps, repository } = setup();

    const created = expectOk(
      await createExpenseCategory(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        name: "  Water  Tanker ",
      }),
    );

    expect(created.name).toBe("Water Tanker");
    // Resolved in the domain rather than left to the database, so the result is
    // identical whichever adapter ran.
    expect(created.icon).toBeNull();
    expect(created.color).toBeNull();
    expect(created.defaultSplitStrategy).toBe("equal");
    expect(created.defaultApartmentBasis).toBeNull();
    expect(created.isOwnerOnly).toBe(false);
    expect(created.isCapital).toBe(false);
    expect(created.gstApplicable).toBe(false);
    expect(created.isActive).toBe(true);
    expect(created.displayOrder).toBe(0);
    expect(created.deletedAt).toBeNull();
    expect(repository.callCount("create")).toBe(1);
  });

  it("creates for a Treasurer — expense.publish is not Admin-only, unlike structure.edit", async () => {
    const { deps, repository } = setup();
    repository.seedMembership(SOCIETY, {
      userId: "user-treasurer",
      role: "treasurer",
    });

    const created = expectOk(
      await createExpenseCategory(
        deps,
        asUserId("user-treasurer"),
        asSocietyId(SOCIETY),
        { name: "Legal & Professional" },
      ),
    );

    expect(created.name).toBe("Legal & Professional");
    expect(repository.callCount("create")).toBe(1);
  });

  it("keeps the flags, the strategy and the basis it was given", async () => {
    const { deps } = setup();

    const created = expectOk(
      await createExpenseCategory(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        name: "Sinking Fund II",
        icon: "🏦",
        color: "#4F46E5",
        defaultSplitStrategy: "apartment",
        defaultApartmentBasis: "per_sqft_carpet",
        isOwnerOnly: true,
        isCapital: true,
        gstApplicable: true,
        displayOrder: 20,
      }),
    );

    expect(created).toMatchObject({
      icon: "🏦",
      color: "#4f46e5",
      defaultSplitStrategy: "apartment",
      defaultApartmentBasis: "per_sqft_carpet",
      isOwnerOnly: true,
      isCapital: true,
      gstApplicable: true,
      displayOrder: 20,
    });
  });

  it("drops a basis supplied beside a strategy that never reads one", async () => {
    const { deps } = setup();

    const created = expectOk(
      await createExpenseCategory(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        name: "Housekeeping",
        defaultSplitStrategy: "equal",
        defaultApartmentBasis: "per_bhk",
      }),
    );

    // Normalised, not refused: a form posting the whole object sends one on every save.
    expect(created.defaultApartmentBasis).toBeNull();
  });

  it("refuses a blank name without touching storage", async () => {
    const { deps, repository } = setup();

    const error = expectErr(
      await createExpenseCategory(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        name: "   ",
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("name");
    expect(repository.callCount("create")).toBe(0);
  });

  it("refuses a colour that is not a hex literal, naming the field", async () => {
    const { deps, repository } = setup();

    const error = expectErr(
      await createExpenseCategory(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        name: "Security",
        color: "red",
      }),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("color");
    expect(repository.callCount("create")).toBe(0);
  });

  it("refuses a duplicate name as a conflict on `name`, without touching storage", async () => {
    const { deps, repository } = setup();
    repository.seedCategory(SOCIETY, { name: "Maintenance" });

    const error = expectErr(
      await createExpenseCategory(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        name: "Maintenance",
      }),
    );

    // A conflict rather than a validation failure: the payload was fine and the state
    // refused it, which is what lets a client say "already exists" rather than "bad name".
    expect(error.code).toBe("conflict");
    expect(error.details?.field).toBe("name");
    expect(repository.callCount("create")).toBe(0);
  });

  it("allows the same name in another society", async () => {
    const { deps, repository } = setup();
    repository.seedCategory("society-2", { name: "Maintenance" });

    expectOk(
      await createExpenseCategory(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        name: "Maintenance",
      }),
    );

    expect(repository.callCount("create")).toBe(1);
  });

  it("refuses a Resident and a Committee Member — the write rule is Admin or Treasurer", async () => {
    const { deps, repository } = setup();
    repository.seedMembership(SOCIETY, {
      userId: "user-resident",
      role: "resident",
    });
    repository.seedMembership(SOCIETY, {
      userId: "user-committee",
      role: "committee_member",
    });

    for (const actor of ["user-resident", "user-committee"]) {
      const error = expectErr(
        await createExpenseCategory(
          deps,
          asUserId(actor),
          asSocietyId(SOCIETY),
          {
            name: "Painting",
          },
        ),
      );
      expect(error.code).toBe("forbidden");
      expect(error.message).toContain("Admin or Treasurer");
    }
    expect(repository.callCount("create")).toBe(0);
  });

  it("answers not_found — never forbidden — for a non-member", async () => {
    const { deps, repository } = setup();

    const error = expectErr(
      await createExpenseCategory(
        deps,
        asUserId("user-stranger"),
        asSocietyId(SOCIETY),
        { name: "Painting" },
      ),
    );

    expect(error.code).toBe("not_found");
    expect(repository.callCount("create")).toBe(0);
  });

  it("refuses a pending member, who holds no capability yet", async () => {
    const { deps, repository } = setup();
    repository.seedMembership(SOCIETY, {
      userId: "user-pending",
      role: "treasurer",
      status: "pending",
    });

    const error = expectErr(
      await createExpenseCategory(
        deps,
        asUserId("user-pending"),
        asSocietyId(SOCIETY),
        { name: "Painting" },
      ),
    );

    expect(error.code).toBe("forbidden");
  });

  it("converts an adapter failure into the module's vocabulary", async () => {
    const { deps, repository } = setup();
    repository.failNext(
      "create",
      expenseError("conflict", "A category with that name already exists."),
    );

    const error = expectErr(
      await createExpenseCategory(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        name: "Painting",
      }),
    );

    expect(error.code).toBe("conflict");
  });

  it("classifies an unrecognised throw as unknown rather than guessing", async () => {
    const { deps, repository } = setup();
    repository.failNext("create", new Error("connection reset"));

    const error = expectErr(
      await createExpenseCategory(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        name: "Painting",
      }),
    );

    expect(error.code).toBe("unknown");
  });
});

describe("listExpenseCategories", () => {
  it("returns active and inactive rows in display order, with capabilities", async () => {
    const { deps, repository } = setup();
    repository.seedCategory(SOCIETY, {
      name: "Maintenance",
      displayOrder: 1,
    });
    repository.seedCategory(SOCIETY, {
      name: "Festival & Events",
      displayOrder: 13,
      isActive: false,
    });
    repository.seedCategory(SOCIETY, { name: "Water", displayOrder: 2 });

    const list = expectOk(
      await listExpenseCategories(deps, asUserId(ADMIN), asSocietyId(SOCIETY)),
    );

    expect(list.categories.map((category) => category.name)).toEqual([
      "Maintenance",
      "Water",
      "Festival & Events",
    ]);
    // Deactivated rows travel with their flag rather than being filtered out: this is
    // the screen that reactivates them.
    expect(list.categories[2]?.isActive).toBe(false);
    expect(list.capabilities).toEqual({ canManage: true, canView: true });
  });

  it("returns an empty list rather than an error for an unseeded society", async () => {
    const { deps } = setup();

    const list = expectOk(
      await listExpenseCategories(deps, asUserId(ADMIN), asSocietyId(SOCIETY)),
    );

    expect(list.categories).toEqual([]);
  });

  it("lets a Resident read but not write — the capability split the UI renders from", async () => {
    const { deps, repository } = setup();
    repository.seedMembership(SOCIETY, {
      userId: "user-resident",
      role: "resident",
    });

    const list = expectOk(
      await listExpenseCategories(
        deps,
        asUserId("user-resident"),
        asSocietyId(SOCIETY),
      ),
    );

    expect(list.capabilities).toEqual({ canManage: false, canView: true });
  });

  it("refuses a Guest, whose empty list must not look like 'none yet'", async () => {
    const { deps, repository } = setup();
    repository.seedMembership(SOCIETY, { userId: "user-guest", role: "guest" });

    const error = expectErr(
      await listExpenseCategories(
        deps,
        asUserId("user-guest"),
        asSocietyId(SOCIETY),
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(repository.callCount("listCategories")).toBe(0);
  });

  it("answers not_found for a non-member", async () => {
    const { deps } = setup();

    const error = expectErr(
      await listExpenseCategories(
        deps,
        asUserId("user-stranger"),
        asSocietyId(SOCIETY),
      ),
    );

    expect(error.code).toBe("not_found");
  });
});

describe("updateExpenseCategory", () => {
  it("sends only the keys the caller set", async () => {
    const { deps, repository } = setup();
    const seeded = repository.seedCategory(SOCIETY, {
      name: "Maintenance",
      displayOrder: 1,
    });

    expectOk(
      await updateExpenseCategory(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        seeded.id,
        { isActive: false },
      ),
    );

    // The whole point: an edit that deactivates a category must not carry its name.
    expect(repository.updatePatches()).toEqual([{ isActive: false }]);
    expect(repository.stored(seeded.id)?.name).toBe("Maintenance");
    expect(repository.stored(seeded.id)?.isActive).toBe(false);
  });

  it("clears the basis when the strategy moves away from apartment", async () => {
    const { deps, repository } = setup();
    const seeded = repository.seedCategory(SOCIETY, {
      name: "Sinking Fund",
      defaultSplitStrategy: "apartment",
      defaultApartmentBasis: "per_sqft_carpet",
    });

    const updated = expectOk(
      await updateExpenseCategory(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        seeded.id,
        { defaultSplitStrategy: "equal" },
      ),
    );

    // The pair has to stay coherent: a basis beside a non-apartment strategy is a
    // contradiction a reader would have to resolve.
    expect(updated.defaultApartmentBasis).toBeNull();
    expect(repository.updatePatches()).toEqual([
      { defaultSplitStrategy: "equal", defaultApartmentBasis: null },
    ]);
  });

  it("keeps the stored basis when the strategy is untouched", async () => {
    const { deps, repository } = setup();
    const seeded = repository.seedCategory(SOCIETY, {
      name: "Water",
      defaultSplitStrategy: "apartment",
      defaultApartmentBasis: "per_sqft_builtup",
    });

    expectOk(
      await updateExpenseCategory(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        seeded.id,
        { gstApplicable: true },
      ),
    );

    // Neither field was mentioned, so neither is written — the basis must not be
    // silently dropped by an unrelated edit.
    expect(repository.updatePatches()).toEqual([{ gstApplicable: true }]);
    expect(repository.stored(seeded.id)?.defaultApartmentBasis).toBe(
      "per_sqft_builtup",
    );
  });

  it("clears the icon and the colour with an explicit null", async () => {
    const { deps, repository } = setup();
    const seeded = repository.seedCategory(SOCIETY, { name: "Lift" });

    const updated = expectOk(
      await updateExpenseCategory(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        seeded.id,
        { icon: null, color: null },
      ),
    );

    expect(updated.icon).toBeNull();
    expect(updated.color).toBeNull();
  });

  it("lets a rename keep its own name", async () => {
    const { deps, repository } = setup();
    const seeded = repository.seedCategory(SOCIETY, { name: "Maintenance" });

    // The index's predicate excludes the row being updated, so this must not answer
    // `conflict` — the bug a `findByName` without `exceptId` would produce.
    expectOk(
      await updateExpenseCategory(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        seeded.id,
        { name: "Maintenance", displayOrder: 3 },
      ),
    );

    expect(repository.callCount("update")).toBe(1);
  });

  it("refuses a rename that collides with another live category", async () => {
    const { deps, repository } = setup();
    repository.seedCategory(SOCIETY, { name: "Maintenance" });
    const other = repository.seedCategory(SOCIETY, { name: "Water" });

    const error = expectErr(
      await updateExpenseCategory(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        other.id,
        { name: "Maintenance" },
      ),
    );

    expect(error.code).toBe("conflict");
    expect(error.details?.field).toBe("name");
    expect(repository.callCount("update")).toBe(0);
  });

  it("refuses an empty patch rather than performing a no-op write", async () => {
    const { deps, repository } = setup();
    const seeded = repository.seedCategory(SOCIETY, { name: "Maintenance" });

    const error = expectErr(
      await updateExpenseCategory(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        seeded.id,
        {},
      ),
    );

    expect(error.code).toBe("validation");
    expect(repository.callCount("update")).toBe(0);
  });

  it("refuses a Resident", async () => {
    const { deps, repository } = setup();
    repository.seedMembership(SOCIETY, {
      userId: "user-resident",
      role: "resident",
    });
    const seeded = repository.seedCategory(SOCIETY, { name: "Maintenance" });

    const error = expectErr(
      await updateExpenseCategory(
        deps,
        asUserId("user-resident"),
        asSocietyId(SOCIETY),
        seeded.id,
        { name: "Repairs" },
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(repository.callCount("update")).toBe(0);
  });

  it("validates before I/O", async () => {
    const { deps, repository } = setup();
    const seeded = repository.seedCategory(SOCIETY, { name: "Maintenance" });

    const error = expectErr(
      await updateExpenseCategory(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        seeded.id,
        { displayOrder: 100_000 },
      ),
    );

    expect(error.code).toBe("validation");
    expect(error.details?.field).toBe("displayOrder");
    expect(repository.callCount("update")).toBe(0);
  });

  it("answers not_found for a category in another society", async () => {
    const { deps, repository } = setup();
    const foreign = repository.seedCategory("society-2", { name: "Theirs" });

    const error = expectErr(
      await updateExpenseCategory(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        foreign.id,
        { name: "Ours" },
      ),
    );

    expect(error.code).toBe("not_found");
    expect(repository.callCount("update")).toBe(0);
  });
});

describe("deleteExpenseCategory", () => {
  it("soft-deletes: the row survives with deleted_at set", async () => {
    const { deps, repository } = setup();
    const seeded = repository.seedCategory(SOCIETY, { name: "Painting" });

    expectOk(
      await deleteExpenseCategory(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        seeded.id,
      ),
    );

    // Physically gone would orphan the expenses filed under it; the port's contract is
    // a mark, and this is where that is asserted.
    expect(repository.stored(seeded.id)?.deletedAt).not.toBeNull();
  });

  it("frees the name for reuse, because the unique index is partial on live rows", async () => {
    const { deps, repository } = setup();
    const seeded = repository.seedCategory(SOCIETY, { name: "Painting" });

    expectOk(
      await deleteExpenseCategory(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        seeded.id,
      ),
    );

    expectOk(
      await createExpenseCategory(deps, asUserId(ADMIN), asSocietyId(SOCIETY), {
        name: "Painting",
      }),
    );
  });

  it("refuses while an expense references the category, naming the count", async () => {
    const { deps, repository } = setup();
    const seeded = repository.seedCategory(SOCIETY, { name: "Lift" });
    repository.setReferenceCount(seeded.id, 3);

    const error = expectErr(
      await deleteExpenseCategory(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        seeded.id,
      ),
    );

    // Its own code, not a `conflict`: the copy a user needs is "deactivate it instead",
    // and collapsing the two would force a client to match on message text.
    expect(error.code).toBe("category_has_expenses");
    expect(error.details?.count).toBe(3);
    expect(error.message).toContain("Deactivate it instead");
    // The check ran *before* the write: the guard is not a post-hoc explanation.
    expect(repository.callCount("remove")).toBe(0);
    expect(repository.stored(seeded.id)?.deletedAt).toBeNull();
  });

  it("refuses a Resident", async () => {
    const { deps, repository } = setup();
    repository.seedMembership(SOCIETY, {
      userId: "user-resident",
      role: "resident",
    });
    const seeded = repository.seedCategory(SOCIETY, { name: "Lift" });

    const error = expectErr(
      await deleteExpenseCategory(
        deps,
        asUserId("user-resident"),
        asSocietyId(SOCIETY),
        seeded.id,
      ),
    );

    expect(error.code).toBe("forbidden");
    expect(repository.callCount("remove")).toBe(0);
  });

  it("answers not_found for a category in another society", async () => {
    const { deps, repository } = setup();
    const foreign = repository.seedCategory("society-2", { name: "Theirs" });

    const error = expectErr(
      await deleteExpenseCategory(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        foreign.id,
      ),
    );

    expect(error.code).toBe("not_found");
    expect(repository.callCount("remove")).toBe(0);
  });

  it("answers not_found for a category that does not exist", async () => {
    const { deps } = setup();

    const error = expectErr(
      await deleteExpenseCategory(
        deps,
        asUserId(ADMIN),
        asSocietyId(SOCIETY),
        asExpenseCategoryId("00000000-0000-4000-8000-000000000000"),
      ),
    );

    expect(error.code).toBe("not_found");
  });
});
