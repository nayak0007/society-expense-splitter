import { Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { ExpenseError, isExpenseError } from "@ses/domain";
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

import {
  UnitOfWork,
  type TransactionActor,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import {
  categoryErrorFromPostgres,
  categoryFromRow,
  categoryReferenceCountRowSchema,
  categoryRowListSchema,
  categoryRowSchema,
  unexpectedShapeError,
} from "./category.rows";

/**
 * `ExpenseCategoryRepository` over Postgres, under RLS — and, until T063 lands its own
 * adapter, `ExpenseReferenceReader` as well.
 *
 * ## The identity is the transaction, not an argument
 *
 * Every method opens a transaction through `UnitOfWork` with `actor` as the
 * transaction's identity, which sets `app.user_id` and switches to the `authenticated`
 * role for its duration. That is what makes `auth.uid()` inside every committed policy
 * resolve to the caller — and it is why the port's `actor` parameter is used *once*,
 * here, instead of being threaded into each statement as a filter a caller could get
 * wrong. A method that forgot it would fail closed: with no identity set, `auth.uid()`
 * is NULL, every policy evaluates false, and the query returns nothing rather than
 * everything.
 *
 * ## These are plain statements, not RPCs — and that is the stronger choice
 *
 * T060's category writes are not definer functions: the manager check is
 * `expense_categories_insert_manager` / `_update_manager`, real policies a reviewer can
 * read, and the column grants already decide which columns a client may write. Writing
 * through DML therefore keeps the write **inside** RLS rather than beside it.
 *
 * The single exception is `remove`, which goes through
 * `expense_category_soft_delete()` because `deleted_at` is deliberately not a
 * grantable column (and `DELETE` is not granted at all) — so who may remove a category,
 * and the reference check that decides whether it may be removed, live in one auditable
 * function rather than in a column privilege list.
 *
 * ## `society_id` is in every `WHERE`, including the ones keyed by `id`
 *
 * A category id alone does not say which tenant the caller is acting in. Pairing the
 * two is what makes a category belonging to another society *unaddressable* rather than
 * merely unreadable — and because RLS already scopes the read, the pair is belt and
 * braces by design: the policy decides, and the predicate makes the intent legible.
 *
 * ## The reads are `expense_categories` reads, ordered the way the seed orders them
 *
 * `display_order asc, name asc` — the nineteen are seeded 1..19 in PRD §3.5.3's order,
 * so the picker shows them in the order the product document lists them, and a society's
 * own additions sort among them by whatever order it gives them.
 */
@Injectable()
export class ExpenseCategoryRepositoryPostgres
  implements ExpenseCategoryRepository, ExpenseReferenceReader
{
  constructor(private readonly unitOfWork: UnitOfWork) {}

  // ── read ────────────────────────────────────────────────────────────────────

  /** Every live category of `societyId`, active and inactive, in display order. */
  async listCategories(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly ExpenseCategory[]> {
    return this.run(actor, "read", async (tx) => {
      const rows = await query(
        tx,
        sql`
          select ${CATEGORY_COLUMNS}
            from public.expense_categories
           where society_id = ${societyId}::uuid
             and deleted_at is null
           order by display_order asc, name asc
        `,
      );
      return parseRows(rows).map((row) => categoryFromRow(row));
    });
  }

  /** One live category of one society, `null` when the actor may not see it. */
  async findCategory(
    id: ExpenseCategoryId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<ExpenseCategory | null> {
    return this.run(actor, "read", async (tx) => {
      const rows = await query(
        tx,
        sql`
          select ${CATEGORY_COLUMNS}
            from public.expense_categories
           where id = ${id}::uuid
             and society_id = ${societyId}::uuid
             and deleted_at is null
           limit 1
        `,
      );
      const [row] = parseRows(rows);
      return row === undefined ? null : categoryFromRow(row);
    });
  }

  /**
   * The live category carrying exactly `name`, or `null`.
   *
   * The comparison is the index's: same society, live rows only, `name =` — **not**
   * `lower(name) = lower(...)`. Case-insensitivity here would refuse a create the
   * database would have accepted, which is a rule with nothing behind it; see
   * `ExpenseCategoryRepository.findByName` in `@ses/domain` for why the read exists at
   * all when the index is the actual rule.
   *
   * `exceptId` mirrors the index's predicate excluding the row being updated, which is
   * what lets a rename keep its own name.
   */
  async findByName(
    name: string,
    societyId: SocietyId,
    actor: UserId,
    exceptId?: ExpenseCategoryId,
  ): Promise<ExpenseCategory | null> {
    return this.run(actor, "read", async (tx) => {
      const except =
        exceptId === undefined ? sql`` : sql`and id <> ${exceptId}::uuid`;

      const rows = await query(
        tx,
        sql`
          select ${CATEGORY_COLUMNS}
            from public.expense_categories
           where society_id = ${societyId}::uuid
             and name = ${name}::varchar
             and deleted_at is null
             ${except}
           limit 1
        `,
      );
      const [row] = parseRows(rows);
      return row === undefined ? null : categoryFromRow(row);
    });
  }

  /**
   * How many expenses reference one category.
   *
   * `count(*)::int` and not a bare `count(*)`: Postgres's `count` is `bigint`, which
   * `postgres.js` surfaces as a *string* for values past the safe-integer range, and a
   * `::int` cast makes the column's own type answer the question. The row schema
   * coerces either way, so the cast is belt and braces rather than the mechanism.
   *
   * No `deleted_at` filter is possible or wanted: `expenses` has no such column (SAD
   * §8.1's "never deleted, voided instead" tier), and a voided expense still renders
   * its category's name, so it counts as a reference.
   */
  async countForCategory(
    categoryId: ExpenseCategoryId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<number> {
    return this.run(actor, "read", async (tx) => {
      const rows = await query(
        tx,
        sql`
          select count(*)::int as reference_count
            from public.expenses
           where category_id = ${categoryId}::uuid
             and society_id = ${societyId}::uuid
        `,
      );
      const parsed = categoryReferenceCountRowSchema.safeParse(rows[0]);
      if (!parsed.success) {
        throw unexpectedShapeError("expense reference count");
      }
      return parsed.data.reference_count;
    });
  }

  // ── write ───────────────────────────────────────────────────────────────────

  /**
   * Insert one category.
   *
   * The manager requirement is `expense_categories_insert_manager`'s `WITH CHECK`, so a
   * member whose role is not Admin or Treasurer is refused by the database and the
   * refusal arrives as a `42501` the classifier turns into `forbidden` — one rule,
   * enforced where it cannot be bypassed.
   *
   * Every column the caller may write is named explicitly, and the casts are the
   * column's own types: `default_split_strategy` and `default_apartment_basis` are
   * `public.*` enums (an untyped parameter would be inferred as `text` and fail with a
   * `42804` the classifier could only report as `unknown`), and `display_order` is a
   * `smallint`. The columns the caller may *not* write — `society_id` is passed because
   * the tenant is the caller's, but `created_by`, `deleted_at` and `version` are absent
   * because the grant does not include them.
   */
  async create(
    societyId: SocietyId,
    input: CreateExpenseCategoryInput,
    actor: UserId,
  ): Promise<ExpenseCategory> {
    return this.run(actor, "write", async (tx) => {
      const rows = await query(
        tx,
        sql`
          insert into public.expense_categories (
            society_id, name, icon, color, default_split_strategy,
            default_apartment_basis, is_owner_only, is_capital, gst_applicable,
            is_active, display_order
          )
          values (
            ${societyId}::uuid,
            ${input.name}::varchar,
            ${input.icon ?? null}::varchar,
            ${input.color ?? null}::varchar,
            ${input.defaultSplitStrategy ?? "equal"}::public.split_strategy,
            ${input.defaultApartmentBasis ?? null}::public.apartment_basis,
            ${input.isOwnerOnly ?? false}::boolean,
            ${input.isCapital ?? false}::boolean,
            ${input.gstApplicable ?? false}::boolean,
            ${input.isActive ?? true}::boolean,
            ${input.displayOrder ?? 0}::smallint
          )
          returning ${CATEGORY_COLUMNS}
        `,
      );
      return categoryFromRow(parseSingleRow(rows, "created category"));
    });
  }

  /**
   * Patch one category.
   *
   * ## A field-by-field `SET` list rather than `coalesce`, unlike the building adapter
   *
   * And the difference is a rule rather than a style: three of this table's columns are
   * nullable and genuinely *clearable* (`icon`, `color`, `default_apartment_basis`), so
   * a patch has three states per field — absent ("leave unchanged"), `null` ("set to
   * nothing") and a value — and `coalesce($param, column)` can express only two.
   * Building the assignment list is what the flat adapter does for the same reason, so
   * this is the shipped answer to a nullable patch rather than a new one.
   *
   * ## Every assignment is cast to the column's type
   *
   * The casts are load-bearing: an untyped `NULL` parameter in an `UPDATE … SET` is
   * inferred as `text`, and assigning `text` to `smallint` or to a `public.*` enum fails
   * with a `42804` the classifier can only report as `unknown`. Writing the literal
   * `null::varchar` for a clear is what keeps a cleared column a *typed* NULL.
   *
   * The empty-patch guard is the third line of one rule (the contract refines, the use
   * case refuses, this refuses): an `UPDATE` with no `SET` is a syntax error, and
   * reaching this with nothing means a caller bypassed both earlier layers.
   */
  async update(
    id: ExpenseCategoryId,
    societyId: SocietyId,
    input: UpdateExpenseCategoryInput,
    actor: UserId,
  ): Promise<ExpenseCategory> {
    return this.run(actor, "write", async (tx) => {
      const assignments: SQL[] = [];
      const set = (column: string, value: SQL): void => {
        assignments.push(sql`${sql.raw(column)} = ${value}`);
      };

      if (input.name !== undefined) set("name", sql`${input.name}::varchar`);
      if (input.icon !== undefined) {
        set(
          "icon",
          input.icon === null
            ? sql`null::varchar`
            : sql`${input.icon}::varchar`,
        );
      }
      if (input.color !== undefined) {
        set(
          "color",
          input.color === null
            ? sql`null::varchar`
            : sql`${input.color}::varchar`,
        );
      }
      if (input.defaultSplitStrategy !== undefined) {
        set(
          "default_split_strategy",
          sql`${input.defaultSplitStrategy}::public.split_strategy`,
        );
      }
      if (input.defaultApartmentBasis !== undefined) {
        set(
          "default_apartment_basis",
          input.defaultApartmentBasis === null
            ? sql`null::public.apartment_basis`
            : sql`${input.defaultApartmentBasis}::public.apartment_basis`,
        );
      }
      if (input.isOwnerOnly !== undefined) {
        set("is_owner_only", sql`${input.isOwnerOnly}::boolean`);
      }
      if (input.isCapital !== undefined) {
        set("is_capital", sql`${input.isCapital}::boolean`);
      }
      if (input.gstApplicable !== undefined) {
        set("gst_applicable", sql`${input.gstApplicable}::boolean`);
      }
      if (input.isActive !== undefined) {
        set("is_active", sql`${input.isActive}::boolean`);
      }
      if (input.displayOrder !== undefined) {
        set("display_order", sql`${input.displayOrder}::smallint`);
      }

      if (assignments.length === 0) {
        throw new ExpenseError("validation", "Nothing to update.");
      }

      const rows = await query(
        tx,
        sql`
          update public.expense_categories
             set ${sql.join(assignments, sql`, `)}
           where id = ${id}::uuid
             and society_id = ${societyId}::uuid
             and deleted_at is null
          returning ${CATEGORY_COLUMNS}
        `,
      );

      const [row] = parseRows(rows);
      if (row === undefined) {
        // The caller is an active member of this society — `SocietyGuard` ran before
        // the handler — so zero rows means the category is not in it, is already
        // removed, or never existed. All three are one answer, because distinguishing
        // them would let a manager of one society enumerate another's category ids.
        throw new ExpenseError(
          "not_found",
          "That category is not available to you.",
        );
      }
      return categoryFromRow(row);
    });
  }

  /**
   * Soft delete, through the one function that may write `deleted_at`.
   *
   * The function re-checks the Admin/Treasurer role, reports 404 for a non-member
   * before 403 for an insufficient role, and refuses a category an expense still
   * references — so this call site needs no rule of its own, and a stale client that
   * skipped the capability check and the reference count still cannot delete anything.
   */
  async remove(
    id: ExpenseCategoryId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<void> {
    await this.run(actor, "write", async (tx) => {
      await query(
        tx,
        sql`select public.expense_category_soft_delete(${id}::uuid, ${societyId}::uuid)`,
      );
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Runs `work` as `actor` and classifies any failure into the module's error
   * vocabulary.
   *
   * `context` decides how a `42501` is read (see `categoryErrorFromPostgres`), so each
   * method states whether it is a read or a write rather than the classification
   * guessing. An `ExpenseError` thrown inside — the not-found branch above — passes
   * through untouched: it is already the right answer, and re-classifying it would
   * replace a precise `not_found` with a generic `unknown`.
   */
  private async run<T>(
    actor: UserId,
    context: "read" | "write",
    work: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    // One place translates the port's `UserId` into the transaction's identity union,
    // so no call site can build an actor shape of its own — a second spelling of
    // `{ userId }` is how one method ends up running unidentified.
    const identity: TransactionActor = { kind: "user", userId: actor };

    try {
      return await this.unitOfWork.transaction(identity, work);
    } catch (error: unknown) {
      throw isExpenseError(error)
        ? error
        : categoryErrorFromPostgres(error, context);
    }
  }
}

/**
 * One column list, one place.
 *
 * Spelled as `sql.raw` over a frozen constant rather than repeated in four statements:
 * a column added to the table but to only three of the four reads would produce an
 * `ExpenseCategory` whose new field is `undefined` from one path and set from another —
 * the kind of difference that only shows up on one screen. Exactly the readable columns
 * are listed: the audit ids and `version` are not, so they cannot leak into a DTO by
 * accident.
 */
const CATEGORY_COLUMNS = sql.raw(
  [
    "id",
    "society_id",
    "name",
    "icon",
    "color",
    "default_split_strategy",
    "default_apartment_basis",
    "is_owner_only",
    "is_capital",
    "gst_applicable",
    "is_active",
    "display_order",
    "created_at",
    "updated_at",
    "deleted_at",
  ].join(", "),
);

type Row = Record<string, unknown>;

/**
 * `execute` resolves to the driver's own row list, whose index signature is wider than
 * anything usable directly. The narrowing is one cast in one place; every consumer then
 * goes through a Zod schema, which is what actually makes the values trustworthy.
 */
async function query(
  tx: TransactionContext,
  statement: SQL,
): Promise<readonly Row[]> {
  const rows = await tx.execute(statement);
  return rows as unknown as readonly Row[];
}

function parseRows(rows: readonly Row[]) {
  const parsed = categoryRowListSchema.safeParse(rows);
  if (!parsed.success) {
    throw unexpectedShapeError("expense category");
  }
  return parsed.data;
}

/**
 * Exactly the row a single-row `RETURNING` promised, or a shape error.
 *
 * An INSERT refused by a policy *raises* rather than returning zero rows, so reaching
 * this with nothing means the database returned something this layer did not expect —
 * which is the honest thing to say, rather than a `TypeError` deep inside the mapper.
 */
function parseSingleRow(rows: readonly Row[], what: string) {
  const [first] = parseRows(rows);
  if (first === undefined) {
    throw unexpectedShapeError(what);
  }
  const parsed = categoryRowSchema.safeParse(first);
  if (!parsed.success) {
    throw unexpectedShapeError(what);
  }
  return parsed.data;
}
