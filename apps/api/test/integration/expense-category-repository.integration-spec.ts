import type {
  ExpenseCategoryRepository,
  ExpenseReferenceReader,
  UserId,
} from "@ses/domain";
import type postgres from "postgres";

import {
  EXPENSE_CATEGORY_REPOSITORY,
  EXPENSE_REFERENCE_READER,
} from "../../src/modules/expenses/application/expense-category.tokens";

import { createLocalUser, resetData } from "../utils/integration-db";
import {
  insertMember,
  seedSociety,
  type SocietyFixture,
} from "../utils/integration-fixtures";
import {
  startIntegrationHarness,
  type IntegrationHarness,
} from "../utils/integration-harness";

/**
 * `ExpenseCategoryRepositoryPostgres` against real PostgreSQL and real RLS — Roadmap
 * T062.
 *
 * ## What only this suite can prove
 *
 * The unit and e2e suites substitute the store, so nothing in them evaluates a policy,
 * a column grant or a `SECURITY DEFINER` function. Four claims live *only* here:
 *
 *  1. **The reads are member-scoped.** A Guest's `expense.view` is `—` in the PRD's
 *     matrix and `can_view_expenses()` excludes them, so the list is empty for a Guest
 *     and for a non-member — and empty, not an error, is what RLS produces.
 *  2. **The writes are manager-scoped**, by a `WITH CHECK` rather than by a function:
 *     a Resident's insert is refused with a `42501` the classifier turns into
 *     `forbidden`.
 *  3. **`expense_category_soft_delete()` is the only path to a tombstone**, and it
 *     carries the reference check. Both halves are asserted: the refusal while an
 *     expense references the category, and the deletion once none does.
 *  4. **The seeded nineteen are real rows this repository reads**, in the document's
 *     order with the two funds flagged — the default-19 regression, asserted through
 *     the adapter rather than through SQL.
 *
 * ## Why a voided expense is one of the fixtures
 *
 * Because it is the case that distinguishes this module's rule from the building one:
 * `expenses` has no `deleted_at`, so the reference check counts **every** expense. A
 * *voided* expense still renders its category's name in every list and report, so it
 * must keep the category undeletable. A test that only used a live expense would pass
 * against a live-only filter, which is the bug the rule exists to avoid.
 *
 * Fixtures are written on the **owner** connection (RLS-exempt, DDL-capable); every
 * assertion that is about tenancy runs through the adapter, which goes through
 * `UnitOfWork` as a real identity.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
let categories: ExpenseCategoryRepository;
let references: ExpenseReferenceReader;

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  categories = harness.app.get<ExpenseCategoryRepository>(
    EXPENSE_CATEGORY_REPOSITORY,
  );
  references = harness.app.get<ExpenseReferenceReader>(
    EXPENSE_REFERENCE_READER,
  );
}, 60_000);

afterAll(async () => {
  await harness.stop();
});

interface Fixture extends SocietyFixture {
  /** An active ordinary member — a non-manager for the policy tests. */
  readonly residentUserId: UserId;
  /** An active Guest: a member whose role holds no `expense.view`. */
  readonly guestUserId: UserId;
  /** A user in no society at all. */
  readonly outsiderUserId: UserId;
}

async function seed(): Promise<Fixture> {
  const society = await seedSociety(
    harness,
    "Alpha Court",
    "admin@cat.ses.test",
  );
  const residentUserId = (await createLocalUser(
    owner,
    "resident@cat.ses.test",
    "Resident",
  )) as UserId;
  await insertMember(owner, society.societyId, {
    userId: residentUserId,
    displayName: "Resident",
    phone: "+919876500401",
    role: "resident",
  });
  const guestUserId = (await createLocalUser(
    owner,
    "guest@cat.ses.test",
    "Guest",
  )) as UserId;
  await insertMember(owner, society.societyId, {
    userId: guestUserId,
    displayName: "Guest",
    phone: "+919876500402",
    role: "guest",
  });
  const outsiderUserId = (await createLocalUser(
    owner,
    "outsider@cat.ses.test",
    "Outsider",
  )) as UserId;
  return { ...society, residentUserId, guestUserId, outsiderUserId };
}

