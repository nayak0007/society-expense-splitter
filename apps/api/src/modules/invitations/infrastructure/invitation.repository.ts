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
  type AuditFlush,
  type TransactionActor,
  type TransactionContext,
} from "../../../infrastructure/database/unit-of-work";
import { AuditService } from "../../audit/audit.service";
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
    /**
     * T050's audit builder. The entry is handed to `UnitOfWork`'s seam rather than
     * written here, so it commits or rolls back with the invitation change itself
     * (ADR-0014 D1).
     */
    private readonly audit: AuditService,
  ) {}

  /** Insert one invitation. `status` is the column's default (`sent`), and `invited_by` is the trigger's. */
  async create(
    societyId: SocietyId,
    input: CreateInvitationInput,
    actor: UserId,
  ): Promise<Invitation> {
    return this.run(
      actor,
      "write",
      async (tx) => {
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
      },
      undefined,
      // T050: a birth has no `before` — the minted row did not exist a moment ago.
      (invitation) => [
        this.audit.entry({
          societyId: invitation.societyId,
          category: "other",
          action: "invitation.created",
          entityType: "invitation",
          entityId: invitation.id,
          before: null,
          after: invitationAuditSnapshot(invitation),
        }),
      ],
    );
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
    // The pre-revocation status, read inside the transaction that revokes (T050).
    let before: Record<string, unknown> | null = null;

    return this.run(
      actor,
      "write",
      async (tx) => {
        before = await readInvitationAuditState(tx, id, societyId);
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
      },
      // No cache scope: a revocation changes no membership, so it must not bump the
      // society's membership version the way the acceptance above does.
      undefined,
      (invitation) => [
        this.audit.entry({
          societyId: invitation.societyId,
          category: "other",
          action: "invitation.revoked",
          entityType: "invitation",
          entityId: invitation.id,
          before,
          after: invitationAuditSnapshot(invitation),
        }),
      ],
    );
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
      //
      // T050: keyed to the **membership** the function produced, because the
      // invitation row itself is unaddressable from this call site — the caller holds
      // only the token digest, and `token_hash` is in no SELECT grant. `before` is
      // `null`: the row did not exist a moment ago, so this is a birth, and its
      // `after` is the facts `invitation_accept()` reported it created.
      //
      // The RPC clears the transaction's identity before it writes that membership;
      // `UnitOfWork` re-establishes the actor for this audit phase, so the writer's
      // actor check is satisfied rather than refused (ADR-0014 D5, D10).
      (accepted) => [
        this.audit.entry({
          societyId: accepted.societyId,
          category: "other",
          action: "invitation.accepted",
          entityType: "member",
          entityId: accepted.memberId,
          before: null,
          after: invitationAcceptanceAuditSnapshot(accepted),
        }),
      ],
    );
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private async run<T>(
    actor: UserId,
    context: "read" | "write" | "accept",
    work: (tx: TransactionContext) => Promise<T>,
    /** Present on the one write that changes a membership, absent on every other call. */
    cacheScope?: (result: T) => MembershipWriteScope,
    /** Present on every audited write, absent on reads (T050). */
    audit?: AuditFlush<T>,
  ): Promise<T> {
    const identity: TransactionActor = { kind: "user", userId: actor };
    const perform = async (): Promise<T> => {
      try {
        return await this.unitOfWork.transaction(identity, work, audit);
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

/**
 * The invitation facts an audit entry records (T050).
 *
 * The contact columns are deliberately absent: `phone` and `email` are in the
 * redaction rule's deny-list, so persisting them would store `[redacted]` under two
 * keys and tell a reader nothing while implying it might have said something. The
 * `token_hash` is not readable by this role at all.
 */
function invitationAuditSnapshot(
  invitation: Invitation,
): Record<string, unknown> {
  return {
    channel: invitation.channel,
    role: roleToDatabase(invitation.role),
    status: invitation.status,
    apartmentId: invitation.apartmentId,
    expiresAt: invitation.expiresAt,
  };
}

/**
 * The membership an acceptance produced (T050).
 *
 * Composed from `invitation_accept()`'s own return rather than re-read: that
 * function is the authority on what it wrote, and it reports the persisted role,
 * flat and whether a live shadow was linked. The audit callback runs after `work`
 * has returned and is deliberately synchronous, so deriving the snapshot from the
 * result is the shape the seam is built for (ADR-0014 D7). `linkedShadow` travels
 * because it is the difference between an Admin's recorded occupant gaining an
 * account and a duplicate being created — the fact most worth a durable record.
 */
function invitationAcceptanceAuditSnapshot(
  acceptance: InvitationAcceptance,
): Record<string, unknown> {
  return {
    role: roleToDatabase(acceptance.role),
    apartmentId: acceptance.apartmentId,
    linkedShadow: acceptance.linkedShadow,
  };
}

/**
 * The invitation's pre-write state, read inside the caller's transaction (T050).
 *
 * A plain read and never a lock: the transition's legality is the trigger's, so a
 * row that moved between this read and the `UPDATE` is refused by the trigger and
 * the transaction — audit row included — rolls back.
 */
async function readInvitationAuditState(
  tx: TransactionContext,
  id: InvitationId,
  societyId: SocietyId,
): Promise<Record<string, unknown> | null> {
  const rows = await query_(
    tx,
    sql`
      select channel::text as channel,
             role::text as role,
             status::text as status,
             apartment_id,
             expires_at
        from public.invitations
       where id = ${id}::uuid
         and society_id = ${societyId}::uuid
       limit 1
    `,
  );
  return rows[0] ?? null;
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
