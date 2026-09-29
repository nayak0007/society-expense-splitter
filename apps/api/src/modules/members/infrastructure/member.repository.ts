import { Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { MemberError, isMemberError } from "@ses/domain";
import type {
  CreateMemberInput,
  JoinApprovalInput,
  JoinRequestPage,
  JoinRequestQuery,
  Member,
  MemberActivation,
  MemberId,
  MemberPage,
  MemberQuery,
  MemberRepository,
  MemberRole,
  SocietyId,
  UpdateMemberInput,
  UserId,
} from "@ses/domain";

import {
  MembershipInvalidation,
  type MembershipWriteScope,
} from "../../../common/authorization/membership-invalidation";
import {
  UnitOfWork,
  type TransactionActor,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import {
  joinRequestFromRow,
  joinRequestRowListSchema,
  memberCountRowSchema,
  memberErrorFromPostgres,
  memberFromRow,
  memberRowListSchema,
  memberRowSchema,
  roleToDatabase,
  unexpectedShapeError,
} from "./member.rows";

/**
 * `MemberRepository` implemented over Postgres, under RLS.
 *
 * Every property `BuildingRepositoryPostgres` documents holds here and is not repeated: the
 * transaction identity is the port's `actor` (so `auth.uid()` inside every policy resolves to
 * the caller, and a method that forgot it would fail *closed* rather than open), the writes
 * are plain DML inside RLS rather than `SECURITY DEFINER` functions (so the admin requirement
 * is a policy a reviewer can read), and `society_id` is in every `WHERE` including the ones
 * already keyed by `id`.
 *
 * ## Two statements are assembled rather than written out, and why
 *
 * `update` builds its column list from the fields that were actually present — the same
 * technique `apartment.repository.ts` uses and for a sharper reason: **`undefined` means
 * "leave alone" and `null` means "clear"**, and a static `coalesce($n, column)` cannot express
 * the second at all. A shadow member's phone is their only identifier
 * (`uq_members_shadow_phone`), so "clear it" is not a nicety: with a static statement the
 * wrong number could never be retracted. `create` omits `user_id` entirely, which is what
 * makes the row a shadow member.
 *
 * ## The directory read is one statement
 *
 * `list` joins the flat and building labels in and computes the total with `count(*) OVER ()`,
 * so a page of 50 members with their addresses costs **one** round trip — no per-row lookup
 * for the flat (the N+1 the Roadmap's own criteria name) and no second query for "showing 50
 * of 340". There is no dynamic identifier anywhere (every column name is a literal in this
 * file) and every value is a bound parameter, so the two assembled statements cannot be
 * influenced by input.
 */
@Injectable()
export class MemberRepositoryPostgres implements MemberRepository {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    /**
     * Every write in this file can change the caller's *or* another member's cached
     * authorization context — a suspension, a removal, a role change, or the row
     * behind a pending approval — so every write in this file names a cache scope.
     */
    private readonly invalidation: MembershipInvalidation,
  ) {}

  // ── read ────────────────────────────────────────────────────────────────────

  /**
   * One page of the directory, with the total the filters produced.
   *
   * ## What the total counts
   *
   * `count(*) OVER ()` is evaluated **before** `limit`/`offset`, over the filtered rows, which
   * is exactly "rows that match", and it costs nothing extra because the window function rides
   * the same scan. A separate `COUNT(*)` query would be a second round trip on every keystroke
   * of the search box.
   *
   * ## Search, and what it is honest about
   *
   * Name (contains), phone (contains, digit-only) and flat number (exact). Phone matching
   * strips the user's punctuation from *both* sides — the stored value is E.164 and the user
   * types their own formatting — and the clause is dropped entirely when the search has no
   * digits, because `like '%%'` would otherwise match every member who has a number.
   *
   * The name match is `ILIKE '%…%'`, which cannot use a btree index and is therefore a scan of
   * the society's rows. That is the deliberate trade for a directory that is a few hundred rows
   * per society and is filtered by `society_id` first (`idx_members_directory`); the upgrade
   * path is a `pg_trgm` GIN index, recorded in the Roadmap's status block rather than installed
   * speculatively.
   */
  async list(
    societyId: SocietyId,
    actor: UserId,
    query: MemberQuery,
  ): Promise<MemberPage> {
    return this.run(actor, "read", async (tx) => {
      const conditions: SQL[] = [
        sql`m.society_id = ${societyId}::uuid`,
        // Removed rows are excluded unless the caller asked for that status by name. PRD §3.3
        // keeps the history, so they stay reachable — but a directory that showed them beside
        // current residents by default would be a roster nobody trusts.
        query.status === undefined
          ? sql`m.status <> 'removed'`
          : sql`m.status = ${query.status}::public.member_status`,
      ];

      if (query.role !== undefined) {
        // Through the translation, not the domain's spelling: `committee_member` is not a label
        // `public.member_role` has, so the raw value would fail the cast with a `22P02` — a 500
        // for a filter the directory offers in its own UI.
        conditions.push(
          sql`m.role = ${roleToDatabase(query.role)}::public.member_role`,
        );
      }
      if (query.occupancy !== undefined) {
        conditions.push(
          sql`m.occupancy = ${query.occupancy}::public.occupancy_type`,
        );
      }
      if (query.apartmentId !== undefined) {
        conditions.push(sql`m.apartment_id = ${query.apartmentId}::uuid`);
      }
      if (query.buildingId !== undefined) {
        conditions.push(sql`a.building_id = ${query.buildingId}::uuid`);
      }

      const search = query.query?.trim() ?? "";
      if (search.length > 0) {
        const digits = search.replace(/\D/g, "");
        const clauses: SQL[] = [
          sql`m.display_name ilike ${`%${escapeLike(search)}%`} escape '\\'`,
        ];
        if (digits.length > 0) {
          clauses.push(sql`m.phone like ${`%${digits}%`} escape '\\'`);
        }
        clauses.push(sql`upper(a.apartment_number) = upper(${search})`);
        conditions.push(sql`(${sql.join(clauses, sql` or `)})`);
      }

      const order =
        query.sort === "joined"
          ? sql`m.joined_at desc nulls last, m.id asc`
          : sql`m.display_name collate "C" asc, m.id asc`;

      const rows = await query_(
        tx,
        sql`
          select ${memberColumns("m.")},
                 a.apartment_number as apartment_number,
                 a.building_id as building_id,
                 b.name as building_name,
                 a.floor as floor,
                 count(*) over ()::int as total
            from public.members m
            left join public.apartments a
              on a.id = m.apartment_id
             and a.deleted_at is null
            left join public.buildings b
              on b.id = a.building_id
             and b.deleted_at is null
           where ${sql.join(conditions, sql` and `)}
           order by ${order}
           limit ${query.limit ?? 50} offset ${query.offset ?? 0}
        `,
      );

      const parsed = memberRowListSchema.safeParse(rows);
      if (!parsed.success) {
        throw unexpectedShapeError("member directory");
      }
      return {
        members: parsed.data.map((row) => memberFromRow(row)),
        // `count(*) OVER ()` is absent from the row set when there are no rows, and the
        // honest answer then is zero rather than "unknown": the filters matched nothing.
        total: parsed.data[0]?.total ?? 0,
      };
    });
  }

  /** One live member of one society, `null` when the actor may not see them. */
  async findById(
    id: MemberId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<Member | null> {
    return this.run(actor, "read", async (tx) => {
      const rows = await query_(
        tx,
        sql`
          select ${memberColumns("m.")},
                 a.apartment_number as apartment_number,
                 a.building_id as building_id,
                 b.name as building_name,
                 a.floor as floor
            from public.members m
            left join public.apartments a
              on a.id = m.apartment_id
             and a.deleted_at is null
            left join public.buildings b
              on b.id = a.building_id
             and b.deleted_at is null
           where m.id = ${id}::uuid
             and m.society_id = ${societyId}::uuid
             and m.status <> 'removed'
           limit 1
        `,
      );
      const [row] = parseRows(rows);
      return row === undefined ? null : memberFromRow(row);
    });
  }

  /**
   * The caller's own membership row, whatever its status — except `removed`, which is not a
   * membership at all.
   *
   * One indexed lookup on `members_society_user_key`. The status is **not** narrowed here: the
   * capability evaluation is what turns `pending` or `inactive` into a refusal that says so,
   * and collapsing those two into `null` would make a suspended member see "that society is
   * not available to you" for their own society.
   */
  async findViewer(
    societyId: SocietyId,
    actor: UserId,
  ): Promise<Member | null> {
    return this.run(actor, "read", async (tx) => {
      const rows = await query_(
        tx,
        sql`
          select ${memberColumns("m.")},
                 a.apartment_number as apartment_number,
                 a.building_id as building_id,
                 b.name as building_name,
                 a.floor as floor
            from public.members m
            left join public.apartments a
              on a.id = m.apartment_id
             and a.deleted_at is null
            left join public.buildings b
              on b.id = a.building_id
             and b.deleted_at is null
           where m.society_id = ${societyId}::uuid
             and m.user_id = ${actor}::uuid
             and m.status <> 'removed'
           limit 1
        `,
      );
      const [row] = parseRows(rows);
      return row === undefined ? null : memberFromRow(row);
    });
  }

  /**
   * A live **shadow** member holding this number — the question `uq_members_shadow_phone`
   * asks, and no broader.
   *
   * Two members who both have accounts may share a number (a couple with one phone); one
   * person recorded twice as an occupant may not. `exceptId` is how the update path asks about
   * a number it is keeping.
   */
  async findLiveShadowByPhone(
    societyId: SocietyId,
    phone: string,
    actor: UserId,
    exceptId?: MemberId,
  ): Promise<Member | null> {
    return this.run(actor, "read", async (tx) => {
      const rows = await query_(
        tx,
        sql`
          select ${memberColumns("m.")}
            from public.members m
           where m.society_id = ${societyId}::uuid
             and m.user_id is null
             and m.phone = ${phone}
             and m.status <> 'removed'
             ${
               exceptId === undefined
                 ? sql``
                 : sql`and m.id <> ${exceptId}::uuid`
             }
           limit 1
        `,
      );
      const [row] = parseRows(rows);
      return row === undefined ? null : memberFromRow(row);
    });
  }

  // ── write ───────────────────────────────────────────────────────────────────

  /**
   * Insert a shadow member.
   *
   * `user_id` is absent from the statement — that is what makes the row a shadow member, and
   * the INSERT policy (`members_insert_admin`) requires it to be NULL, pins the role to
   * `resident` and the status to `active`. So a use-case bug cannot mint an admin, and a
   * caller that bypassed the API cannot either. `joined_at`/`approved_by` are filled by the
   * `stamp_member_approval()` trigger, because neither column is grantable.
   */
  async create(
    societyId: SocietyId,
    input: CreateMemberInput,
    actor: UserId,
  ): Promise<Member> {
    return this.run(
      actor,
      "write",
      async (tx) => {
        const rows = await query_(
          tx,
          sql`
          insert into public.members (
            society_id, display_name, phone, email, occupancy,
            apartment_id, is_primary, lease_start, lease_end, share_contact, status
          )
          values (
            ${societyId}::uuid,
            ${input.displayName},
            ${input.phone},
            ${input.email ?? null},
            ${input.occupancy ?? "owner_occupied"}::public.occupancy_type,
            ${
              input.apartmentId === undefined || input.apartmentId === null
                ? sql`null::uuid`
                : sql`${input.apartmentId}::uuid`
            },
            ${input.isPrimary ?? false}::boolean,
            ${
              input.leaseStart === undefined || input.leaseStart === null
                ? sql`null::date`
                : sql`${input.leaseStart}::date`
            },
            ${
              input.leaseEnd === undefined || input.leaseEnd === null
                ? sql`null::date`
                : sql`${input.leaseEnd}::date`
            },
            ${input.shareContact ?? false}::boolean,
            'active'::public.member_status
          )
          returning ${memberColumns("")}
        `,
        );
        return memberFromRow(parseSingleRow(rows, "created member"));
      },
      { societyId },
    );
  }

  /**
   * Patch one membership.
   *
   * Only the fields the caller sent become assignments: a field sent as `null` assigns `null`
   * (the cast keeps Postgres from inferring a type from the bind parameter and failing with a
   * `42804`), and a field that is absent is simply not in the statement. `updated_at` is not
   * assigned here — the `touch_updated_at()` trigger owns it, and a second writer of that
   * column would be a second definition of what "updated" means. `removed_at`/`removed_by` are
   * likewise the triggers'.
   */
  async update(
    id: MemberId,
    societyId: SocietyId,
    input: UpdateMemberInput,
    actor: UserId,
  ): Promise<Member> {
    return this.run(
      actor,
      "write",
      async (tx) => {
        const assignments: SQL[] = [];

        const set = (column: string, value: SQL): void => {
          assignments.push(sql`${sql.raw(column)} = ${value}`);
        };

        if (input.displayName !== undefined) {
          set("display_name", sql`${input.displayName}`);
        }
        if (input.phone !== undefined) {
          set(
            "phone",
            input.phone === null
              ? sql`null::varchar`
              : sql`${input.phone}::varchar`,
          );
        }
        if (input.email !== undefined) {
          set(
            "email",
            input.email === null
              ? sql`null::citext`
              : sql`${input.email}::citext`,
          );
        }
        if (input.occupancy !== undefined) {
          set("occupancy", sql`${input.occupancy}::public.occupancy_type`);
        }
        if (input.apartmentId !== undefined) {
          set(
            "apartment_id",
            input.apartmentId === null
              ? sql`null::uuid`
              : sql`${input.apartmentId}::uuid`,
          );
        }
        if (input.isPrimary !== undefined) {
          set("is_primary", sql`${input.isPrimary}::boolean`);
        }
        if (input.leaseStart !== undefined) {
          set(
            "lease_start",
            input.leaseStart === null
              ? sql`null::date`
              : sql`${input.leaseStart}::date`,
          );
        }
        if (input.leaseEnd !== undefined) {
          set(
            "lease_end",
            input.leaseEnd === null
              ? sql`null::date`
              : sql`${input.leaseEnd}::date`,
          );
        }
        if (input.shareContact !== undefined) {
          set("share_contact", sql`${input.shareContact}::boolean`);
        }

        // The use case rejects an empty patch, and so does the contract at the edge. Reaching
        // here with nothing would mean an `UPDATE` with an empty `SET`, which is not valid SQL —
        // so it is reported as the caller mistake it is rather than surfacing as a syntax error
        // the classifier calls `unknown`.
        if (assignments.length === 0) {
          throw new MemberError("validation", "Nothing to update.", {
            field: "displayName",
          });
        }

        const rows = await query_(
          tx,
          sql`
          update public.members
             set ${sql.join(assignments, sql`, `)}
           where id = ${id}::uuid
             and society_id = ${societyId}::uuid
             and status <> 'removed'
          returning ${memberColumns("")}
        `,
        );

        const [row] = parseRows(rows);
        if (row === undefined) {
          // The caller is an active member of this society — `SocietyGuard` ran before the
          // handler — so zero rows means the member is not in it, or has been removed. One
          // answer, because distinguishing them would let an Admin of one society enumerate
          // another's membership ids.
          throw new MemberError(
            "not_found",
            "That member is not available to you.",
          );
        }
        return memberFromRow(row);
      },
      { societyId },
    );
  }

  /**
   * Suspend or reactivate.
   *
   * The transition rule (which status may follow which) is the use case's, checked against the
   * row it read; this statement writes the target status. What the *database* refuses here is
   * the consequence rather than the transition: reactivating a member whose flat has since
   * gained another primary owner trips `uq_primary_occupant`, and suspending the last active
   * admin trips `chk_admin_present()` — both classified by `member.rows.ts`.
   */
  async setStatus(
    id: MemberId,
    societyId: SocietyId,
    status: MemberActivation,
    actor: UserId,
  ): Promise<Member> {
    return this.run(
      actor,
      "write",
      async (tx) => {
        const rows = await query_(
          tx,
          sql`
          update public.members
             set status = ${status}::public.member_status
           where id = ${id}::uuid
             and society_id = ${societyId}::uuid
             and status <> 'removed'
          returning ${memberColumns("")}
        `,
        );
        const [row] = parseRows(rows);
        if (row === undefined) {
          throw new MemberError(
            "not_found",
            "That member is not available to you.",
          );
        }
        return memberFromRow(row);
      },
      { societyId },
    );
  }

  /**
   * Set a membership's role (T046) — the storage half of a role change and nothing else.
   *
   * Every *decision* was made above this line: the use case checked the capability, the
   * self-change, the target's status, the no-op, the caps and the last Admin, and the database
   * checks the last four again underneath (the column grant, `chk_member_self_change()`,
   * `chk_role_caps()`, `chk_admin_present()`). An adapter that decided one of them would be a
   * second copy of a rule with an owner.
   *
   * `status <> 'removed'` as everywhere else in this file: a removed membership is not a
   * membership. A `pending` or `rejected` target reaches `chk_role_caps()` and is refused there —
   * deliberately not filtered here, because the *use case* refuses it first with a sentence and
   * the trigger is the lock behind that door, not the door.
   */
  async setRole(
    id: MemberId,
    societyId: SocietyId,
    role: MemberRole,
    actor: UserId,
  ): Promise<Member> {
    return this.run(
      actor,
      "write",
      async (tx) => {
        const rows = await query_(
          tx,
          sql`
          update public.members
             set role = ${roleToDatabase(role)}::public.member_role
           where id = ${id}::uuid
             and society_id = ${societyId}::uuid
             and status <> 'removed'
          returning ${memberColumns("")}
        `,
        );
        const [row] = parseRows(rows);
        if (row === undefined) {
          throw new MemberError(
            "not_found",
            "That member is not available to you.",
          );
        }
        return memberFromRow(row);
      },
      { societyId },
    );
  }

  /**
   * How many **active** members of the society hold `role`, excluding one row.
   *
   * The count PRD §2.2's caps are made of: `active` only (a suspended treasurer does not occupy a
   * slot, or a society that suspended one could never appoint a replacement), and `exceptId`
   * excludes the row being written so re-assigning a member the role they already hold counts
   * once. A `read` in this file's sense — no write, no failure to classify.
   */
  async countActiveByRole(
    societyId: SocietyId,
    role: MemberRole,
    actor: UserId,
    exceptId?: MemberId,
  ): Promise<number> {
    return this.run(actor, "read", async (tx) => {
      const rows = await query_(
        tx,
        sql`
          select count(*)::int as count
            from public.members m
           where m.society_id = ${societyId}::uuid
             and m.role = ${roleToDatabase(role)}::public.member_role
             and m.status = 'active'
             ${
               exceptId === undefined
                 ? sql``
                 : sql`and m.id <> ${exceptId}::uuid`
             }
        `,
      );
      const parsed = memberCountRowSchema.safeParse(rows[0]);
      if (!parsed.success) {
        throw unexpectedShapeError("member role count");
      }
      return parsed.data.count;
    });
  }

  /**
   * Soft removal (PRD §3.3).
   *
   * An `UPDATE` rather than a `DELETE`, and the row is the reason: dues, payments and receipts
   * reference `members.id`, and "financial history is never deleted" is a product principle
   * rather than a nicety. `removed_at` and `removed_by` are stamped by
   * `stamp_member_removal()` — neither column is grantable, so nobody can claim a removal they
   * did not perform.
   */
  // ── the join queue (T049) ───────────────────────────────────────────────────

  /**
   * One page of the society's pending requests, newest first, each with the other live
   * memberships claiming its flat.
   *
   * ## One statement, claims included
   *
   * The alternative — read the page, then ask for the claims of each row's flat — is the N+1
   * the directory's own header argues against, and on a queue that exists to surface
   * *collisions* it would also be a correctness problem: the claim set must be the set the
   * pending row was read with, not a second snapshot a decision could land between.
   *
   * `count(*) over ()` rides the same scan, so "showing 20 of 34" costs nothing extra. The
   * claims are aggregated as JSON in the same statement: `row_to_json()` keeps the column
   * names identical to `memberColumns()`, so the very same row schema validates them and
   * `memberFromRow()` builds them — no second mapper for the same table.
   *
   * ## What "a claim" is
   *
   * Every **live** membership (`status <> 'removed'`) naming the same `apartment_id` in the
   * same society, this request included, oldest first. Deliberately not narrowed to `active`:
   * a second *pending* claim is precisely the collision PRD §3.2 says to route to the Admin
   * rather than auto-reject, and a suspended former resident is worth seeing beside the row
   * that would take their flat. A request with no flat has no claims by construction, which
   * is why the lateral's `m.apartment_id is not null` is there rather than a NULL-safe
   * equality — "both have no flat" is not a claim on anything.
   */
  async listJoinRequests(
    societyId: SocietyId,
    actor: UserId,
    query: JoinRequestQuery,
  ): Promise<JoinRequestPage> {
    return this.run(actor, "read", async (tx) => {
      const rows = await query_(
        tx,
        sql`
          select ${memberColumns("m.")},
                 a.apartment_number as apartment_number,
                 a.building_id as building_id,
                 b.name as building_name,
                 a.floor as floor,
                 count(*) over ()::int as total,
                 coalesce(claims.rows, '[]'::jsonb) as claims
            from public.members m
            left join public.apartments a
              on a.id = m.apartment_id
             and a.deleted_at is null
            left join public.buildings b
              on b.id = a.building_id
             and b.deleted_at is null
            left join lateral (
              select jsonb_agg(
                       row_to_json(claim_row)::jsonb
                       order by claim_row.created_at
                     ) as rows
                from (
                  select c.id, c.society_id, c.user_id, c.apartment_id, c.display_name,
                         c.phone, c.email, c.role, c.status, c.occupancy, c.is_primary,
                         c.lease_start, c.lease_end, c.share_contact, c.joined_at,
                         c.approved_by, c.removed_at, c.removed_by, c.request_note,
                         c.rejection_reason, c.rejected_at, c.rejected_by,
                         c.created_at, c.updated_at,
                         ca.apartment_number as apartment_number,
                         ca.building_id as building_id,
                         cb.name as building_name,
                         ca.floor as floor
                    from public.members c
                    left join public.apartments ca
                      on ca.id = c.apartment_id
                     and ca.deleted_at is null
                    left join public.buildings cb
                      on cb.id = ca.building_id
                     and cb.deleted_at is null
                   where c.society_id = m.society_id
                     and c.status <> 'removed'
                     and m.apartment_id is not null
                     and c.apartment_id = m.apartment_id
                ) as claim_row
            ) claims on true
           where m.society_id = ${societyId}::uuid
             and m.status = 'pending'
           order by m.created_at desc
           limit ${query.limit ?? 50} offset ${query.offset ?? 0}
        `,
      );

      const parsed = joinRequestRowListSchema.safeParse(rows);
      if (!parsed.success) {
        throw unexpectedShapeError("join request queue");
      }
      return {
        requests: parsed.data.map((row) => joinRequestFromRow(row)),
        total: parsed.data[0]?.total ?? 0,
      };
    });
  }

  /**
   * Admit a pending member — the atomic decision.
   *
   * The order inside the transaction is the design: the function is *called* (it does the
   * locking, the reviewer check, the state check and the write in one statement of its own),
   * and the row is then **re-read** rather than assembled from the answer. The answer a
   * `SECURITY DEFINER` function could return is a shape this adapter would have to keep in
   * step with `memberColumns()`; re-reading means the response is the row as the database now
   * holds it — including anything a trigger added (`joined_at`, the approval stamp) — and one
   * schema validates every read path.
   *
   * `p_payload` carries only the fields the caller actually sent, so "absent means as
   * requested" survives the boundary: a payload built by spreading defaults would silently
   * overwrite the requester's declaration with its own.
   */
  async approveJoinRequest(
    id: MemberId,
    societyId: SocietyId,
    input: JoinApprovalInput,
    actor: UserId,
  ): Promise<Member> {
    return this.run(
      actor,
      "write",
      async (tx) => {
        const payload: Record<string, unknown> = {};
        if (input.role !== undefined) payload.role = input.role;
        if (input.occupancy !== undefined) payload.occupancy = input.occupancy;
        if (input.apartmentId !== undefined) {
          payload.apartment_id = input.apartmentId;
        }
        if (input.isPrimary !== undefined) payload.is_primary = input.isPrimary;

        await query_(
          tx,
          sql`select public.member_approve_join(
              ${id}::uuid,
              ${societyId}::uuid,
              ${actor}::uuid,
              ${JSON.stringify(payload)}::jsonb
            )`,
        );

        return readMember(tx, id, societyId);
      },
      { societyId },
    );
  }

  /**
   * Refuse a pending member — the same transaction shape as the approval.
   *
   * The reason is a function argument rather than a row patch, so a rejection and its
   * explanation are written by one statement: there is no window in which a membership is
   * `rejected` and the reason has not arrived. The trigger's `rejected_at`/`rejected_by`
   * stamps are the database's, which is why this adapter sends only the reason.
   */
  async rejectJoinRequest(
    id: MemberId,
    societyId: SocietyId,
    reason: string,
    actor: UserId,
  ): Promise<Member> {
    return this.run(
      actor,
      "write",
      async (tx) => {
        await query_(
          tx,
          sql`select public.member_reject_join(
              ${id}::uuid,
              ${societyId}::uuid,
              ${actor}::uuid,
              ${reason}
            )`,
        );

        return readMember(tx, id, societyId);
      },
      { societyId },
    );
  }

  async remove(
    id: MemberId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<void> {
    await this.run(
      actor,
      "write",
      async (tx) => {
        const rows = await query_(
          tx,
          sql`
          update public.members
             set status = 'removed'::public.member_status
           where id = ${id}::uuid
             and society_id = ${societyId}::uuid
             and status <> 'removed'
          returning id
        `,
        );
        if (rows.length === 0) {
          throw new MemberError(
            "not_found",
            "That member is not available to you.",
          );
        }
      },
      { societyId },
    );
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /**
   * Runs `work` as `actor` and classifies any failure into the module's vocabulary.
   *
   * `cacheScope` is supplied by every **write** and by no read, and the version bump
   * it triggers is what makes a revocation take effect immediately: an entry stored
   * under the previous version is a miss on the next lookup, which is why this can
   * pass a bare `societyId` rather than the affected member's id. See
   * `MembershipInvalidation` — the third argument's absence in a future write would
   * be the one mistake this design cannot detect at compile time, which is why writes
   * and reads are the only two shapes and a write is the one that takes it.
   */
  private async run<T>(
    actor: UserId,
    context: "read" | "write",
    work: (tx: TransactionContext) => Promise<T>,
    cacheScope?: MembershipWriteScope,
  ): Promise<T> {
    const identity: TransactionActor = { kind: "user", userId: actor };

    const perform = async (): Promise<T> => {
      try {
        return await this.unitOfWork.transaction(identity, work);
      } catch (error: unknown) {
        // A `MemberError` thrown inside — the not-found and empty-patch branches — passes
        // through untouched: re-classifying it would replace a precise answer with a generic
        // `unknown`.
        throw isMemberError(error)
          ? error
          : memberErrorFromPostgres(error, context);
      }
    };

    return cacheScope === undefined
      ? perform()
      : this.invalidation.around(cacheScope, perform);
  }
}

/**
 * One column list, one place.
 *
 * `prefix` is either `""` (for a `RETURNING`, where the target table's columns are in scope
 * unqualified) or `"m."` (for the joined reads). Both spellings name the same columns, which
 * is the point: a column added to the table but to only one of them would produce a `Member`
 * whose new field is `undefined` from one path and set from another — the kind of difference
 * that only shows up on one screen. The prefix is a literal chosen in this file, never input.
 */
/**
 * Re-read one membership inside the caller's transaction.
 *
 * Shared by the two join decisions, which is the whole reason it exists: both write through a
 * `SECURITY DEFINER` function and then answer with the row the database now holds — the same
 * column list, the same flat join, the same schema and the same `not_found` for a row RLS
 * hides — so a field added to one path cannot appear on the other.
 */
async function readMember(
  tx: TransactionContext,
  id: MemberId,
  societyId: SocietyId,
): Promise<Member> {
  const rows = await query_(
    tx,
    sql`
      select ${memberColumns("m.")},
             a.apartment_number as apartment_number,
             a.building_id as building_id,
             b.name as building_name,
             a.floor as floor
        from public.members m
        left join public.apartments a
          on a.id = m.apartment_id
         and a.deleted_at is null
        left join public.buildings b
          on b.id = a.building_id
         and b.deleted_at is null
       where m.id = ${id}::uuid
         and m.society_id = ${societyId}::uuid
         and m.status <> 'removed'
       limit 1
    `,
  );

  const parsed = memberRowListSchema.safeParse(rows);
  const [row] = parsed.success ? parsed.data : [];
  if (row === undefined) {
    // The decision succeeded, so the row exists; a `null` here means the read could not see
    // it, and answering `not_found` is the port's rule for "not available to this actor"
    // rather than a `500` that would look like the write had failed.
    throw new MemberError("not_found", "That member is not available to you.", {
      hint: "The join decision wrote a row that is no longer readable.",
    });
  }
  return memberFromRow(row);
}

function memberColumns(prefix: string): SQL {
  const columns = [
    "id",
    "society_id",
    "user_id",
    "apartment_id",
    "display_name",
    "phone",
    "email",
    "role",
    "status",
    "occupancy",
    "is_primary",
    "lease_start",
    "lease_end",
    "share_contact",
    "joined_at",
    "approved_by",
    "removed_at",
    "removed_by",
    "request_note",
    "rejection_reason",
    "rejected_at",
    "rejected_by",
    "created_at",
    "updated_at",
  ];
  return sql.raw(
    columns.map((column) => `${prefix}${column} as ${column}`).join(", "),
  );
}

type Row = Record<string, unknown>;

/**
 * `execute` resolves to the driver's own row list, whose index signature is wider than
 * anything usable directly. The narrowing is one cast in one place; every consumer then goes
 * through a Zod schema, which is what actually makes the values trustworthy.
 */
async function query_(
  tx: TransactionContext,
  statement: SQL,
): Promise<readonly Row[]> {
  const rows = await tx.execute(statement);
  return rows as unknown as readonly Row[];
}

function parseRows(rows: readonly Row[]) {
  const parsed = memberRowListSchema.safeParse(rows);
  if (!parsed.success) {
    throw unexpectedShapeError("member");
  }
  return parsed.data;
}

/**
 * Exactly the row a single-row `RETURNING` promised, or a shape error.
 *
 * An INSERT refused by a policy *raises* rather than returning zero rows, so reaching this
 * with nothing means the database returned something this layer did not expect — which is the
 * honest thing to say, rather than a `TypeError` deep inside the mapper.
 */
function parseSingleRow(rows: readonly Row[], what: string) {
  const [first] = parseRows(rows);
  if (first === undefined) {
    throw unexpectedShapeError(what);
  }
  const parsed = memberRowSchema.safeParse(first);
  if (!parsed.success) {
    throw unexpectedShapeError(what);
  }
  return parsed.data;
}

/**
 * Escapes the two characters `LIKE` treats as wildcards, so a search for `50%` looks for a
 * percent sign rather than matching every member in the society. Used with `escape '\'` in the
 * statement, which is what makes the backslash mean "literal" rather than "escape character".
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