async function rejection(promise: Promise<unknown>): Promise<{
  readonly code?: unknown;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
  readonly message?: unknown;
}> {
  try {
    await promise;
  } catch (error: unknown) {
    return error as {
      readonly code?: unknown;
      readonly details?: Readonly<Record<string, unknown>> | undefined;
      readonly message?: unknown;
    };
  }
  throw new Error("Expected the call to reject, but it resolved.");
}

/** One expense of `society`, referencing `categoryId`, inserted as the owner. */
async function insertExpense(
  fixture: Fixture,
  categoryId: string,
  status: "draft" | "void" = "draft",
): Promise<string> {
  const [row] = await owner<{ id: string }[]>`
    insert into public.expenses (
      society_id, category_id, title, amount_paise, expense_date,
      split_strategy, status, void_reason, created_by
    )
    values (
      ${fixture.societyId}::uuid, ${categoryId}::uuid, 'Water tanker',
      10000::bigint, current_date, 'equal', ${status}::public.expense_status,
      ${status === "void" ? "Duplicate entry" : null}::varchar,
      ${fixture.adminMemberId}::uuid
    )
    returning id
  `;
  return row!.id;
}

/** The live category named `name` of `societyId`, read as one of its members. */
async function findByName(
  fixture: Fixture,
  name: string,
): Promise<{ readonly id: string } | undefined> {
  const listed = await categories.listCategories(
    fixture.societyId,
    fixture.adminUserId,
  );
  return listed.find((category) => category.name === name);
}

