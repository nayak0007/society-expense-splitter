import { Injectable } from "@nestjs/common";
import { sql, type SQL } from "drizzle-orm";
import { InvitationError, isInvitationError } from "@ses/domain";
import type {
  CreateInvitationInput,
  Invitation,
  InvitationAcceptance,
  InvitationId,
  InvitationPage,
  InvitationPreview,
  InvitationQuery,
  InvitationRepository,
  SocietyId,
  UserId,
} from "@ses/domain";

import type { MembershipWriteScope } from "../../../common/authorization/membership-invalidation";
import { MembershipInvalidation } from "../../../common/authorization/membership-invalidation";
import {
  UnitOfWork,
  type TransactionActor,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import { roleToDatabase } from "../../members/infrastructure/member.rows";
import {
  invitationAcceptanceFromRow,
  invitationAcceptanceRowSchema,
  invitationErrorFromPostgres,
  invitationFromRow,
  invitationPreviewFromRow,
  invitationPreviewRowSchema,
  invitationRowListSchema,
  invitationRowSchema,
  unexpectedShapeError,
} from "./invitation.rows";

/**
 * `InvitationRepository` implemented over Postgres, under RLS.
 *
 * ## Three identities, and why each is the right one
 *
 *  - `create`/`list`/`findById`/`revoke` run as the **caller** (`{ kind: "user" }`), so the policies
 *    decide: `is_society_member_manager()` is the predicate, and the `invited_by` trigger resolves the
 *    membership from `auth.uid()`. A method that forgot the identity would fail *closed* rather than
 *    open — `auth.uid()` NULL matches no policy — which is the property that makes this safe to write
 *    eight ways.
 *  - `previewByTokenHash` runs **anonymous**: the `authenticated` role with no `auth.uid()`, which is
 *    what a signed-out recipient can have. Only the `SECURITY DEFINER` projection is reachable, and
 *    the table itself still yields nothing.
 *  - `accept` runs as the **caller** as well — the acceptance function checks `p_actor` against
 *    `auth.uid()` itself, so the identity is not decoration here: it is the half of the check that
 *    the function cannot make for itself.
 *
 * ## Two statements are `SELECT public.<function>(…)` rather than DML
 *
 * Preview and accept are the two operations whose *rules* are a projection and an atomic write, and
 * both belong in the database: preview has to mask and to move the funnel in one statement, and
 * acceptance has to hold a row lock while it decides. Writing either as client-side reads and writes
 * would be a second implementation of both — and the acceptance one would not be atomic.
 *
 * Nothing in this file decides anything about invitations. Whether one may exist, at which role, for
 * whom, and whether acceptance is allowed are decisions taken above it (the use cases) and below it
 * (the triggers and functions).
 */
@Injectable()
export class InvitationRepositoryPostgres implements InvitationRepository {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    /**
     * Acceptance is the one write in this file that grants authority — it creates the
     * membership and assigns the role — so it is fenced like every other membership
     * write. The society is not known until `invitation_accept()` has resolved the token,
     * which is exactly why the scope may be a function of the result.
     */
    private readonly invalidation: MembershipInvalidation,
  ) {}

  /** Insert one invitation. `status` is the column's default (`sent`), and `invited_by` is the trigger's. */
  async create(
    societyId: SocietyId,
    input: CreateInvitationInput,
    actor: UserId,
  ): Promise<Invitation> {
    return this.run(actor, "write", async (tx) => {
      const rows = await query_(
        tx,
        sql`
          insert into public.invitations (
            society_id, apartment_id, channel, phone, email, role, token_hash, expires_at
          )
          values (
            ${societyId}::uuid,
            ${
              input.apartmentId === null
                ? sql`null::uuid`
                : sql`${input.apartmentId}::uuid`
            },
            ${input.channel},
            ${
              input.phone === null
                ? sql`null::varchar`
                : sql`${input.phone}::varchar`
            },
            ${input.email === null ? sql`null::citext` : sql`${input.email}::citext`},
            ${roleToDatabase(input.role)}::public.member_role,
            ${input.tokenHash},
            ${input.expiresAt}::timestamptz
          )
          returning ${invitationColumns("")},
                    null::text as apartment_number,
                    null::text as invited_by_name
        `,
      );
      const row = parseSingleRow(rows, "created invitation");
      return invitationFromRow(row);
    });
  }

  /**
   * One page of the society's invitations, newest first.
   *
   * The issuer's name and the flat's number are joined in, and the total rides the same scan
   * (`count(*) over ()`), so a screen that says "3 of 12" costs one round trip — the same shape the
   * member directory uses. `token_hash` is nowhere in the statement, which is not a style choice:
   * the column is in no SELECT grant, so asking for it would fail with `42501`.
   */
  async list(
    societyId: SocietyId,
    actor: UserId,
    query: InvitationQuery,
  ): Promise<InvitationPage> {
    return this.run(actor, "read", async (tx) => {
      const conditions: SQL[] = [sql`i.society_id = ${societyId}::uuid`];
      if (query.status !== undefined) {
        conditions.push(sql`i.status = ${query.status}`);
      }

      const rows = await query_(
        tx,
        sql`
          select ${invitationColumns("i.")},
                 a.apartment_number as apartment_number,
                 m.display_name as invited_by_name,
                 count(*) over ()::int as total
            from public.invitations i
            left join public.apartments a
              on a.id = i.apartment_id
             and a.deleted_at is null
            left join public.members m
              on m.id = i.invited_by
           where ${sql.join(conditions, sql` and `)}
           order by i.created_at desc, i.id asc
           limit ${query.limit ?? 50} offset ${query.offset ?? 0}
        `,
      );

      const parsed = invitationRowListSchema.safeParse(rows);
      if (!parsed.success) {
        throw unexpectedShapeError("invitation list");
      }
      return {
        invitations: parsed.data.map((row) => invitationFromRow(row)),
        total: parsed.data[0]?.total ?? 0,
      };
    });
  }

  /** One invitation of one society, `null` when the caller may not see it. */
  async findById(
    id: InvitationId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<Invitation | null> {
    return this.run(actor, "read", async (tx) => {
      const rows = await query_(
        tx,
        sql`
          select ${invitationColumns("i.")},
                 a.apartment_number as apartment_number,
                 m.display_name as invited_by_name
            from public.invitations i
            left join public.apartments a
              on a.id = i.apartment_id
             and a.deleted_at is null
            left join public.members m
              on m.id = i.invited_by
           where i.id = ${id}::uuid
             and i.society_id = ${societyId}::uuid
           limit 1
        `,
      );
      const parsed = invitationRowListSchema.safeParse(rows);
      if (!parsed.success) {
        throw unexpectedShapeError("invitation");
      }
      const [row] = parsed.data;
      return row === undefined ? null : invitationFromRow(row);
    });
  }

  /**
   * Revoke — one `UPDATE` of `status`, which is the only column the grant allows.
   *
   * The stamps (`revoked_at`, `revoked_by`) and the legality of the transition are the trigger's.
   * Zero rows means the invitation is not in this society (or the caller may not see it), answered as
   * `not_found` — the same answer a missing one gets, so ids cannot be probed.
   */
  async revoke(
    id: InvitationId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<Invitation> {
    return this.run(actor, "write", async (tx) => {
      const rows = await query_(
        tx,
        sql`
          update public.invitations
             set status = 'revoked'
           where id = ${id}::uuid
             and society_id = ${societyId}::uuid
          returning ${invitationColumns("")},
                    null::text as apartment_number,
                    null::text as invited_by_name
        `,
      );
      const [row] = parseRows(rows);
      if (row === undefined) {
        throw new InvitationError(
          "not_found",
          "That invitation is not available to you.",
        );
      }
      return invitationFromRow(row);
    });
  }

  /**
   * The public preview, keyed by the token's **digest**.
   *
   * The hash travels and the token does not: this adapter cannot recompute it (it never sees the
   * token), so there is no path by which the credential could end up in a statement, a log or a query
   * plan. A malformed or unknown digest is answered `INVITATION_NOT_FOUND` by the function, which
   * this maps to `null` — "no such invitation" is this lookup's ordinary answer, and returning it as
   * an error would tempt a caller to distinguish it from a refusal.
   */
  async previewByTokenHash(
    tokenHash: string,
  ): Promise<InvitationPreview | null> {
    try {
      const rows = await this.unitOfWork.transaction(
        { kind: "anonymous" },
        async (tx) =>
          query_(
            tx,
            sql`select public.invitation_preview(${tokenHash}) as preview`,
          ),
      );
      const parsed = zPreview(rows[0]);
      return parsed === null ? null : invitationPreviewFromRow(parsed);
    } catch (error: unknown) {
      if (isInvitationError(error)) {
        throw error;
      }
      const classified = invitationErrorFromPostgres(error, "read");
      if (classified.code === "invitation_not_found") return null;
      throw classified;
    }
  }

  /**
   * Accept, as `actor`.
   *
   * One call, one transaction, one row lock — and the actor is passed *and* proven: the function
   * compares `p_actor` against `auth.uid()` before it clears the identity it writes under, so a caller
   * that tried to accept on somebody else's behalf is refused with `INVITATION_ACCEPT_DENIED` rather
   * than creating a membership on an account nobody signed into.
   */
  async accept(
    tokenHash: string,
    actor: UserId,
  ): Promise<InvitationAcceptance> {
    return this.run(
      actor,
      "accept",
      async (tx) => {
        const rows = await query_(
          tx,
          sql`select public.invitation_accept(${tokenHash}, ${actor}::uuid) as accepted`,
        );
        const parsed = invitationAcceptanceRowSchema.safeParse(
          (rows[0] as { accepted?: unknown } | undefined)?.accepted,
        );
        if (!parsed.success) {
          throw unexpectedShapeError("invitation acceptance");
        }
        return invitationAcceptanceFromRow(parsed.data);
      },
      (accepted) => ({ societyId: accepted.societyId, userIds: [actor] }),
    );
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private async run<T>(
    actor: UserId,
    context: "read" | "write" | "accept",
    work: (tx: TransactionContext) => Promise<T>,
    /** Present on the one write that changes a membership, absent on every other call. */
    cacheScope?: (result: T) => MembershipWriteScope,
  ): Promise<T> {
    const identity: TransactionActor = { kind: "user", userId: actor };
    const perform = async (): Promise<T> => {
      try {
        return await this.unitOfWork.transaction(identity, work);
      } catch (error: unknown) {
        throw isInvitationError(error)
          ? error
          : invitationErrorFromPostgres(error, context);
      }
    };

    return cacheScope === undefined
      ? perform()
      : this.invalidation.around(cacheScope, perform);
  }
}

/** The preview row, parsed where the function's `jsonb` arrives untyped. */
function zPreview(row: unknown) {
  const value = (row as { preview?: unknown } | undefined)?.preview;
  const parsed = invitationPreviewRowSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * One column list, one place — `""` for a `RETURNING` (the target table's columns are in scope
 * unqualified) and `"i."` for the joined reads.
 *
 * `token_hash` is deliberately not in it: the column is in no SELECT grant, so a statement that named
 * it would fail rather than leak.
 */
function invitationColumns(prefix: string): SQL {
  const columns = [
    "id",
    "society_id",
    "apartment_id",
    "invited_by",
    "channel",
    "phone",
    "email",
    "role",
    "status",
    "expires_at",
    "opened_at",
    "accepted_at",
    "revoked_at",
    "created_at",
  ];
  return sql.raw(
    columns.map((column) => `${prefix}${column} as ${column}`).join(", "),
  );
}

type Row = Record<string, unknown>;

async function query_(
  tx: TransactionContext,
  statement: SQL,
): Promise<readonly Row[]> {
  const rows = await tx.execute(statement);
  return rows as unknown as readonly Row[];
}

function parseRows(rows: readonly Row[]) {
  const parsed = invitationRowListSchema.safeParse(rows);
  if (!parsed.success) {
    throw unexpectedShapeError("invitation");
  }
  return parsed.data;
}

function parseSingleRow(rows: readonly Row[], what: string) {
  const [first] = rows;
  const parsed = invitationRowSchema.safeParse(first);
  if (!parsed.success) {
    throw unexpectedShapeError(what);
  }
  return parsed.data;
}
