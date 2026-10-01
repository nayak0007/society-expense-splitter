import { randomUUID } from "node:crypto";

import {
  ExpenseError,
  asExpenseCategoryId,
  asSocietyId,
  compareExpenseCategories,
} from "@ses/domain";
import type {
  CreateExpenseCategoryInput,
  ExpenseCategory,
  ExpenseCategoryId,
  ExpenseCategoryRepository,
  ExpenseReferenceReader,
  SocietyId,
  UpdateExpenseCategoryInput,
  UserId,
} from "@ses/domain";

/**
 * An in-memory category store for HTTP-level tests — both storage ports, as the
 * `createTestApp` seam expects.
 *
 * ## What is faked, and what is emphatically not
 *
 * Only the *storage* and the *tenancy check* — the two things that need a Postgres
 * connection. Everything between the request and this object runs for real: the global
 * auth guard verifies a real signature, `SocietyGuard` resolves the header,
 * `PermissionGuard` asks the domain's matrix, the Zod pipe parses the real contract
 * schema, `ExpenseCategoryOperations` calls the real use case, and the mapper parses its
 * output against the same contract the mobile client does. A fake at *this* boundary
 * therefore still fails when a rule regresses; a fake at the controller boundary would
 * not.
 *
 * It reproduces the four properties the ports promise and a use case is allowed to rely
 * on:
 *
 *  - a category is addressable only by the pair `(category id, society id)`, so one
 *    belonging to another society is *unreachable*, not merely unauthorised;
 *  - `findByName` compares the stored text **exactly**, over **live rows of one
 *    society**, excluding the row being updated — and `create`/`update` enforce the same
 *    thing as the unique index would, so the 409 a client sees is the one the database
 *    would have produced;
 *  - `update` applies a patch field by field, so an absent key leaves the stored value
 *    untouched and an explicit `null` clears a nullable column;
 *  - `remove` marks the row rather than deleting it, and the name becomes available
 *    again — the property that makes the partial index worth reproducing rather than
 *    approximating.
 *
 * It deliberately does **not** enforce the Admin/Treasurer role, the capability rules or
 * the value objects. Those are what the guard chain, the use cases and the domain are
 * under test for, and a fake that enforced them too would let a broken one pass.
 *
 * It is **not** a substitute for the RLS canary or the integration suite: nothing here
 * evaluates a policy, so a mistake in the committed SQL is invisible to these tests.
 * That is the point of saying so out loud.
 */

export interface FakeCategoryRepository
  extends ExpenseCategoryRepository, ExpenseReferenceReader {
  readonly state: {
    readonly categories: Map<string, ExpenseCategory>;
    /** How many expenses reference each category id — the delete rule's input. */
    readonly references: Map<string, number>;
    readonly calls: string[];
  };
  /** Inserts a category out of band, bypassing every rule. */
  seed(
    societyId: string,
    spec?: {
      readonly id?: string;
      readonly name?: string;
      readonly icon?: string | null;
      readonly color?: string | null;
      readonly defaultSplitStrategy?: ExpenseCategory["defaultSplitStrategy"];
      readonly defaultApartmentBasis?: ExpenseCategory["defaultApartmentBasis"];
      readonly isOwnerOnly?: boolean;
      readonly isCapital?: boolean;
      readonly gstApplicable?: boolean;
      readonly isActive?: boolean;
      readonly displayOrder?: number;
      readonly deleted?: boolean;
    },
  ): ExpenseCategory;
}

const NOW = "2026-10-01T10:00:00.000Z";