describe("ExpenseCategoryRepositoryPostgres", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  describe("reads", () => {
    it("lists the nineteen seeded categories in the PRD's order", async () => {
      const rows = await categories.listCategories(
        fixture.societyId,
        fixture.adminUserId,
      );

      // The default-19 regression, asserted through the adapter: the seed is a trigger
      // on society creation, so this is what a real society's picker reads on day one.
      expect(rows).toHaveLength(19);
      expect(rows[0]).toMatchObject({ name: "Maintenance", displayOrder: 1 });
      expect(rows[18]).toMatchObject({
        name: "Miscellaneous",
        displayOrder: 19,
      });
      expect(rows.map((row) => row.displayOrder)).toEqual(
        Array.from({ length: 19 }, (_, index) => index + 1),
      );
      // Only the two funds carry the flags the PRD names, and they carry both.
      expect(
        rows
          .filter((row) => row.isOwnerOnly || row.isCapital)
          .map((row) => row.name),
      ).toEqual(["Sinking Fund", "Corpus Fund"]);
      // Every seeded row starts editable and active with the schema's defaults.
      expect(rows.every((row) => row.isActive)).toBe(true);
      expect(rows.every((row) => row.defaultSplitStrategy === "equal")).toBe(
        true,
      );
      expect(rows.every((row) => row.defaultApartmentBasis === null)).toBe(
        true,
      );
    });

    it("orders by display order, then by name, so a society's own rows sort among the seed", async () => {
      await categories.create(
        fixture.societyId,
        { name: "A Amenity", displayOrder: 0 },
        fixture.adminUserId,
      );
      await categories.create(
        fixture.societyId,
        { name: "Z Amenity", displayOrder: 0 },
        fixture.adminUserId,
      );

      const rows = await categories.listCategories(
        fixture.societyId,
        fixture.adminUserId,
      );

      // display_order 0 first (the column's default), ties broken by name.
      expect(rows[0]?.name).toBe("A Amenity");
      expect(rows[1]?.name).toBe("Z Amenity");
      expect(rows[2]?.name).toBe("Maintenance");
    });

    it("returns one category to a member, and null across societies or after removal", async () => {
      const maintenance = await findByName(fixture, "Maintenance");
      expect(maintenance).toBeDefined();

      expect(
        await categories.findCategory(
          maintenance!.id as never,
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toMatchObject({ name: "Maintenance" });

      // A member of one society cannot address another's category by id.
      const other = await seedSociety(
        harness,
        "Other Court",
        "other@cat.ses.test",
      );
      expect(
        await categories.findCategory(
          maintenance!.id as never,
          other.societyId,
          other.adminUserId,
        ),
      ).toBeNull();

      await categories.remove(
        maintenance!.id as never,
        fixture.societyId,
        fixture.adminUserId,
      );
      expect(
        await categories.findCategory(
          maintenance!.id as never,
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toBeNull();
    });

    it("gives a Guest nothing — can_view_expenses excludes them", async () => {
      // Not an error and not a 403: RLS filters rows, so the answer is an empty list.
      // That is exactly why the use case checks the capability before the query — an
      // empty list and "not for you" must not be the same screen.
      expect(
        await categories.listCategories(fixture.societyId, fixture.guestUserId),
      ).toEqual([]);
    });

    it("gives a non-member nothing, for a read of the list or of one row", async () => {
      const maintenance = await findByName(fixture, "Maintenance");

      expect(
        await categories.listCategories(
          fixture.societyId,
          fixture.outsiderUserId,
        ),
      ).toEqual([]);
      expect(
        await categories.findCategory(
          maintenance!.id as never,
          fixture.societyId,
          fixture.outsiderUserId,
        ),
      ).toBeNull();
    });
  });

  describe("writes", () => {
    it("fills the column defaults and maps every field it was sent", async () => {
      const bare = await categories.create(
        fixture.societyId,
        { name: "Bare Category" },
        fixture.adminUserId,
      );
      expect(bare).toMatchObject({
        name: "Bare Category",
        icon: null,
        color: null,
        defaultSplitStrategy: "equal",
        defaultApartmentBasis: null,
        isOwnerOnly: false,
        isCapital: false,
        gstApplicable: false,
        isActive: true,
        displayOrder: 0,
        deletedAt: null,
      });

      const rich = await categories.create(
        fixture.societyId,
        {
          name: "Rich Category",
          icon: "🏦",
          color: "#4f46e5",
          defaultSplitStrategy: "apartment",
          defaultApartmentBasis: "per_sqft_carpet",
          isOwnerOnly: true,
          isCapital: true,
          gstApplicable: true,
          displayOrder: 20,
        },
        fixture.adminUserId,
      );
      expect(rich).toMatchObject({
        icon: "🏦",
        color: "#4f46e5",
        defaultSplitStrategy: "apartment",
        defaultApartmentBasis: "per_sqft_carpet",
        isOwnerOnly: true,
        isCapital: true,
        gstApplicable: true,
        displayOrder: 20,
      });

      expect(
        await categories.findCategory(
          rich.id,
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toMatchObject({ name: "Rich Category", gstApplicable: true });
    });

    it("lets a Treasurer write, and refuses a Resident and a Guest", async () => {
      const treasurerUserId = (await createLocalUser(
        owner,
        "treasurer@cat.ses.test",
        "Treasurer",
      )) as UserId;
      await insertMember(owner, fixture.societyId, {
        userId: treasurerUserId,
        displayName: "Treasurer",
        phone: "+919876500403",
        role: "treasurer",
      });

      // The manager predicate is `can_publish_expenses()`, which is Admin **or**
      // Treasurer — the one place this module differs from the structure module.
      const created = await categories.create(
        fixture.societyId,
        { name: "Treasurer Category" },
        treasurerUserId,
      );
      expect(created.name).toBe("Treasurer Category");

      for (const actor of [fixture.residentUserId, fixture.guestUserId]) {
        const error = await rejection(
          categories.create(
            fixture.societyId,
            { name: `Refused ${String(actor)}` },
            actor,
          ),
        );
        expect(error.code).toBe("forbidden");
      }

      const rows = await categories.listCategories(
        fixture.societyId,
        fixture.adminUserId,
      );
      expect(rows.map((row) => row.name)).not.toContain(
        `Refused ${fixture.residentUserId}`,
      );
    });

    it("translates a duplicate live name into a conflict, but allows it elsewhere", async () => {
      const error = await rejection(
        categories.create(
          fixture.societyId,
          { name: "Maintenance" },
          fixture.adminUserId,
        ),
      );
      expect(error.code).toBe("conflict");
      expect(error.details?.field).toBe("name");

      // The unique index is scoped to the society (and partial on live rows): the same
      // name is fine in another one. The name has to be one the *seed* does not already
      // put in the other society — every society is seeded with the same nineteen, so a
      // seeded name would collide there for an unrelated reason and prove nothing.
      const amenity = await categories.create(
        fixture.societyId,
        { name: "Canary Amenity" },
        fixture.adminUserId,
      );
      expect(amenity.name).toBe("Canary Amenity");

      const other = await seedSociety(
        harness,
        "Other Court",
        "other@cat.ses.test",
      );
      const elsewhere = await categories.create(
        other.societyId,
        { name: "Canary Amenity" },
        other.adminUserId,
      );
      expect(elsewhere.name).toBe("Canary Amenity");
    });

    it("treats a name that differs only in case as a different name", async () => {
      // `uq_expense_categories_society_name` compares the stored text, so this is the
      // index's behaviour rather than a choice made in the adapter — and the reason
      // `findByName` must not lower-case either side: a case-insensitive check would
      // refuse a create the database accepts, which is a rule with nothing behind it.
      // The seed already holds `Maintenance`.
      const created = await categories.create(
        fixture.societyId,
        { name: "maintenance" },
        fixture.adminUserId,
      );
      expect(created.name).toBe("maintenance");
      expect(
        await categories.findByName(
          "maintenance",
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toMatchObject({ name: "maintenance" });
    });

    it("scopes findByName to live rows, so a removed name is free again", async () => {
      const maintenance = await findByName(fixture, "Maintenance");
      await categories.remove(
        maintenance!.id as never,
        fixture.societyId,
        fixture.adminUserId,
      );

      expect(
        await categories.findByName(
          "Maintenance",
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toBeNull();
      // And the index agrees: the name can be taken again.
      const recreated = await categories.create(
        fixture.societyId,
        { name: "Maintenance" },
        fixture.adminUserId,
      );
      expect(recreated.name).toBe("Maintenance");
    });

    it("honours exceptId, so a rename onto its own name is not a conflict", async () => {
      const maintenance = await findByName(fixture, "Maintenance");

      expect(
        await categories.findByName(
          "Maintenance",
          fixture.societyId,
          fixture.adminUserId,
          maintenance!.id as never,
        ),
      ).toBeNull();
    });

    it("translates a negative display order into a validation error", async () => {
      const error = await rejection(
        categories.create(
          fixture.societyId,
          { name: "Negative", displayOrder: -1 },
          fixture.adminUserId,
        ),
      );
      expect(error.code).toBe("validation");
    });

    it("patches only the fields sent, and clears a nullable column with an explicit null", async () => {
      const seeded = await categories.create(
        fixture.societyId,
        {
          name: "Sinking Fund II",
          icon: "🏦",
          color: "#112233",
          defaultSplitStrategy: "apartment",
          defaultApartmentBasis: "per_sqft_carpet",
          displayOrder: 20,
        },
        fixture.adminUserId,
      );

      const renamed = await categories.update(
        seeded.id,
        fixture.societyId,
        { name: "Corpus Fund II" },
        fixture.adminUserId,
      );
      expect(renamed.name).toBe("Corpus Fund II");
      // Absent fields are left alone — including `icon`, which has a value and is not
      // a `coalesce`-shaped column.
      expect(renamed.icon).toBe("🏦");
      expect(renamed.displayOrder).toBe(20);

      const cleared = await categories.update(
        seeded.id,
        fixture.societyId,
        { icon: null, color: null, defaultApartmentBasis: null },
        fixture.adminUserId,
      );
      // The three clearable columns really are cleared, which is the whole reason the
      // adapter builds an assignment list instead of using `coalesce`.
      expect(cleared.icon).toBeNull();
      expect(cleared.color).toBeNull();
      expect(cleared.defaultApartmentBasis).toBeNull();
      // Untouched: the strategy was not part of the patch.
      expect(cleared.defaultSplitStrategy).toBe("apartment");
    });

    it("deactivates rather than deletes, and the row stays readable", async () => {
      const seeded = await findByName(fixture, "Painting");

      const updated = await categories.update(
        seeded!.id as never,
        fixture.societyId,
        { isActive: false },
        fixture.adminUserId,
      );
      expect(updated.isActive).toBe(false);

      const rows = await categories.listCategories(
        fixture.societyId,
        fixture.adminUserId,
      );
      expect(rows.find((row) => row.name === "Painting")?.isActive).toBe(false);
    });

    it("translates a rename onto another live name into a conflict", async () => {
      const painting = await findByName(fixture, "Painting");

      const error = await rejection(
        categories.update(
          painting!.id as never,
          fixture.societyId,
          { name: "Maintenance" },
          fixture.adminUserId,
        ),
      );
      expect(error.code).toBe("conflict");
    });

    it("answers not_found for an unknown category, and for one in another society", async () => {
      const unknown = await rejection(
        categories.update(
          "00000000-0000-4000-8000-000000000000" as never,
          fixture.societyId,
          { name: "Nowhere" },
          fixture.adminUserId,
        ),
      );
      expect(unknown.code).toBe("not_found");

      const other = await seedSociety(
        harness,
        "Other Court",
        "other@cat.ses.test",
      );
      const theirs = await categories.create(
        other.societyId,
        { name: "Theirs" },
        other.adminUserId,
      );
      const acrossSocieties = await rejection(
        categories.update(
          theirs.id,
          other.societyId,
          { name: "Ours" },
          fixture.adminUserId,
        ),
      );
      // The caller is an active member of *this* society and a member of no other, so
      // the pair is what makes the row unreachable.
      expect(acrossSocieties.code).toBe("not_found");
    });

    it("answers not_found for an update by a member who is not a manager", async () => {
      const painting = await findByName(fixture, "Painting");

      const error = await rejection(
        categories.update(
          painting!.id as never,
          fixture.societyId,
          { name: "Repairs" },
          fixture.residentUserId,
        ),
      );

      // `not_found`, not `forbidden` — and this is RLS rather than a rule: an UPDATE's
      // `USING` clause *filters* rows instead of raising, so a non-manager's statement
      // matches nothing and the adapter's zero-rows branch answers 404. That is the same
      // answer `findCategory` gives them, and the same 404-not-403 the read side uses
      // (PRD T041) — a Resident cannot learn which category ids exist in a society whose
      // vocabulary they can see anyway, but a *stranger* learns nothing at all.
      //
      // The 403 the API promises comes from the two layers above: `PermissionGuard`
      // (`expense.publish` is not a Resident's) and the use case's capability guard.
      // Both are asserted in `expenses.e2e-spec.ts`, which is where a status code belongs.
      // Contrast `remove`, whose *function* raises P0003 and so really does answer
      // `forbidden` — asserted below, and the asymmetry is the point.
      expect(error.code).toBe("not_found");

      // And nothing changed.
      expect(await findByName(fixture, "Painting")).toBeDefined();
      expect(await findByName(fixture, "Repairs")).toBeUndefined();
    });
  });

  describe("countForCategory", () => {
    it("counts every expense that references the category, voided ones included", async () => {
      const maintenance = await findByName(fixture, "Maintenance");

      expect(
        await references.countForCategory(
          maintenance!.id as never,
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toBe(0);

      await insertExpense(fixture, maintenance!.id, "draft");
      await insertExpense(fixture, maintenance!.id, "void");

      // The voided row counts: `expenses` has no `deleted_at`, and a voided expense
      // still renders its category's name in every list and report.
      expect(
        await references.countForCategory(
          maintenance!.id as never,
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toBe(2);
    });
  });

  describe("remove", () => {
    it("soft-deletes through the function, leaving the row for the expenses that named it", async () => {
      const painting = await findByName(fixture, "Painting");

      await categories.remove(
        painting!.id as never,
        fixture.societyId,
        fixture.adminUserId,
      );

      const rows = await categories.listCategories(
        fixture.societyId,
        fixture.adminUserId,
      );
      expect(rows.map((row) => row.name)).not.toContain("Painting");

      // The row survives with a tombstone — which is what makes it soft, and what keeps
      // a historical expense's category name resolvable.
      const [row] = await owner<{ deleted_at: string | null }[]>`
        select deleted_at from public.expense_categories where id = ${painting!.id}::uuid
      `;
      expect(row?.deleted_at).not.toBeNull();
    });

    it("refuses while an expense references the category, live or voided", async () => {
      const lift = await findByName(fixture, "Lift");
      await insertExpense(fixture, lift!.id, "draft");

      const live = await rejection(
        categories.remove(
          lift!.id as never,
          fixture.societyId,
          fixture.adminUserId,
        ),
      );
      expect(live.code).toBe("category_has_expenses");
      expect(String(live.message)).toContain("Deactivate it instead");

      // The same refusal for a *voided* expense, which is the case a live-only filter
      // would get wrong.
      const plumbing = await findByName(fixture, "Plumbing");
      await insertExpense(fixture, plumbing!.id, "void");
      const voided = await rejection(
        categories.remove(
          plumbing!.id as never,
          fixture.societyId,
          fixture.adminUserId,
        ),
      );
      expect(voided.code).toBe("category_has_expenses");

      // Neither was removed.
      for (const name of ["Lift", "Plumbing"]) {
        expect(await findByName(fixture, name)).toBeDefined();
      }
    });

    it("deletes an unreferenced category", async () => {
      const painting = await findByName(fixture, "Painting");

      await categories.remove(
        painting!.id as never,
        fixture.societyId,
        fixture.adminUserId,
      );

      expect(await findByName(fixture, "Painting")).toBeUndefined();
    });

    it("answers not_found for an unknown category or a removal by a non-manager", async () => {
      const unknown = await rejection(
        categories.remove(
          "00000000-0000-4000-8000-000000000000" as never,
          fixture.societyId,
          fixture.adminUserId,
        ),
      );
      expect(unknown.code).toBe("not_found");

      // The RPC's own ordering: a member whose role is not enough gets P0003, which the
      // classifier reads as `forbidden` — the caller clearly knows the society exists.
      const painting = await findByName(fixture, "Painting");
      const forbidden = await rejection(
        categories.remove(
          painting!.id as never,
          fixture.societyId,
          fixture.residentUserId,
        ),
      );
      expect(forbidden.code).toBe("forbidden");
      expect(await findByName(fixture, "Painting")).toBeDefined();
    });

    it("answers not_found — P0002, before P0003 — for a non-member", async () => {
      const painting = await findByName(fixture, "Painting");

      const error = await rejection(
        categories.remove(
          painting!.id as never,
          fixture.societyId,
          fixture.outsiderUserId,
        ),
      );

      // `assert_society_membership` runs first, so a stranger cannot tell another
      // tenant's society from a non-existent one (PRD T041).
      expect(error.code).toBe("not_found");
      expect(await findByName(fixture, "Painting")).toBeDefined();
    });
  });
});
