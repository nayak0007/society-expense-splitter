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
  SocietyJoinOptions,
  SocietyJoinPreview,
  SocietyMembership,
  SocietyRepository,
  StructureMembershipReader,
  UpdateSocietyInput,
  UserId,
} from "@ses/domain";

import {
  MembershipInvalidation,
  type MembershipWriteScope,
} from "../../../common/authorization/membership-invalidation";
import type {
  SocietyAuthorizationContext,
  SocietyAuthorizationReader,
} from "../../../common/authorization/society-authorization";
import {
  UnitOfWork,
  type TransactionActor,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import {
  createPayload,
  isJoinCodeCollision,
  isSlugCollision,
  joinOptionsFromPayload,
  joinOptionsSchema,
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
export class SocietyRepositoryPostgres
  implements
    SocietyRepository,
    SocietyAuthorizationReader,
    StructureMembershipReader
{
  constructor(
    private readonly unitOfWork: UnitOfWork,
    /**
     * Every write in this file changes something the guard's cached read holds —
     * the society row itself, or the caller's membership in it — so every write in
     * this file names a cache scope. See `MembershipInvalidation` for why the
     * ordering can only be expressed as a wrapper.
     */
    private readonly invalidation: MembershipInvalidation,
  ) {}

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

  /**
   * The caller's own membership row in one society, or `null`.
   *
   * Satisfies `StructureMembershipReader` (`@ses/domain`), which the building
   * module consumes — see that interface for why the implementation lives here
   * rather than in the structure module. One indexed lookup on
   * `uq_members_society_user`, not a roster read: the caller needs their own role
   * and nothing else.
   *
   * Returns a `pending` or `removed` row rather than filtering it, because the
   * *caller* has to distinguish "not a member" (`not_found`) from "a member whose
   * role is insufficient" (`forbidden`), and collapsing the two here would move
   * that rule into every consumer.
   */
  async findMembership(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyMembership | null> {
    return this.run(actor, "read", async (tx) => {
      const rows = await query(
        tx,
        sql`
          select id, society_id, user_id, role, status, occupancy, joined_at
            from public.members
           where society_id = ${societyId}::uuid
             and user_id = ${actor}::uuid
           limit 1
        `,
      );
      const [row] = parseMemberRows(rows);
      // A shadow member (no `user_id`) cannot be represented by the domain, and
      // cannot be the caller of an authenticated request; `null` is the honest
      // answer for both it and "no row".
      if (row === undefined || row.user_id === null) return null;
      return membershipFromRow(row);
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

  /**
   * The guard's read: the society and the caller's membership, in one query.
   *
   * Deliberately the same `society_snapshot()` call `findById` uses, rather than
   * a second query bolted on for the guard. That function already answers
   * membership and existence together — it returns `null` for a non-member, for a
   * deleted society, and for one that never existed — so asking it once gives the
   * guard everything `SocietyAuthorizationReader` promises, under the caller's own
   * RLS identity, with no opportunity for the two answers to disagree.
   *
   * `membership === null` is a state the RPC should not produce for a caller who
   * passed the membership predicate, and `user_id === null` means a shadow member
   * (PRD §3.2, no account yet) — which the domain cannot represent, since
   * `SocietyMembership.userId` is a `UserId`. Both are reported as "no membership"
   * rather than thrown: this is a guard, and the safe answer to an unrepresentable
   * membership is to treat the caller as not a member.
   */
  async load(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<SocietyAuthorizationContext | null> {
    return this.run(actor, "read", async (tx) => {
      const snapshot = await this.snapshot(tx, societyId);
      if (
        snapshot === null ||
        snapshot.membership === null ||
        snapshot.membership.user_id === null
      ) {
        return null;
      }
      return {
        society: societyFromSnapshot(snapshot),
        membership: membershipFromRow(snapshot.membership),
      };
    });
  }

  /**
   * The flats a join code's society offers, for the join screen's selector (T049).
   *
   * Runs as the **caller** (authenticated, no membership), which is exactly why the read goes
   * through `society_join_options()`: `apartments_select_member` requires
   * `is_society_member(society_id, true)`, so no policy can serve a requester who has not
   * joined yet — the join code is the credential, and the function is the venue.
   *
   * An unknown code arrives as `P0001/SOCIETY_JOIN_CODE_INVALID` and is classified into the
   * society vocabulary, so the screen shows the same string the submission would.
   */
  async joinOptions(
    rawCode: string,
    options: {
      readonly query?: string | undefined;
      readonly limit?: number | undefined;
    },
    actor: UserId,
  ): Promise<SocietyJoinOptions> {
    const code = normalizeJoinCode(rawCode);
    if (code.length === 0) {
      throw new SocietyError(
        "join_code_invalid",
        "That join code does not match any society.",
      );
    }

    return this.run(actor, "read", async (tx) => {
      const rows = await query(
        tx,
        sql`select public.society_join_options(
              ${code},
              ${options.query ?? null},
              ${options.limit ?? null}
            ) as options`,
      );
      const payload = firstValue(rows, "options");
      if (payload === null || payload === undefined) {
        // The function either returns a payload or raises; a `null` here would mean a
        // signature change nobody noticed, so it is reported as the shape error it is.
        throw unexpectedShapeError("join options");
      }
      const parsed = joinOptionsSchema.safeParse(payload);
      if (!parsed.success) {
        throw unexpectedShapeError("join options");
      }
      return joinOptionsFromPayload(parsed.data);
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
    // The society id does not exist until `society_create()` has minted it, so the
    // cache scope is read off the result — and the creator's own entry goes with
    // it, because the row this write created is the one their next request reads.
    return this.run(
      actor,
      "write",
      async (tx) => {
        const payload = createPayload(input);
        const statement = sql`
        select public.society_create(${JSON.stringify(payload)}::jsonb) as snapshot
      `;

        // `society_create` mints **two** unique values, so a failure here can be a
        // race rather than a bug: the join code is random (another society took it
        // between the uniqueness check and the insert — PRD T040's "join-code
        // collision retries and succeeds"), and the slug is derived from the name
        // (two people can pick one name at the same instant).
        //
        // Each attempt runs in its own **savepoint**, and that is the whole reason
        // this works. In PostgreSQL a failed statement aborts the surrounding
        // transaction, so re-issuing the statement directly would fail with `25P02`
        // (`current transaction is aborted`) rather than minting again — which is
        // exactly what the single retry added with T040 did: it could never fire, so
        // the collision it was written for always surfaced as a conflict. A nested
        // transaction is a savepoint in the postgres-js driver, so a failed attempt
        // rolls back to just before the INSERT and the outer transaction (and the
        // caller's RLS identity) survives to try again.
        //
        // Bounded, because a third failure means something else is wrong and the
        // classifier should see it: an exhausted retry keeps the database's own
        // error, and `societyErrorFromPostgres` answers with `conflict`.
        let snapshot: SocietySnapshot | undefined;
        let lastError: unknown;
        for (
          let attempt = 1;
          attempt <= MAX_SOCIETY_MINT_ATTEMPTS && snapshot === undefined;
          attempt += 1
        ) {
          try {
            snapshot = await tx.transaction(async (inner) => {
              const rows = await query(inner, statement);
              return parseSnapshot(
                firstValue(rows, "snapshot"),
                "created society",
              );
            });
          } catch (error: unknown) {
            if (!isJoinCodeCollision(error) && !isSlugCollision(error)) {
              throw error;
            }
            lastError = error;
          }
        }

        if (snapshot === undefined) {
          // Unreachable while `MAX_SOCIETY_MINT_ATTEMPTS` is at least one, and it
          // exists so the types stay honest rather than for the control flow.
          throw (
            lastError ??
            new SocietyError(
              "unknown",
              "Something went wrong. Please try again.",
              { hint: "society_create() was never attempted." },
            )
          );
        }
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
      },
      (created) => ({ societyId: created.society.id, userIds: [actor] }),
    );
  }

  /** Patch the society and/or its settings atomically. Admin-only, in SQL. */
  async update(
    id: SocietyId,
    input: UpdateSocietyInput,
    actor: UserId,
  ): Promise<Society> {
    // The society row is half of what the guard's read returns, so a rename is an
    // invalidation too — not because a name is a privilege, but because a cached
    // name that outlives its edit is the kind of wrongness that makes people stop
    // trusting the cache, and then the revocation guarantee with it.
    return this.run(
      actor,
      "write",
      async (tx) => {
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
      },
      { societyId: id },
    );
  }

  /** Admin-only join-code rotation. The new code is minted server-side. */
  async regenerateJoinCode(id: SocietyId, actor: UserId): Promise<Society> {
    return this.run(
      actor,
      "write",
      async (tx) => {
        const rows = await query(
          tx,
          sql`
          select public.society_rotate_join_code(${id}::uuid) as snapshot
        `,
        );
        return societyFromSnapshot(
          parseSnapshot(firstValue(rows, "snapshot"), "rotated society"),
        );
      },
      { societyId: id },
    );
  }

  /**
   * Soft delete: the society row stays, so financial history keeps its owner
   * (PRD §3.1), while `deleted_at` takes it out of every read path and the join
   * code stops resolving. Admin-only, checked inside the function.
   */
  async remove(id: SocietyId, actor: UserId): Promise<void> {
    await this.run(
      actor,
      "write",
      async (tx) => {
        await query(tx, sql`select public.society_soft_delete(${id}::uuid)`);
      },
      { societyId: id },
    );
  }

  /**
   * Ask to join with a code (never auto-approved — PRD §3.2).
   *
   * One transaction for all five steps. The write is pinned to
   * `user_id = actor` and to the `pending`/`resident` defaults *by the column
   * grant*, so a tampered caller cannot approve itself; a race is answered by
   * `members_society_user_key`, which the error classifier reports as
   * `already_member`.
   *
   * ## The flat, the note, and the four states a caller can arrive in (T049)
   *
   * | Row the actor already has | Answer                                                                 |
   * | ------------------------- | ---------------------------------------------------------------------- |
   * | none                      | insert a `pending` request carrying the flat and note                  |
   * | `pending`                 | `already_member` — "you have already asked"; a second row is refused by `members_society_user_key` anyway, this says so in words |
   * | `active` / `inactive`     | `already_member` — they are in the society                                |
   * | `rejected`                | re-ask: the same row returns to `pending` with the new claim             |
   * | `removed`                 | re-ask: the same row returns to `pending`, `removed_at` cleared          |
   *
   * The `rejected` branch is T049's: `chk_member_self_change()` allows exactly that transition,
   * and it is the difference between "rejected once, wrong flat, ask again" and a dead end that
   * only an Admin can unlock. The previous rejection's reason survives on the row, so the next
   * reviewer sees what the last one decided.
   *
   * ## Why the flat is checked through a function
   *
   * `is_live_society_apartment()` is `SECURITY DEFINER` because the caller is not a member yet:
   * `apartments_select_member` requires `is_society_member(society_id, true)`, so a
   * policy-filtered existence check would answer "no" to every flat. The composite foreign key
   * would catch another tenant's flat, but not a *soft-deleted* one in this society — and a
   * request that claims a flat being removed would only fail at approval, with the message meant
   * for a different situation.
   *
   * `join_request_blocking_shadow()` is the same shape for the same reason, and it closes the one
   * collision that ends in money: if the Admin has already recorded this person as a shadow
   * occupant, activating a second row would bill the same flat's occupant twice. The designed
   * path for that person is an invitation (T047 links the shadow row); this refuses the join
   * request and says so.
   */
  async join(
    input: JoinSocietyInput,
    actor: UserId,
  ): Promise<SocietyMembership> {
    return this.run(
      actor,
      "write",
      async (tx) => {
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

        const occupancy = occupancyToRow(input.occupancyType);

        // The two facts a requester cannot read for themselves, resolved by definer functions:
        // the flat is a live flat of this society, and this person is not already recorded here
        // as a shadow occupant. Both are refused *before* anything is written, so a request is
        // never accepted and then found to be a duplicate.
        if (input.apartmentId !== null) {
          const flatRows = await query(
            tx,
            sql`select public.is_live_society_apartment(
                ${input.apartmentId}::uuid,
                ${societyId}::uuid
              ) as ok`,
          );
          if (firstValue(flatRows, "ok") !== true) {
            throw new SocietyError(
              "validation",
              "That flat is not an available flat of this society.",
              { field: "apartmentId" },
            );
          }
        }

        const shadowRows = await query(
          tx,
          sql`select public.join_request_blocking_shadow(
              ${societyId}::uuid,
              ${actor}::uuid
            ) as shadow`,
        );
        if (firstValue(shadowRows, "shadow") != null) {
          throw new SocietyError(
            "already_member",
            "An occupant is already recorded for your number in this society. Ask an Admin for an invitation link.",
            { field: "phone" },
          );
        }

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
          if (existing.status === "active" || existing.status === "inactive") {
            throw new SocietyError(
              "already_member",
              "You are already a member of this society.",
            );
          }
          if (existing.status === "pending") {
            throw new SocietyError(
              "already_member",
              "You have already asked to join this society. An Admin has to approve it.",
            );
          }
          // `removed` (left or withdrew) and `rejected` (refused, asking again): the row is history
          // and is re-asked, never re-created. `chk_member_self_change()` allows exactly these two
          // transitions, and it is also what refuses a self-approval if a caller tried to write
          // `active` here instead.
          const reasked = await query(
            tx,
            sql`
            update public.members
               set status = 'pending',
                   occupancy = ${occupancy},
                   apartment_id = ${input.apartmentId}::uuid,
                   request_note = ${input.note},
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
          insert into public.members (
            society_id, user_id, occupancy, apartment_id, request_note
          )
          values (
            ${societyId}::uuid,
            ${actor}::uuid,
            ${occupancy},
            ${input.apartmentId}::uuid,
            ${input.note}
          )
          returning id, society_id, user_id, role, status, occupancy, joined_at
        `,
        );
        return membershipFromRow(parseMemberRowList(inserted));
        // The scope off the result, not off a local: the society is resolved *inside*
        // this transaction (from the join code), so it is not in scope at the call.
      },
      (joined) => ({ societyId: joined.societyId, userIds: [actor] }),
    );
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
    await this.run(
      actor,
      "write",
      async (tx) => {
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
      },
      { societyId, userIds: [actor] },
    );
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
    /**
     * What this write changes, for the membership cache — omitted by every read.
     *
     * The fourth argument rather than a `cache.invalidate()` line at the end of each
     * method because the *ordering* is the correctness argument and a wrapper is the
     * only thing that can express all of it: gate raised before the transaction,
     * version bumped and entry dropped after the commit, gate lowered and nothing
     * bumped when it rolled back. A trailing call gets the first two and forgets the
     * third, and the third is what makes a rollback harmless.
     *
     * A function of the result, for `create`: the society id is minted inside the
     * transaction, so the cache scope cannot be known until the transaction has
     * answered.
     */
    cacheScope?:
      MembershipWriteScope | ((result: T) => MembershipWriteScope | undefined),
  ): Promise<T> {
    // One place translates the port's `UserId` into the transaction's identity
    // union, so no call site can build an actor shape of its own — a second
    // spelling of `{ userId }` is how one method ends up running unidentified.
    const identity: TransactionActor =
      actor === "anonymous"
        ? { kind: "anonymous" }
        : { kind: "user", userId: actor };

    const perform = async (): Promise<T> => {
      try {
        return await this.unitOfWork.transaction(identity, work);
      } catch (error: unknown) {
        throw isSocietyError(error)
          ? error
          : societyErrorFromPostgres(error, context);
      }
    };

    return cacheScope === undefined
      ? perform()
      : this.invalidation.around(cacheScope, perform);
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
 * How many times `create()` re-runs `society_create()` when the *database-minted*
 * values collide with a society created a moment earlier.
 *
 * Three, not one: the join code is random, so a second attempt almost always
 * succeeds; the slug is derived from the name, so a retry only helps once the
 * competitor has committed. A third failure is reported rather than retried,
 * because at that point the honest answer is the conflict the classifier already
 * produces.
 */
const MAX_SOCIETY_MINT_ATTEMPTS = 3;

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
