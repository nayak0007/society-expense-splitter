import { Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import {
  SocietyError,
  asSocietyId,
  isSocietyError,
  normalizeJoinCode,
} from "@ses/domain";
import type {
  CreateSocietyInput,
  JoinSocietyInput,
  Society,
  SocietyId,
  SocietyJoinPreview,
  SocietyMembership,
  SocietyRepository,
  UpdateSocietyInput,
  UserId,
} from "@ses/domain";

import {
  UnitOfWork,
  type TransactionActor,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import {
  createPayload,
  isJoinCodeCollision,
  joinPreviewFromPayload,
  joinPreviewSchema,
  memberRowListSchema,
  membershipFromRow,
  occupancyToRow,
  societyErrorFromPostgres,
  societyFromSnapshot,
  societySnapshotSchema,
  unexpectedShapeError,
  updatePayload,
} from "./society.rows";
import type { MemberRow, SocietySnapshot } from "./society.rows";

/**
 * `SocietyRepository` implemented over Postgres, under RLS.
 *
 * ## The identity is the transaction, not an argument
 *
 * Every method opens a transaction through `UnitOfWork` with `actor` as the
 * transaction's identity, which sets `app.user_id` and switches to the
 * `authenticated` role for its duration. That is what makes `auth.uid()` inside
 * every committed policy resolve to the caller — and it is why the port's
 * `actor` parameter is used *once*, here, instead of being threaded into every
 * statement as a filter a caller could get wrong. A method that forgot it would
 * fail closed: with no identity set, `auth.uid()` is NULL and each policy
 * evaluates false, so the query returns nothing rather than everything.
 *
 * ## The write paths are the SQL functions, not INSERT statements
 *
 * `society_create`, `society_update`, `society_soft_delete` and
 * `society_rotate_join_code` already own the rules that must not be
 * reimplemented: slug and join-code minting, seeding `society_settings` and the
 * creator's Admin membership in one transaction, the 404-before-403 rule, and
 * marking every membership removed on delete. Calling them keeps **one**
 * implementation of those invariants, shared with the mobile client, instead of
 * a second one in Drizzle that would drift the first time either side changed.
 *
 * `create` is `SECURITY INVOKER` on purpose, so the INSERT is still filtered by
 * `societies_insert_creator` — RLS, not the function, is what stops a caller
 * creating a society owned by someone else.
 *
 * ## Where this does write tables directly
 *
 * Membership reads and the join/leave writes, which the RPC surface does not
 * cover. RLS governs them: `GRANT INSERT (society_id, user_id, occupancy)` means
 * a caller cannot set `role` or `status` on join even by tampering, and
 * `fill_member_identity()` fills the display name from the caller's own profile
 * rather than from anything sent here.
 */
@Injectable()
export class SocietyRepositoryPostgres implements SocietyRepository {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  // ── read ────────────────────────────────────────────────────────────────────

  /** The caller's memberships, newest first — drives the switcher. */
  async listMemberships(actor: UserId): Promise<readonly SocietyMembership[]> {
    return this.run(actor, "read", async (tx) => {
      const rows = await query(
        tx,
        sql`
          select id, society_id, user_id, role, status, occupancy, joined_at
            from public.members
           where user_id = ${actor}::uuid
             and status <> 'removed'
           order by created_at desc
        `,
      );
      return parseMemberRows(rows).map((row) => membershipFromRow(row));
    });
  }

  /**
   * Every membership of one society, as the caller may see it.
   *
   * The membership check comes out of the read for free: an active member is
   * shown the whole roster and a pending member is always shown at least their
   * own row, so a roster without the caller in it means they are not a member.
   * That case must look like a non-existent society, not an empty list — an
   * empty list would confirm the society exists (PRD T041).
   */
  async listSocietyMemberships(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly SocietyMembership[]> {
    return this.run(actor, "read", async (tx) => {
      const rows = await query(
        tx,
        sql`
          select id, society_id, user_id, role, status, occupancy, joined_at
            from public.members
           where society_id = ${societyId}::uuid
           order by created_at asc
        `,
      );

      const memberships = parseMemberRows(rows);
      const mine = memberships.find((row) => row.user_id === actor);
      if (mine === undefined || mine.status === "removed") {
        throw new SocietyError(
          "not_found",
          "That society is not available to you.",
        );
      }

      // Shadow members (no account yet) have no `UserId`, so the domain cannot
      // represent them; the members module (T045) is where they get one.
      return memberships
        .filter((row) => row.user_id !== null)
        .map((row) => membershipFromRow(row));
    });
  }

  /** One society, whole, for a member of it — `null` for anyone else. */
  async findById(id: SocietyId, actor: UserId): Promise<Society | null> {
    return this.run(actor, "read", async (tx) => {
      const snapshot = await this.snapshot(tx, id);
      // `null` is the function's way of saying "no live membership for you",
      // which the port requires to be indistinguishable from "no such society".
      return snapshot === null ? null : societyFromSnapshot(snapshot);
    });
  }

  /** Public preview for a join code. No membership required. */
  async findJoinPreview(rawCode: string): Promise<SocietyJoinPreview | null> {
    const code = normalizeJoinCode(rawCode);
    if (code.length === 0) {
      return null;
    }
    // Anonymous, not null: the endpoint is public, so the transaction gets the
    // `authenticated` role's grants *without* an identity. Every policy then
    // evaluates false and only this identity-free function is reachable —
    // `TransactionActor` in `unit-of-work.ts` explains the trade.
    return this.run("anonymous", "read", async (tx) => {
      const rows = await query(
        tx,
        sql`select public.society_join_preview(${code}) as preview`,
      );
      const payload = firstValue(rows, "preview");
      if (payload === null || payload === undefined) {
        return null;
      }

      const parsed = joinPreviewSchema.safeParse(payload);
      if (!parsed.success) {
        throw unexpectedShapeError("join preview");
      }
      return joinPreviewFromPayload(parsed.data);
    });
  }

  // ── write ───────────────────────────────────────────────────────────────────

  /**
   * Create a society, its settings and the creator's Admin membership — one
   * transaction, one call. The slug, the join code and the membership are all
   * derived server-side; only what the user chose is sent.
   */
  async create(
    input: CreateSocietyInput,
    actor: UserId,
  ): Promise<{
    readonly society: Society;
    readonly membership: SocietyMembership;
  }> {
    return this.run(actor, "write", async (tx) => {
      const payload = createPayload(input);
      const statement = sql`
        select public.society_create(${JSON.stringify(payload)}::jsonb) as snapshot
      `;

      let rows: readonly Row[];
      try {
        rows = await query(tx, statement);
      } catch (error: unknown) {
        // The code is minted by the database, so a collision is a race rather
        // than a bug: another society took the code between the uniqueness check
        // and the insert. One retry mints a different one (PRD T040).
        if (!isJoinCodeCollision(error)) {
          throw error;
        }
        rows = await query(tx, statement);
      }

      const snapshot = parseSnapshot(
        firstValue(rows, "snapshot"),
        "created society",
      );
      if (
        snapshot.membership === null ||
        snapshot.membership.user_id === null
      ) {
        // `seed_society()` guarantees this row. If it is missing, the database
        // is in a state this layer cannot fix, and reporting success would lie.
        throw new SocietyError(
          "unknown",
          "Something went wrong. Please try again.",
          {
            hint: "society_create() returned a snapshot without the creator membership.",
          },
        );
      }

      return {
        society: societyFromSnapshot(snapshot),
        membership: membershipFromRow(snapshot.membership),
      };
    });
  }

  /** Patch the society and/or its settings atomically. Admin-only, in SQL. */
  async update(
    id: SocietyId,
    input: UpdateSocietyInput,
    actor: UserId,
  ): Promise<Society> {
    return this.run(actor, "write", async (tx) => {
      const patch = updatePayload(input);
      const rows = await query(
        tx,
        sql`
          select public.society_update(
            ${id}::uuid, ${JSON.stringify(patch)}::jsonb
          ) as snapshot
        `,
      );
      return societyFromSnapshot(
        parseSnapshot(firstValue(rows, "snapshot"), "updated society"),
      );
    });
  }

  /** Admin-only join-code rotation. The new code is minted server-side. */
  async regenerateJoinCode(id: SocietyId, actor: UserId): Promise<Society> {
    return this.run(actor, "write", async (tx) => {
      const rows = await query(
        tx,
        sql`
          select public.society_rotate_join_code(${id}::uuid) as snapshot
        `,
      );
      return societyFromSnapshot(
        parseSnapshot(firstValue(rows, "snapshot"), "rotated society"),
      );
    });
  }

  /**
   * Soft delete: the society row stays, so financial history keeps its owner
   * (PRD §3.1), while `deleted_at` takes it out of every read path and the join
   * code stops resolving. Admin-only, checked inside the function.
   */
  async remove(id: SocietyId, actor: UserId): Promise<void> {
    await this.run(actor, "write", async (tx) => {
      await query(tx, sql`select public.society_soft_delete(${id}::uuid)`);
    });
  }

  /**
   * Ask to join with a code (never auto-approved — PRD §3.2).
   *
   * One transaction for all three steps. The write is pinned to
   * `user_id = actor` and to the `pending`/`resident` defaults *by the column
   * grant*, so a tampered caller cannot approve itself; a race is answered by
   * `members_society_user_key`, which the error classifier reports as
   * `already_member`.
   */
  async join(
    input: JoinSocietyInput,
    actor: UserId,
  ): Promise<SocietyMembership> {
    return this.run(actor, "write", async (tx) => {
      const previewRows = await query(
        tx,
        sql`select public.society_join_preview(${input.code}) as preview`,
      );
      const preview = firstValue(previewRows, "preview");
      if (preview === null || preview === undefined) {
        // One message for "no such code" and "code belongs to a deleted
        // society": a probe must not be able to enumerate societies.
        throw new SocietyError(
          "join_code_invalid",
          "That join code does not match any society.",
        );
      }

      const parsedPreview = joinPreviewSchema.safeParse(preview);
      if (!parsedPreview.success) {
        throw unexpectedShapeError("join preview");
      }
      const societyId = asSocietyId(parsedPreview.data.id);

      const existingRows = await query(
        tx,
        sql`
          select id, society_id, user_id, role, status, occupancy, joined_at
            from public.members
           where society_id = ${societyId}::uuid
             and user_id = ${actor}::uuid
        `,
      );
      const [existing] = parseMemberRows(existingRows);

      if (existing !== undefined) {
        if (existing.status !== "removed") {
          throw new SocietyError(
            "already_member",
            "You are already a member of this society.",
          );
        }
        // Re-joining after leaving: the row is history and is re-asked, never
        // re-created. The self-change trigger allows exactly this transition.
        const reasked = await query(
          tx,
          sql`
            update public.members
               set status = 'pending',
                   occupancy = ${occupancyToRow(input.occupancyType)},
                   removed_at = null
             where id = ${existing.id}::uuid
            returning id, society_id, user_id, role, status, occupancy, joined_at
          `,
        );
        return membershipFromRow(parseMemberRowList(reasked));
      }

      const inserted = await query(
        tx,
        sql`
          insert into public.members (society_id, user_id, occupancy)
          values (
            ${societyId}::uuid,
            ${actor}::uuid,
            ${occupancyToRow(input.occupancyType)}
          )
          returning id, society_id, user_id, role, status, occupancy, joined_at
        `,
      );
      return membershipFromRow(parseMemberRowList(inserted));
    });
  }

  /**
   * Leave, or withdraw a pending request.
   *
   * `user_id = actor` is explicit even though the UPDATE grant would also allow
   * an Admin to change other rows — leaving is by definition about your own row,
   * and the filter is what keeps it that way. The "a society always has an
   * active Admin" invariant is enforced by a deferred trigger, so the refusal
   * arrives as `SOCIETY_ADMIN_REQUIRED` → `sole_admin` (the domain asks the same
   * question first; this is what happens when a stale client skips it).
   */
  async leave(societyId: SocietyId, actor: UserId): Promise<void> {
    await this.run(actor, "write", async (tx) => {
      const rows = await query(
        tx,
        sql`
          update public.members
             set status = 'removed'
           where society_id = ${societyId}::uuid
             and user_id = ${actor}::uuid
             and status <> 'removed'
          returning id
        `,
      );
      if (rows.length === 0) {
        // Nothing to leave: no live membership for this caller.
        throw new SocietyError(
          "not_found",
          "That society is not available to you.",
        );
      }
    });
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Runs `work` as `actor` and classifies any failure into the domain's error
   * vocabulary.
   *
   * `context` decides how a `42501` is read (see `societyErrorFromPostgres`), so
   * each method states whether it is a read or a write rather than the
   * classification guessing. A `SocietyError` thrown inside — the membership
   * checks above — passes through untouched: it is already the right answer, and
   * re-classifying it would replace a precise `not_found` with a generic
   * `unknown`.
   */
  private async run<T>(
    actor: UserId | "anonymous",
    context: "read" | "write",
    work: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    // One place translates the port's `UserId` into the transaction's identity
    // union, so no call site can build an actor shape of its own — a second
    // spelling of `{ userId }` is how one method ends up running unidentified.
    const identity: TransactionActor =
      actor === "anonymous"
        ? { kind: "anonymous" }
        : { kind: "user", userId: actor };

    try {
      return await this.unitOfWork.transaction(identity, work);
    } catch (error: unknown) {
      throw isSocietyError(error)
        ? error
        : societyErrorFromPostgres(error, context);
    }
  }

  /** `society_snapshot()`, parsed; `null` when the caller is not a member. */
  private async snapshot(
    tx: TransactionContext,
    id: SocietyId,
  ): Promise<SocietySnapshot | null> {
    const rows = await query(
      tx,
      sql`select public.society_snapshot(${id}::uuid) as snapshot`,
    );
    const value = firstValue(rows, "snapshot");
    return value === null || value === undefined
      ? null
      : parseSnapshot(value, "society");
  }
}

type Row = Record<string, unknown>;

/**
 * `execute` resolves to the driver's own row list, whose index signature is
 * wider than anything we can use directly. The narrowing is one cast in one
 * place; every consumer then goes through a Zod schema, which is what actually
 * makes the values trustworthy.
 */
async function query(
  tx: TransactionContext,
  statement: SQL,
): Promise<readonly Row[]> {
  const rows = await tx.execute(statement);
  return rows as unknown as readonly Row[];
}

/** Reads one named column from the first row, or `undefined` when there is none. */
function firstValue(rows: readonly Row[], column: string): unknown {
  const [row] = rows;
  return row?.[column];
}

function parseSnapshot(value: unknown, what: string): SocietySnapshot {
  const parsed = societySnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw unexpectedShapeError(what);
  }
  return parsed.data;
}

function parseMemberRows(rows: readonly Row[]): readonly MemberRow[] {
  const parsed = memberRowListSchema.safeParse(rows);
  if (!parsed.success) {
    throw unexpectedShapeError("membership");
  }
  return parsed.data;
}

/**
 * Exactly the first of a single-row list, or a shape error.
 *
 * `RETURNING` on a `WHERE` that matched nothing yields no rows, and an INSERT
 * that was refused by a policy yields none either — passing that on as
 * `undefined` would surface as a confusing `TypeError` deep inside the mapper
 * instead of the honest "the database returned something I did not expect".
 */
function parseMemberRowList(rows: readonly Row[]): MemberRow {
  const [first] = parseMemberRows(rows);
  if (first === undefined) {
    throw unexpectedShapeError("membership");
  }
  return first;
}
