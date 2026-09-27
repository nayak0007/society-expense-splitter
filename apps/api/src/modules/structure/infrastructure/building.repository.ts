import { Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { StructureError, isStructureError } from "@ses/domain";
import type {
  Building,
  BuildingId,
  BuildingRepository,
  CreateBuildingInput,
  SocietyId,
  UpdateBuildingInput,
  UserId,
} from "@ses/domain";

import {
  UnitOfWork,
  type TransactionActor,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import {
  buildingFromRow,
  buildingRowListSchema,
  buildingRowSchema,
  structureErrorFromPostgres,
  unexpectedShapeError,
} from "./building.rows";

/**
 * `BuildingRepository` implemented over Postgres, under RLS.
 *
 * ## The identity is the transaction, not an argument
 *
 * Every method opens a transaction through `UnitOfWork` with `actor` as the
 * transaction's identity, which sets `app.user_id` and switches to the
 * `authenticated` role for its duration. That is what makes `auth.uid()` inside
 * every committed policy resolve to the caller — and it is why the port's `actor`
 * parameter is used *once*, here, instead of being threaded into each statement as
 * a filter a caller could get wrong. A method that forgot it would fail closed:
 * with no identity set, `auth.uid()` is NULL, every policy evaluates false, and
 * the query returns nothing rather than everything.
 *
 * ## These are plain statements, not RPCs — and that is the stronger choice
 *
 * The society module's writes are all `SECURITY DEFINER` functions because each
 * owns a derived value or a multi-table invariant. A building has neither, so
 * writing through DML keeps the write **inside** RLS rather than beside it: the
 * admin check is `buildings_insert_admin` / `buildings_update_admin`, real
 * policies a reviewer can read, instead of a `PERFORM assert_society_admin()` the
 * reader has to trust. `supabase/migrations/20260924130000_structure_buildings.sql`
 * records this reasoning in full.
 *
 * The single exception is `remove`, which goes through `building_soft_delete()`
 * because `deleted_at` is deliberately not a grantable column — so who may remove
 * a building lives in one auditable function rather than in the column privilege
 * list.
 *
 * ## `society_id` is in every `WHERE`, including the ones keyed by `id`
 *
 * A building id alone does not say which tenant the caller is acting in. Pairing
 * the two is what makes a building belonging to another society *unaddressable*
 * rather than merely unreadable — and because RLS already scopes the read, the
 * pair is belt and braces by design: the policy decides, and the predicate makes
 * the intent legible.
 */
@Injectable()
export class BuildingRepositoryPostgres implements BuildingRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  // ── read ────────────────────────────────────────────────────────────────────

  /** Every live building of `societyId`, in display order. */
  async listBuildings(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly Building[]> {
    return this.run(actor, "read", async (tx) => {
      const rows = await query(
        tx,
        sql`
          select ${BUILDING_COLUMNS}
            from public.buildings
           where society_id = ${societyId}::uuid
             and deleted_at is null
           order by display_order asc, name asc
        `,
      );
      return parseRows(rows).map((row) => buildingFromRow(row));
    });
  }

  /** One live building of one society, `null` when the actor may not see it. */
  async findBuilding(
    id: BuildingId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<Building | null> {
    return this.run(actor, "read", async (tx) => {
      const rows = await query(
        tx,
        sql`
          select ${BUILDING_COLUMNS}
            from public.buildings
           where id = ${id}::uuid
             and society_id = ${societyId}::uuid
             and deleted_at is null
           limit 1
        `,
      );
      const [row] = parseRows(rows);
      return row === undefined ? null : buildingFromRow(row);
    });
  }

  // ── write ───────────────────────────────────────────────────────────────────

  /**
   * Insert one building.
   *
   * The admin requirement is `buildings_insert_admin`'s `WITH CHECK`, so a member
   * without the role is refused by the database and the refusal arrives as a
   * `42501` the classifier turns into `forbidden` — one rule, enforced where it
   * cannot be bypassed.
   */
  async create(
    societyId: SocietyId,
    input: CreateBuildingInput,
    actor: UserId,
  ): Promise<Building> {
    return this.run(actor, "write", async (tx) => {
      const rows = await query(
        tx,
        sql`
          insert into public.buildings (society_id, name, total_floors, display_order)
          values (
            ${societyId}::uuid,
            ${input.name},
            ${input.totalFloors ?? null},
            ${input.displayOrder ?? 0}
          )
          returning ${BUILDING_COLUMNS}
        `,
      );
      return buildingFromRow(parseSingleRow(rows, "created building"));
    });
  }

  /**
   * Patch one building.
   *
   * `coalesce($param, column)` rather than assembling a dynamic `SET` list: the
   * three updatable columns are all "absent means unchanged", and none of them can
   * be *cleared* (there is no way to spell it in `UpdateBuildingInput`, and
   * `total_floors` being nullable does not create one) — so a single static
   * statement expresses the whole rule and cannot be made to drop a column by a
   * patch that happens to omit it.
   *
   * The explicit casts are load-bearing for the same reason: an untyped `NULL`
   * parameter leaves Postgres to infer a type from `coalesce`, and a `smallint`
   * column receiving an inferred `integer` fails with a `42804` the classifier can
   * only report as `unknown`.
   */
  async update(
    id: BuildingId,
    societyId: SocietyId,
    input: UpdateBuildingInput,
    actor: UserId,
  ): Promise<Building> {
    return this.run(actor, "write", async (tx) => {
      const rows = await query(
        tx,
        sql`
          update public.buildings
             set name = coalesce(${input.name ?? null}::varchar, name),
                 total_floors = coalesce(${input.totalFloors ?? null}::smallint, total_floors),
                 display_order = coalesce(${input.displayOrder ?? null}::smallint, display_order)
           where id = ${id}::uuid
             and society_id = ${societyId}::uuid
             and deleted_at is null
          returning ${BUILDING_COLUMNS}
        `,
      );

      const [row] = parseRows(rows);
      if (row === undefined) {
        // The caller is an active member of this society — `SocietyGuard` ran
        // before the handler — so zero rows means the building is not in it, is
        // already removed, or never existed. All three are one answer, because
        // distinguishing them would let an Admin of one society enumerate
        // another's building ids.
        throw new StructureError(
          "not_found",
          "That building is not available to you.",
        );
      }
      return buildingFromRow(row);
    });
  }

  /**
   * Soft delete, through the one function that may write `deleted_at`.
   *
   * The function re-checks the Admin role and reports 404 for a non-member before
   * 403 for an insufficient role, so this call site needs no rule of its own —
   * and a stale client that skipped the capability check still cannot delete
   * anything.
   */
  async remove(
    id: BuildingId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<void> {
    await this.run(actor, "write", async (tx) => {
      await query(
        tx,
        sql`select public.building_soft_delete(${id}::uuid, ${societyId}::uuid)`,
      );
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Runs `work` as `actor` and classifies any failure into the module's error
   * vocabulary.
   *
   * `context` decides how a `42501` is read (see `structureErrorFromPostgres`), so
   * each method states whether it is a read or a write rather than the
   * classification guessing. A `StructureError` thrown inside — the not-found
   * branch above — passes through untouched: it is already the right answer, and
   * re-classifying it would replace a precise `not_found` with a generic `unknown`.
   */
  private async run<T>(
    actor: UserId,
    context: "read" | "write",
    work: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    // One place translates the port's `UserId` into the transaction's identity
    // union, so no call site can build an actor shape of its own — a second
    // spelling of `{ userId }` is how one method ends up running unidentified.
    const identity: TransactionActor = { kind: "user", userId: actor };

    try {
      return await this.unitOfWork.transaction(identity, work);
    } catch (error: unknown) {
      throw isStructureError(error)
        ? error
        : structureErrorFromPostgres(error, context);
    }
  }
}

/**
 * One column list, one place.
 *
 * Spelled as `sql.raw` over a frozen constant rather than repeated in four
 * statements: a column added to the table but to only three of the four reads
 * would produce a `Building` whose new field is `undefined` from one path and set
 * from another — the kind of difference that only shows up on one screen.
 */
const BUILDING_COLUMNS = sql.raw(
  [
    "id",
    "society_id",
    "name",
    "total_floors",
    "display_order",
    "created_at",
    "updated_at",
    "deleted_at",
  ].join(", "),
);

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
  const parsed = buildingRowListSchema.safeParse(rows);
  if (!parsed.success) {
    throw unexpectedShapeError("building");
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
  const parsed = buildingRowSchema.safeParse(first);
  if (!parsed.success) {
    throw unexpectedShapeError(what);
  }
  return parsed.data;
}