export function createFakeCategoryRepository(): FakeCategoryRepository {
  const categories = new Map<string, ExpenseCategory>();
  const references = new Map<string, number>();
  const calls: string[] = [];
  let sequence = 0;

  function seed(
    societyId: string,
    spec: {
      readonly id?: string;
      readonly name?: string;
      readonly icon?: string | null;
      readonly color?: string | null;
      readonly defaultSplitStrategy?: ExpenseCategory["defaultSplitStrategy"];
      readonly defaultApartmentBasis?: ExpenseCategory["defaultApartmentBasis"];
      readonly isOwnerOnly?: boolean;
      readonly isCapital?: boolean;
      readonly gstApplicable?: boolean;
      readonly isActive?: boolean;
      readonly displayOrder?: number;
      readonly deleted?: boolean;
    } = {},
  ): ExpenseCategory {
    sequence += 1;
    const category: ExpenseCategory = {
      id: asExpenseCategoryId(spec.id ?? randomUUID()),
      societyId: asSocietyId(societyId),
      name: spec.name ?? `Category ${sequence}`,
      icon: spec.icon ?? null,
      color: spec.color ?? null,
      defaultSplitStrategy: spec.defaultSplitStrategy ?? "equal",
      defaultApartmentBasis: spec.defaultApartmentBasis ?? null,
      isOwnerOnly: spec.isOwnerOnly ?? false,
      isCapital: spec.isCapital ?? false,
      gstApplicable: spec.gstApplicable ?? false,
      isActive: spec.isActive ?? true,
      displayOrder: spec.displayOrder ?? 0,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: spec.deleted === true ? NOW : null,
    };
    categories.set(category.id, category);
    return category;
  }

  /** The row a soft-deleted category would be: present in storage, absent from every read. */
  const live = (
    category: ExpenseCategory | undefined,
  ): ExpenseCategory | undefined =>
    category === undefined || category.deletedAt !== null
      ? undefined
      : category;

  /**
   * `uq_expense_categories_society_name`, over live rows of one society, exactly as the
   * index compares them: **case-sensitive** and exact-string, with `exceptId` so an
   * update can keep its own name.
   */
  const assertNameFree = (
    societyId: SocietyId,
    name: string,
    exceptId?: string,
  ): void => {
    const taken = [...categories.values()].some(
      (category) =>
        category.societyId === societyId &&
        category.deletedAt === null &&
        category.id !== exceptId &&
        category.name === name,
    );
    if (taken) {
      throw new ExpenseError(
        "conflict",
        "A category with that name already exists in this society.",
        { field: "name" },
      );
    }
  };

  return {
    state: { categories, references, calls },
    seed,

    async listCategories(societyId, _actor: UserId) {
      calls.push("listCategories");
      return [...categories.values()]
        .filter(
          (category) =>
            category.societyId === societyId && category.deletedAt === null,
        )
        .sort(compareExpenseCategories);
    },

    async findCategory(
      id: ExpenseCategoryId,
      societyId: SocietyId,
      _actor: UserId,
    ): Promise<ExpenseCategory | null> {
      calls.push("findCategory");
      const category = live(categories.get(id));
      if (category === undefined || category.societyId !== societyId) {
        return null;
      }
      return category;
    },

    async findByName(
      name: string,
      societyId: SocietyId,
      _actor: UserId,
      exceptId?: ExpenseCategoryId,
    ): Promise<ExpenseCategory | null> {
      calls.push("findByName");
      return (
        [...categories.values()].find(
          (category) =>
            category.societyId === societyId &&
            category.deletedAt === null &&
            category.id !== exceptId &&
            category.name === name,
        ) ?? null
      );
    },

    async create(
      societyId: SocietyId,
      input: CreateExpenseCategoryInput,
      _actor: UserId,
    ): Promise<ExpenseCategory> {
      calls.push("create");
      assertNameFree(societyId, input.name);
      return seed(societyId, {
        name: input.name,
        icon: input.icon ?? null,
        color: input.color ?? null,
        defaultSplitStrategy: input.defaultSplitStrategy ?? "equal",
        defaultApartmentBasis: input.defaultApartmentBasis ?? null,
        isOwnerOnly: input.isOwnerOnly ?? false,
        isCapital: input.isCapital ?? false,
        gstApplicable: input.gstApplicable ?? false,
        isActive: input.isActive ?? true,
        displayOrder: input.displayOrder ?? 0,
      });
    },

    async update(
      id: ExpenseCategoryId,
      societyId: SocietyId,
      input: UpdateExpenseCategoryInput,
      _actor: UserId,
    ): Promise<ExpenseCategory> {
      calls.push("update");
      const current = live(categories.get(id));
      if (current === undefined || current.societyId !== societyId) {
        throw new ExpenseError(
          "not_found",
          "That category is not available to you.",
        );
      }

      if (input.name !== undefined) {
        assertNameFree(societyId, input.name, id);
      }

      // Field by field: an absent key leaves the stored value untouched, and an explicit
      // `null` clears a nullable column.
      const next: ExpenseCategory = {
        ...current,
        name: input.name ?? current.name,
        icon: input.icon === undefined ? current.icon : input.icon,
        color: input.color === undefined ? current.color : input.color,
        defaultSplitStrategy:
          input.defaultSplitStrategy ?? current.defaultSplitStrategy,
        defaultApartmentBasis:
          input.defaultApartmentBasis === undefined
            ? current.defaultApartmentBasis
            : input.defaultApartmentBasis,
        isOwnerOnly: input.isOwnerOnly ?? current.isOwnerOnly,
        isCapital: input.isCapital ?? current.isCapital,
        gstApplicable: input.gstApplicable ?? current.gstApplicable,
        isActive: input.isActive ?? current.isActive,
        displayOrder: input.displayOrder ?? current.displayOrder,
        updatedAt: NOW,
      };
      categories.set(id, next);
      return next;
    },

    async remove(
      id: ExpenseCategoryId,
      societyId: SocietyId,
      _actor: UserId,
    ): Promise<void> {
      calls.push("remove");
      const current = live(categories.get(id));
      if (current === undefined || current.societyId !== societyId) {
        throw new ExpenseError(
          "not_found",
          "That category is not available to you.",
        );
      }
      categories.set(id, { ...current, deletedAt: NOW });
    },

    async countForCategory(
      categoryId: ExpenseCategoryId,
      _societyId: SocietyId,
      _actor: UserId,
    ): Promise<number> {
      calls.push("countForCategory");
      return references.get(categoryId) ?? 0;
    },
  };
}
