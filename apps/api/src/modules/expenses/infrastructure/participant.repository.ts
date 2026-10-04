import { Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { asMemberId, isExpenseError } from "@ses/domain";
import type {
  ExpenseMemberNameReader,
  ExpenseParticipantReader,
  MemberId,
  SocietyId,
  SocietyParticipantDirectory,
  UserId,
} from "@ses/domain";
import type { ZodType } from "zod";

import {
  UnitOfWork,
  type TransactionActor,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import {
  apartmentFromRow,
  buildingIdFromRow,
  memberFromRow,
  participantApartmentRowListSchema,
  participantBuildingRowListSchema,
  participantErrorFromPostgres,
  participantMemberNameRowListSchema,
  participantMemberRowListSchema,
  participantWingRowListSchema,
  unexpectedShapeError,
  wingFromRow,
} from "./participant.rows";

/**
 * `ExpenseParticipantReader` over Postgres — Roadmap T063's one new read.
 *
 * ## Four queries, one transaction, one snapshot
 *
 * Apartments, members, wings and buildings are read in a **single transaction** run as
 * the acting member, so the directory is one consistent view rather than four
 * statements that could interleave with somebody editing the structure. That matters
 * because resolution's output is billed: a member approved between the members read and
 * the flats read would produce a participant list that never existed at any instant, and
 * the publish path snapshots what resolution returned.
 *
 * Four statements, independent of the society's size — the shape the port's docstring
 * promises. Nothing here loops, and nothing here is addressed per building or per page.
 *
 * ## Every statement is filtered twice, on purpose
 *
 * `society_id = …` and the row filters (`deleted_at is null`, `status = 'active'`) are
 * written out even though RLS already scopes the read: the policy is what *decides*, and
 * the predicate is what makes the intent legible to the next reader — and what keeps the
 * answer correct on the owner connection the integration suite builds its fixtures with.
 *
 * The reader deliberately does **not** filter by the selector: eligibility is
 * `resolveExpenseParticipants`' rule, and a reader that pre-filtered would be a second
 * implementation of it (and would make the "matches no billable flats" refusal
 * unreachable).
 *
 * ## Why there is no `ORDER BY`
 *
 * The resolution sorts, and its order is the domain's (`floor`, then apartment number,
 * then id — `COLLATE "C"` byte-wise). An `ORDER BY apartment_number` here would be a
 * *second* order decided by the server's collation, which for a non-C collation puts
 * `"10"` after `"2"` — the exact disagreement `compareApartments` was written to prevent
 * (`docs/guides/SPLIT_ENGINE.md` §3). Ordering is one decision in one place, and it is
 * not the database's.
 */
@Injectable()
export class ExpenseParticipantRepositoryPostgres
  implements ExpenseParticipantReader, ExpenseMemberNameReader
{
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async listSocietyParticipants(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyParticipantDirectory> {
    return this.run(actor, async (tx) => {
      const apartments = parse(
        participantApartmentRowListSchema,
        await query(
          tx,
          sql`
            select id, building_id, wing_id, apartment_number, floor, bhk,
                   carpet_area_sqft, builtup_area_sqft, parking_slots, share_units,
                   occupancy_status, is_billable
              from public.apartments
             where society_id = ${societyId}::uuid
               and deleted_at is null
          `,
        ),
        "apartment",
      ).map(apartmentFromRow);

      const members = parse(
        participantMemberRowListSchema,
        await query(
          tx,
          sql`
            select id, apartment_id, occupancy, is_primary
              from public.members
             where society_id = ${societyId}::uuid
               and apartment_id is not null
               and status = 'active'
          `,
        ),
        "member",
      ).map(memberFromRow);

      const wings = parse(
        participantWingRowListSchema,
        await query(
          tx,
          sql`
            select id, building_id, name
              from public.wings
             where society_id = ${societyId}::uuid
          `,
        ),
        "wing",
      ).map(wingFromRow);

      const buildings = parse(
        participantBuildingRowListSchema,
        await query(
          tx,
          sql`
            select id
              from public.buildings
             where society_id = ${societyId}::uuid
               and deleted_at is null
          `,
        ),
        "building",
      ).map(buildingIdFromRow);

      return Object.freeze({
        apartments: Object.freeze(apartments),
        members: Object.freeze(members),
        wings: Object.freeze(wings),
        buildings: Object.freeze(buildings),
      });
    });
  }

  /**
   * Member display names for a bounded set of ids — T066's publish snapshot.
   *
   * One query for the whole set (`in (…)`), never one per participant, which is why
   * this lives on the adapter that already reads `members` rather than inside the
   * publish use case: the cost of a snapshot must not scale with the number of flats
   * the way a per-participant read would.
   *
   * The list is written as one cast placeholder per id rather than
   * `= any(${memberIds}::uuid[])`: Drizzle expands a JS-array interpolation into a
   * parenthesised list, and Postgres reads `any(($1, $2, …))` as one anonymous
   * record (`42846 cannot cast type record to uuid[]`). `sql.join` keeps each id a
   * scalar parameter; the list is bounded by the allocation set, so it always is.
   *
   * It reads under the caller's own identity like every other method here, so another
   * society's ids are simply absent — and an empty id list short-circuits before the
   * query, because `= any('{}')` is a round trip that can only answer nothing.
   * A member missing from the answer is left to the caller: `display_name` is
   * `NOT NULL` and non-blank, so a gap is a corrupt read, not a legitimate state.
   */
  async listMemberNames(
    societyId: SocietyId,
    memberIds: readonly MemberId[],
    actor: UserId,
  ): Promise<ReadonlyMap<MemberId, string>> {
    if (memberIds.length === 0) return new Map<MemberId, string>();

    const ids = sql.join(
      memberIds.map((memberId) => sql`${memberId}::uuid`),
      sql`, `,
    );

    return this.run(actor, async (tx) => {
      const rows = parse(
        participantMemberNameRowListSchema,
        await query(
          tx,
          sql`
            select id, display_name
              from public.members
             where society_id = ${societyId}::uuid
               and id in (${ids})
          `,
        ),
        "member name",
      );

      return new Map(
        rows.map((row) => [asMemberId(row.id), row.display_name] as const),
      );
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** Runs `work` as `actor` and classifies any failure into the module's vocabulary. */
  private async run<T>(
    actor: UserId,
    work: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    const identity: TransactionActor = { kind: "user", userId: actor };

    try {
      return await this.unitOfWork.transaction(identity, work);
    } catch (error: unknown) {
      throw isExpenseError(error) ? error : participantErrorFromPostgres(error);
    }
  }
}

type Row = Record<string, unknown>;

/**
 * `execute` resolves to the driver's own row list, whose index signature is wider than
 * anything usable directly — the same narrowing `category.repository.ts` performs, with
 * the same justification: the cast happens once, and every value then goes through a Zod
 * schema, which is what actually makes it trustworthy.
 */
async function query(
  tx: TransactionContext,
  statement: SQL,
): Promise<readonly Row[]> {
  const rows = await tx.execute(statement);
  return rows as unknown as readonly Row[];
}

function parse<T>(schema: ZodType<T>, rows: readonly Row[], what: string): T {
  const parsed = schema.safeParse(rows);
  if (!parsed.success) {
    throw unexpectedShapeError(what);
  }
  return parsed.data;
}
