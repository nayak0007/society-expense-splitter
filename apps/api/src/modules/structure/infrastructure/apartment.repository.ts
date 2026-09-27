import { Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { StructureError, isStructureError } from "@ses/domain";
import type {
  Apartment,
  ApartmentId,
  ApartmentRepository,
  BuildingId,
  CreateApartmentInput,
  SocietyId,
  UpdateApartmentInput,
  UserId,
} from "@ses/domain";
import { z } from "zod";

import {
  UnitOfWork,
  type TransactionActor,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import {
  apartmentErrorFromPostgres,
  apartmentFromRow,
  apartmentRowListSchema,
  apartmentRowSchema,
} from "./apartment.rows";
import { unexpectedShapeError } from "./building.rows";

/**
 * `ApartmentRepository` implemented over Postgres, under RLS.
 *
 * Every property `BuildingRepositoryPostgres` documents holds here and is not
 * repeated: the transaction identity is the port's `actor` (so `auth.uid()`
 * resolves to the caller and a forgotten identity fails closed rather than open),
 * the writes are plain DML inside RLS rather than `SECURITY DEFINER` functions
 * (the admin check is a real policy a reviewer can read), and `society_id` is in
 * every `WHERE` including the ones already keyed by `id`.
 *
 * The one exception is `remove`, which goes through `apartment_soft_delete()`
 * because `deleted_at` is deliberately not a grantable column.
 *
 * ## Two statements here are assembled rather than written out, and why
 *
 * `create` and `update` build their column list from the fields that were actually
 * present. That is not an optimisation — it is the only way the two rules the
 * domain states can be true:
 *
 *  - **create**: `is_commercial` and `is_billable` are *omitted* when the command
 *    did not carry them, so the column default is what applies. A static statement
 *    would have to write `coalesce($1, false)`, which is a second definition of the
 *    default — and the one a repair script would not get.
 *  - **update**: `undefined` means "leave alone" and `null` means "clear". A static
 *    `coalesce($param, column)` cannot express the second at all; it would silently
 *    make every field un-clearable, which is exactly the state `UpdateApartmentInput`
 *    exists to avoid.
 *
 * The cost is that the statement is composed at runtime, and the honesty is worth
 * more than the uniformity: there is no dynamic *identifier* anywhere (every column
 * name is a literal in this file) and every value is a bound parameter, so the
 * composition cannot be influenced by input.
 */
@Injectable()
export class ApartmentRepositoryPostgres implements ApartmentRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  // ── read ────────────────────────────────────────────────────────────────────

  /**
   * Every live flat of `buildingId`, in floor then flat-number order.
   *
   * The order matches `idx_apartments_building` exactly — including
   * `COLLATE "C"` on the number — so the database's index order is the order the
   * client applies optimistically after an edit (`compareApartments`). If the two
   * disagreed, a renumbered flat would jump to a position the server would move it
   * out of a moment later. `nulls last` is explicit because `floor` is nullable:
   * an unlabelled floor has no place in the reading order and must not sort first.
   */
  async listApartments(
    buildingId: BuildingId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly Apartment[]> {
    return this.run(actor, "read", async (tx) => {
      const rows = await query(
        tx,
        sql`
          select ${APARTMENT_COLUMNS}
            from public.apartments
           where building_id = ${buildingId}::uuid
             and society_id = ${societyId}::uuid
             and deleted_at is null
           order by floor asc nulls last, apartment_number collate "C" asc
        `,
      );
      return parseRows(rows).map((row) => apartmentFromRow(row));
    });
  }

  /** One live flat of one society, `null` when the actor may not see it. */
  async findApartment(
    id: ApartmentId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<Apartment | null> {
    return this.run(actor, "read", async (tx) => {
      const rows = await query(
        tx,
        sql`
          select ${APARTMENT_COLUMNS}
            from public.apartments
           where id = ${id}::uuid
             and society_id = ${societyId}::uuid
             and deleted_at is null
           limit 1
        `,
      );
      const [row] = parseRows(rows);
      return row === undefined ? null : apartmentFromRow(row);
    });
  }

  /**
   * How many live flats the building has.
   *
   * `count(*)::int` rather than a `select 1 … limit 1`: the number is what the
   * refusal message uses ("this building still has 12 flats"), and the nullability
   * decision is made here — `count` is never null, so the coercion is exact.
   *
   * Scoped by `society_id` and by the transaction identity like every other read,
   * so a caller can only ever count flats they may see.
   */
  async countForBuilding(
    buildingId: BuildingId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<number> {
    return this.run(actor, "read", async (tx) => {
      const rows = await query(
        tx,
        sql`
          select count(*)::int as count
            from public.apartments
           where building_id = ${buildingId}::uuid
             and society_id = ${societyId}::uuid
             and deleted_at is null
        `,
      );
      const parsed = countRowSchema.safeParse(rows[0]);
      if (!parsed.success) {
        throw unexpectedShapeError("apartment count");
      }
      return parsed.data.count;
    });
  }

  // ── write ───────────────────────────────────────────────────────────────────

  /**
   * Insert one flat.
   *
   * The admin requirement is `apartments_insert_admin`'s `WITH CHECK`, so a member
   * without the role is refused by the database and the refusal arrives as a
   * `42501` the classifier turns into `forbidden` — one rule, enforced where it
   * cannot be bypassed.
   */
  async create(
    buildingId: BuildingId,
    societyId: SocietyId,
    input: CreateApartmentInput,
    actor: UserId,
  ): Promise<Apartment> {
    return this.run(actor, "write", async (tx) => {
      const { columns, values } = insertParts(input, societyId, buildingId);

      const rows = await query(
        tx,
        sql`
          insert into public.apartments (${sql.join(columns, sql`, `)})
          values (${sql.join(values, sql`, `)})
          returning ${APARTMENT_COLUMNS}
        `,
      );
      return apartmentFromRow(parseSingleRow(rows, "created flat"));
    });
  }

  /**
   * Patch one flat.
   *
   * Only the fields the caller sent become assignments; a field sent as `null`
   * assigns `null` (the cast keeps Postgres from inferring a type from the bind
   * parameter and failing with a `42804`), and a field that is absent is simply not
   * in the statement. `updated_at` is **not** assigned here: the
   * `touch_updated_at()` trigger maintains it, and a second writer of that column
   * would be a second definition of what "updated" means.
   */
  async update(
    id: ApartmentId,
    societyId: SocietyId,
    input: UpdateApartmentInput,
    actor: UserId,
  ): Promise<Apartment> {
    return this.run(actor, "write", async (tx) => {
      const assignments: SQL[] = [];

      const set = (column: string, value: SQL): void => {
        assignments.push(sql`${sql.raw(column)} = ${value}`);
      };

      if (input.apartmentNumber !== undefined) {
        set("apartment_number", sql`${input.apartmentNumber}::varchar`);
      }
      if (input.wingId !== undefined) {
        set(
          "wing_id",
          input.wingId === null ? sql`null::uuid` : sql`${input.wingId}::uuid`,
        );
      }
      if (input.floor !== undefined) {
        set(
          "floor",
          input.floor === null
            ? sql`null::smallint`
            : sql`${input.floor}::smallint`,
        );
      }
      if (input.bhk !== undefined) {
        set(
          "bhk",
          input.bhk === null
            ? sql`null::numeric(3,1)`
            : sql`${input.bhk}::numeric(3,1)`,
        );
      }
      if (input.carpetAreaSqft !== undefined) {
        set(
          "carpet_area_sqft",
          input.carpetAreaSqft === null
            ? sql`null::numeric(8,2)`
            : sql`${input.carpetAreaSqft}::numeric(8,2)`,
        );
      }
      if (input.builtupAreaSqft !== undefined) {
        set(
          "builtup_area_sqft",
          input.builtupAreaSqft === null
            ? sql`null::numeric(8,2)`
            : sql`${input.builtupAreaSqft}::numeric(8,2)`,
        );
      }
      if (input.parkingSlots !== undefined) {
        set("parking_slots", sql`${input.parkingSlots}::smallint`);
      }
      if (input.shareUnits !== undefined) {
        set("share_units", sql`${input.shareUnits}::numeric(8,3)`);
      }
      if (input.occupancyStatus !== undefined) {
        set(
          "occupancy_status",
          sql`${input.occupancyStatus}::public.occupancy_status`,
        );
      }
      if (input.isCommercial !== undefined) {
        set("is_commercial", sql`${input.isCommercial}::boolean`);
      }
      if (input.isBillable !== undefined) {
        set("is_billable", sql`${input.isBillable}::boolean`);
      }

      // The use case rejects an empty patch, and so does the contract at the edge.
      // Reaching here with nothing would mean an `UPDATE` with an empty `SET`,
      // which is not valid SQL — so it is reported as the caller mistake it is
      // rather than surfacing as a syntax error the classifier calls `unknown`.
      if (assignments.length === 0) {
        throw new StructureError("validation", "Nothing to update.", {
          field: "apartmentNumber",
        });
      }

      const rows = await query(
        tx,
        sql`
          update public.apartments
             set ${sql.join(assignments, sql`, `)}
           where id = ${id}::uuid
             and society_id = ${societyId}::uuid
             and deleted_at is null
          returning ${APARTMENT_COLUMNS}
        `,
      );

      const [row] = parseRows(rows);
      if (row === undefined) {
        // The caller is an active member of this society — `SocietyGuard` ran
        // before the handler — so zero rows means the flat is not in it, is
        // already removed, or never existed. All three are one answer, because
        // distinguishing them would let an Admin of one society enumerate
        // another's flats.
        throw new StructureError(
          "not_found",
          "That flat is not available to you.",
        );
      }
      return apartmentFromRow(row);
    });
  }

  /**
   * Soft delete, through the one function that may write `deleted_at`.
   *
   * The function re-checks the Admin role and reports 404 for a non-member before
   * 403 for an insufficient role, so this call site needs no rule of its own — and
   * a stale client that skipped the capability check still cannot delete anything.
   *
   * Unlike `building_soft_delete`, this one has no children to refuse: nothing
   * references a flat yet. When `members.apartment_id` and dues land (T045+), the
   * equivalent guard belongs in that function — a rule the use cases check is a
   * rule a repair script does not have.
   */
  async remove(
    id: ApartmentId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<void> {
    await this.run(actor, "write", async (tx) => {
      await query(
        tx,
        sql`select public.apartment_soft_delete(${id}::uuid, ${societyId}::uuid)`,
      );
    });
  }

  /**
   * Creates many flats in **one transaction**, skipping the labels the building's
   * live flats already carry (Roadmap T043's bulk create; T044's commit path).
   *
   * ## One transaction, row by row — and why that is not a contradiction
   *
   * Each row's column set is its own (one row may carry areas, the next only a
   * number), so a single multi-row `INSERT` would have to force every row to name
   * every column and would move the column defaults from the database into this
   * file. Instead each row gets exactly the statement `create` would have run,
   * inside the **one** transaction `run` opens — so the whole batch is still
   * atomic: any failure the caller does not absorb rolls back every row, which is
   * the property T043's "transactional" names.
   *
   * ## Duplicates are skipped and reported, not fatal
   *
   * `uq_apartments_building_number` decides a clash — there is no read-then-write
   * check here to race with. A `23505` naming that index (or the apartment_number
   * column) is caught per row and collected into `duplicateLabelsSkipped`; every
   * other failure propagates and takes the whole batch with it. The use cases turn
   * the skipped labels into report rows, so a concurrent creator between the
   * caller's read and this write lands in the same report instead of failing the
   * request.
   */
  async createMany(
    buildingId: BuildingId,
    societyId: SocietyId,
    inputs: readonly CreateApartmentInput[],
    actor: UserId,
  ): Promise<{
    readonly created: readonly Apartment[];
    readonly duplicateLabelsSkipped: readonly string[];
  }> {
    return this.run(actor, "write", async (tx) => {
      const created: Apartment[] = [];
      const duplicateLabelsSkipped: string[] = [];

      for (const input of inputs) {
        const { columns, values } = insertParts(input, societyId, buildingId);
        try {
          const rows = await query(
            tx,
            sql`
              insert into public.apartments (${sql.join(columns, sql`, `)})
              values (${sql.join(values, sql`, `)})
              returning ${APARTMENT_COLUMNS}
            `,
          );
          created.push(apartmentFromRow(parseSingleRow(rows, "created flat")));
        } catch (error: unknown) {
          // A unique violation naming this table's number index is the *rule*,
          // not a failure: the row is skipped and reported. At this point the
          // error is still the driver's raw one — `run`'s classifier sits outside
          // the transaction body — so the row is classified with the same function
          // `run` would use, and the same predicate decides. Anything else
          // re-throws *raw* and takes the batch (the transaction) with it.
          if (isDuplicateApartmentNumber(error)) {
            duplicateLabelsSkipped.push(input.apartmentNumber);
            continue;
          }
          throw error;
        }
      }

      return { created, duplicateLabelsSkipped };
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** Runs `work` as `actor` and classifies any failure into the module's vocabulary. */
  private async run<T>(
    actor: UserId,
    context: "read" | "write",
    work: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    const identity: TransactionActor = { kind: "user", userId: actor };

    try {
      return await this.unitOfWork.transaction(identity, work);
    } catch (error: unknown) {
      // A `StructureError` thrown inside — the not-found and empty-patch branches —
      // passes through untouched: re-classifying it would replace a precise answer
      // with a generic `unknown`.
      throw isStructureError(error)
        ? error
        : apartmentErrorFromPostgres(error, context);
    }
  }
}

/**
 * One column list, one place.
 *
 * Spelled as `sql.raw` over a frozen constant rather than repeated across the four
 * statements: a column added to the table but to only three of them would produce
 * an `Apartment` whose new field is `undefined` from one path and set from
 * another — the kind of difference that only shows up on one screen.
 */
const APARTMENT_COLUMNS = sql.raw(
  [
    "id",
    "society_id",
    "building_id",
    "wing_id",
    "apartment_number",
    "floor",
    "bhk",
    "carpet_area_sqft",
    "builtup_area_sqft",
    "parking_slots",
    "share_units",
    "occupancy_status",
    "is_commercial",
    "is_billable",
    "created_at",
    "updated_at",
    "deleted_at",
  ].join(", "),
);

/**
 * The tenant columns plus the fields the caller actually sent — the one column
 * assembly `create` and `createMany` share, so a batch row and a single row can
 * never disagree about what an absent field means (omit → the column default
 * applies; explicit `null` → written as `null`, both spelled with the cast that
 * keeps Postgres from inferring a type from the bind parameter).
 *
 * Column names are literals in this function and values are bound parameters, so
 * the composition cannot be influenced by input.
 */
function insertParts(
  input: CreateApartmentInput,
  societyId: SocietyId,
  buildingId: BuildingId,
): { readonly columns: SQL[]; readonly values: SQL[] } {
  const columns: SQL[] = [sql`society_id`, sql`building_id`];
  const values: SQL[] = [sql`${societyId}::uuid`, sql`${buildingId}::uuid`];

  const add = (column: string, value: SQL): void => {
    columns.push(sql.raw(column));
    values.push(value);
  };

  add("apartment_number", sql`${input.apartmentNumber}::varchar`);
  // Present-but-null is a real value (\"this building has no wings\"), and it is
  // spelled `null::uuid` rather than omitted so that a caller clearing a wing
  // and a caller not mentioning one are distinguishable in the statement.
  if (input.wingId !== undefined) {
    add(
      "wing_id",
      input.wingId === null ? sql`null::uuid` : sql`${input.wingId}::uuid`,
    );
  }
  if (input.floor !== undefined) {
    add(
      "floor",
      input.floor === null
        ? sql`null::smallint`
        : sql`${input.floor}::smallint`,
    );
  }
  if (input.bhk !== undefined) {
    add(
      "bhk",
      input.bhk === null
        ? sql`null::numeric(3,1)`
        : sql`${input.bhk}::numeric(3,1)`,
    );
  }
  if (input.carpetAreaSqft !== undefined) {
    add(
      "carpet_area_sqft",
      input.carpetAreaSqft === null
        ? sql`null::numeric(8,2)`
        : sql`${input.carpetAreaSqft}::numeric(8,2)`,
    );
  }
  if (input.builtupAreaSqft !== undefined) {
    add(
      "builtup_area_sqft",
      input.builtupAreaSqft === null
        ? sql`null::numeric(8,2)`
        : sql`${input.builtupAreaSqft}::numeric(8,2)`,
    );
  }
  if (input.parkingSlots !== undefined) {
    add("parking_slots", sql`${input.parkingSlots}::smallint`);
  }
  if (input.shareUnits !== undefined) {
    add("share_units", sql`${input.shareUnits}::numeric(8,3)`);
  }
  if (input.occupancyStatus !== undefined) {
    add(
      "occupancy_status",
      sql`${input.occupancyStatus}::public.occupancy_status`,
    );
  }
  if (input.isCommercial !== undefined) {
    add("is_commercial", sql`${input.isCommercial}::boolean`);
  }
  if (input.isBillable !== undefined) {
    add("is_billable", sql`${input.isBillable}::boolean`);
  }

  return { columns, values };
}

/**
 * Whether a raw database failure is `uq_apartments_building_number` deciding a
 * duplicate — the one refusal `createMany` absorbs; everything else is an error.
 *
 * The raw error is classified with `apartmentErrorFromPostgres` — the function
 * `run` would use — rather than matched against SQLSTATE strings here: the
 * constraint name lives in whichever property the driver chose to fill, and a
 * second, narrower matcher would drift from the classification the rest of the
 * module promises. The classified result is a `conflict` naming
 * `apartmentNumber` exactly when that index refused the row.
 */
function isDuplicateApartmentNumber(error: unknown): boolean {
  const classified = apartmentErrorFromPostgres(error, "write");
  if (classified.code !== "conflict") {
    return false;
  }
  const haystack =
    JSON.stringify(classified.details ?? {}) + " " + classified.message;
  return /apartment_number|uq_apartments/i.test(haystack);
}

/** `count(*)` is always an integer, so the coercion is exact rather than lenient. */
const countRowSchema = z.object({ count: z.coerce.number().int() });

type Row = Record<string, unknown>;

/**
 * `execute` resolves to the driver's own row list, whose index signature is wider
 * than anything usable directly. The narrowing is one cast in one place; every
 * consumer then goes through a Zod schema, which is what actually makes the values
 * trustworthy.
 */
async function query(
  tx: TransactionContext,
  statement: SQL,
): Promise<readonly Row[]> {
  const rows = await tx.execute(statement);
  return rows as unknown as readonly Row[];
}

function parseRows(rows: readonly Row[]) {
  const parsed = apartmentRowListSchema.safeParse(rows);
  if (!parsed.success) {
    throw unexpectedShapeError("apartment");
  }
  return parsed.data;
}

/**
 * Exactly the row a single-row `RETURNING` promised, or a shape error.
 *
 * An INSERT refused by a policy *raises* rather than returning zero rows, so
 * reaching this with nothing means the database returned something this layer did
 * not expect — which is the honest thing to say, rather than a `TypeError` deep
 * inside the mapper.
 */
function parseSingleRow(rows: readonly Row[], what: string) {
  const [first] = parseRows(rows);
  if (first === undefined) {
    throw unexpectedShapeError(what);
  }
  const parsed = apartmentRowSchema.safeParse(first);
  if (!parsed.success) {
    throw unexpectedShapeError(what);
  }
  return parsed.data;
}
