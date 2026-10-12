import { sql } from "drizzle-orm";
import type { ApartmentId, InvitationRepository, UserId } from "@ses/domain";
import type postgres from "postgres";

import { buildAuditEntry } from "../../src/common/audit/audit-context";
import type { TransactionContext } from "../../src/infrastructure/database/unit-of-work";
import { INVITATION_REPOSITORY } from "../../src/modules/invitations/application/invitation.tokens";

import { createLocalUser, resetData } from "../utils/integration-db";
import {
  insertApartment,
  insertBuilding,
  insertMember,
  seedSociety,
  type SocietyFixture,
} from "../utils/integration-fixtures";
import {
  startIntegrationHarness,
  type IntegrationHarness,
} from "../utils/integration-harness";

/**
 * `InvitationRepositoryPostgres` against real PostgreSQL and real RLS.
 *
 * The adapter itself decides nothing about invitations — the triggers, the
 * `preview` projection and the atomic `accept` function own the rules. What is
 * worth asserting here is the *seam*: the row it writes (status default, the
 * joined labels it honestly reports as `null`), the column grants it runs under
 * (`token_hash` is write-only), the RLS scoping on the manager reads, the
 * funnel step a preview performs, and every refusal the database raises —
 * asserted as the module's own error code, never as PostgreSQL's wording.
 */

let harness: IntegrationHarness;
let owner: postgres.Sql;
let invitations: InvitationRepository;
let unitOfWork: IntegrationHarness["unitOfWork"];

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  unitOfWork = harness.unitOfWork;
  invitations = harness.app.get<InvitationRepository>(INVITATION_REPOSITORY);
}, 60_000);

afterAll(async () => {
  await harness.stop();
});

/** A deterministic sha256-shaped digest — the column CHECK requires exactly this. */
function tokenHash(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

interface Fixture extends SocietyFixture {
  readonly buildingId: Awaited<ReturnType<typeof insertBuilding>>;
  readonly flat101: ApartmentId;
  /** An active ordinary member — not a manager. */
  readonly residentUserId: UserId;
}

async function seed(): Promise<Fixture> {
  const society = await seedSociety(harness);
  const buildingId = await insertBuilding(owner, society.societyId, "A Wing");
  const flat101 = await insertApartment(
    owner,
    society.societyId,
    buildingId,
    "101",
    1,
  );
  const residentUserId = (await createLocalUser(
    owner,
    "resident@invite.ses.test",
    "Resident",
  )) as UserId;
  await insertMember(owner, society.societyId, {
    userId: residentUserId,
    displayName: "Resident",
    phone: "+919876500301",
    role: "resident",
  });
  return { ...society, buildingId, flat101, residentUserId };
}

async function rejection(
  promise: Promise<unknown>,
): Promise<{ code?: unknown; details?: unknown }> {
  try {
    await promise;
  } catch (error: unknown) {
    return error as { code?: unknown; details?: unknown };
  }
  throw new Error("Expected the call to reject, but it resolved.");
}

/** The identity a transaction is running as, read from inside it. */
interface Identity {
  readonly uid: string | null;
  readonly sub: string | null;
  readonly claims: string | null;
}

async function identity(tx: TransactionContext): Promise<Identity> {
  const rows = (await tx.execute(sql`
    select (select auth.uid())::text as uid,
           nullif(current_setting('request.jwt.claim.sub', true), '') as sub,
           nullif(current_setting('request.jwt.claims', true), '') as claims
  `)) as unknown as readonly Record<string, string | null>[];
  const row = rows[0] ?? {};
  return {
    uid: row["uid"] ?? null,
    sub: row["sub"] ?? null,
    claims: row["claims"] ?? null,
  };
}

describe("InvitationRepositoryPostgres", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    await resetData(owner);
    fixture = await seed();
  });

  describe("create", () => {
    it("records a sent invitation and honestly reports its unjoined labels as null", async () => {
      const invitation = await invitations.create(
        fixture.societyId,
        {
          channel: "link",
          role: "resident",
          email: null,
          phone: null,
          apartmentId: fixture.flat101,
          tokenHash: tokenHash(1),
          expiresAt: inDays(14),
        },
        fixture.adminUserId,
      );

      expect(invitation).toMatchObject({
        societyId: fixture.societyId,
        channel: "link",
        role: "resident",
        status: "sent",
        email: null,
        phone: null,
        apartmentId: fixture.flat101,
        // A `RETURNING` on the base table has neither of these joined, and the
        // adapter says so rather than inventing them.
        apartmentNumber: null,
        invitedByName: null,
        openedAt: null,
        acceptedAt: null,
        revokedAt: null,
      });
      // The inviter is the trigger's own resolution of the caller's membership.
      expect(invitation.invitedBy).toBe(fixture.adminMemberId);

      // The digest is stored, and it is the only thing stored — the raw token
      // never reaches SQL.
      const [row] = await owner<{ token_hash: string }[]>`
        select token_hash from public.invitations where id = ${invitation.id}::uuid
      `;
      expect(row?.token_hash).toBe(tokenHash(1));
    });

    it("stores the domain role through the database's own spelling", async () => {
      const invitation = await invitations.create(
        fixture.societyId,
        {
          channel: "email",
          role: "committee_member",
          email: "committee@invite.ses.test",
          phone: null,
          apartmentId: null,
          tokenHash: tokenHash(2),
          expiresAt: inDays(7),
        },
        fixture.adminUserId,
      );

      // `committee_member` is the domain's name for the column's `committee`.
      expect(invitation.role).toBe("committee_member");
      const [row] = await owner<{ role: string }[]>`
        select role::text as role from public.invitations where id = ${invitation.id}::uuid
      `;
      expect(row?.role).toBe("committee");
    });

    it("refuses a second live invitation for the same address", async () => {
      await invitations.create(
        fixture.societyId,
        {
          channel: "email",
          role: "resident",
          email: "twice@invite.ses.test",
          phone: null,
          apartmentId: null,
          tokenHash: tokenHash(3),
          expiresAt: inDays(7),
        },
        fixture.adminUserId,
      );

      const error = await rejection(
        invitations.create(
          fixture.societyId,
          {
            channel: "email",
            role: "resident",
            email: "twice@invite.ses.test",
            phone: null,
            apartmentId: null,
            tokenHash: tokenHash(4),
            expiresAt: inDays(7),
          },
          fixture.adminUserId,
        ),
      );
      expect(error.code).toBe("conflict");
      expect(error.details).toMatchObject({ field: "email" });
    });

    it("refuses to invite somebody who already has an account in the society", async () => {
      const error = await rejection(
        invitations.create(
          fixture.societyId,
          {
            channel: "email",
            role: "resident",
            email: "resident@invite.ses.test",
            phone: null,
            apartmentId: null,
            tokenHash: tokenHash(5),
            expiresAt: inDays(7),
          },
          fixture.adminUserId,
        ),
      );
      expect(error.code).toBe("invitation_recipient_already_member");
    });

    it("refuses a shareable link at a role above Resident", async () => {
      const error = await rejection(
        invitations.create(
          fixture.societyId,
          {
            channel: "link",
            role: "admin",
            email: null,
            phone: null,
            apartmentId: null,
            tokenHash: tokenHash(6),
            expiresAt: inDays(7),
          },
          fixture.adminUserId,
        ),
      );
      expect(error.code).toBe("invitation_open_link_role");
      expect(error.details).toMatchObject({ field: "role" });
    });
  });

  describe("reads", () => {
    it("lists newest first with the flat number and inviter name, filtered by status", async () => {
      const first = await invitations.create(
        fixture.societyId,
        {
          channel: "email",
          role: "resident",
          email: "first@invite.ses.test",
          phone: null,
          apartmentId: fixture.flat101,
          tokenHash: tokenHash(7),
          expiresAt: inDays(7),
        },
        fixture.adminUserId,
      );
      // Deterministic ordering: backdate the first row rather than race the clock.
      await owner`
        update public.invitations set created_at = now() - interval '1 day'
         where id = ${first.id}::uuid
      `;
      const second = await invitations.create(
        fixture.societyId,
        {
          channel: "email",
          role: "treasurer",
          email: "second@invite.ses.test",
          phone: null,
          apartmentId: null,
          tokenHash: tokenHash(8),
          expiresAt: inDays(7),
        },
        fixture.adminUserId,
      );
      await invitations.revoke(
        second.id,
        fixture.societyId,
        fixture.adminUserId,
      );

      const all = await invitations.list(
        fixture.societyId,
        fixture.adminUserId,
        {},
      );
      expect(all.total).toBe(2);
      expect(all.invitations.map((row) => row.id)).toEqual([
        second.id,
        first.id,
      ]);
      expect(all.invitations[1]).toMatchObject({
        id: first.id,
        apartmentNumber: "101",
        invitedByName: "Admin",
        role: "resident",
      });

      const live = await invitations.list(
        fixture.societyId,
        fixture.adminUserId,
        { status: "sent", limit: 10, offset: 0 },
      );
      expect(live.total).toBe(1);
      expect(live.invitations.map((row) => row.id)).toEqual([first.id]);
    });

    it("shows a plain member nothing rather than an error (RLS, not a 403)", async () => {
      await invitations.create(
        fixture.societyId,
        {
          channel: "link",
          role: "resident",
          email: null,
          phone: null,
          apartmentId: null,
          tokenHash: tokenHash(9),
          expiresAt: inDays(7),
        },
        fixture.adminUserId,
      );

      expect(
        await invitations.list(fixture.societyId, fixture.residentUserId, {}),
      ).toEqual({ invitations: [], total: 0 });
    });

    it("returns one invitation of this society, and null across societies", async () => {
      const invitation = await invitations.create(
        fixture.societyId,
        {
          channel: "link",
          role: "resident",
          email: null,
          phone: null,
          apartmentId: null,
          tokenHash: tokenHash(10),
          expiresAt: inDays(7),
        },
        fixture.adminUserId,
      );

      expect(
        await invitations.findById(
          invitation.id,
          fixture.societyId,
          fixture.adminUserId,
        ),
      ).toMatchObject({ id: invitation.id, status: "sent" });

      const other = await seedSociety(
        harness,
        "Other Court",
        "other@invite.ses.test",
      );
      expect(
        await invitations.findById(
          invitation.id,
          other.societyId,
          other.adminUserId,
        ),
      ).toBeNull();
    });
  });

  describe("revoke", () => {
    it("marks the invitation revoked with the trigger's stamp, and that is terminal", async () => {
      const invitation = await invitations.create(
        fixture.societyId,
        {
          channel: "link",
          role: "resident",
          email: null,
          phone: null,
          apartmentId: null,
          tokenHash: tokenHash(11),
          expiresAt: inDays(7),
        },
        fixture.adminUserId,
      );

      const revoked = await invitations.revoke(
        invitation.id,
        fixture.societyId,
        fixture.adminUserId,
      );
      expect(revoked.status).toBe("revoked");
      expect(revoked.revokedAt).not.toBeNull();

      // A revoked invitation can never be accepted.
      const declined = await rejection(
        invitations.accept(tokenHash(11), fixture.residentUserId),
      );
      expect(declined.code).toBe("invitation_not_acceptable");
    });

    it("answers not_found for an unknown id and for a member who is not a manager", async () => {
      const unknown = await rejection(
        invitations.revoke(
          "00000000-0000-4000-8000-000000000000" as never,
          fixture.societyId,
          fixture.adminUserId,
        ),
      );
      expect(unknown.code).toBe("not_found");

      const invitation = await invitations.create(
        fixture.societyId,
        {
          channel: "link",
          role: "resident",
          email: null,
          phone: null,
          apartmentId: null,
          tokenHash: tokenHash(12),
          expiresAt: inDays(7),
        },
        fixture.adminUserId,
      );
      const notManager = await rejection(
        invitations.revoke(
          invitation.id,
          fixture.societyId,
          fixture.residentUserId,
        ),
      );
      expect(notManager.code).toBe("not_found");
    });
  });

  describe("preview", () => {
    it("returns the masked projection for a valid digest and moves sent to opened", async () => {
      await invitations.create(
        fixture.societyId,
        {
          channel: "email",
          role: "resident",
          email: "previewed@invite.ses.test",
          phone: null,
          apartmentId: null,
          tokenHash: tokenHash(13),
          expiresAt: inDays(7),
        },
        fixture.adminUserId,
      );

      const preview = await invitations.previewByTokenHash(tokenHash(13));

      expect(preview).toMatchObject({
        societyId: fixture.societyId,
        societyName: "Alpha Court",
        role: "resident",
        inviteeHint: "pr***@invite.ses.test",
        requiresAccountMatch: true,
        status: "opened",
        expired: false,
      });
      // The funnel's first step is recorded, and only once.
      const [row] = await owner<{ status: string; opened_at: string | null }[]>`
        select status, opened_at from public.invitations
         where token_hash = ${tokenHash(13)}
      `;
      expect(row?.status).toBe("opened");
      expect(row?.opened_at).not.toBeNull();

      // An unaddressed link masks as "anyone" and does not require a match.
      await invitations.create(
        fixture.societyId,
        {
          channel: "link",
          role: "resident",
          email: null,
          phone: null,
          apartmentId: null,
          tokenHash: tokenHash(14),
          expiresAt: inDays(7),
        },
        fixture.adminUserId,
      );
      const open = await invitations.previewByTokenHash(tokenHash(14));
      expect(open).toMatchObject({
        inviteeHint: "Anyone with this link",
        requiresAccountMatch: false,
      });
    });

    it("answers null for an unknown digest and for a malformed one", async () => {
      expect(await invitations.previewByTokenHash(tokenHash(999))).toBeNull();
      // Not a sha256 hex digest — the function refuses it, and the adapter reads
      // that as "no such invitation", never as an error to distinguish.
      expect(await invitations.previewByTokenHash("not-a-digest")).toBeNull();
    });

    it("reports expiry for a live invitation whose moment has passed", async () => {
      await invitations.create(
        fixture.societyId,
        {
          channel: "link",
          role: "resident",
          email: null,
          phone: null,
          apartmentId: null,
          tokenHash: tokenHash(15),
          expiresAt: inDays(1),
        },
        fixture.adminUserId,
      );
      // Backdate through the owner: the insert CHECK keeps a live row from being
      // created already-expired, which is exactly the state a preview must report.
      await owner`
        update public.invitations
           set created_at = now() - interval '20 days',
               expires_at = now() - interval '6 days'
         where token_hash = ${tokenHash(15)}
      `;

      const preview = await invitations.previewByTokenHash(tokenHash(15));
      expect(preview).toMatchObject({ status: "expired", expired: true });
    });
  });

  describe("accept", () => {
    it("admits the holder of an unaddressed link, creating one active membership", async () => {
      const inviteeUserId = (await createLocalUser(
        owner,
        "invitee@invite.ses.test",
        "Invitee",
      )) as UserId;
      const invitation = await invitations.create(
        fixture.societyId,
        {
          channel: "link",
          role: "resident",
          email: null,
          phone: null,
          apartmentId: fixture.flat101,
          tokenHash: tokenHash(16),
          expiresAt: inDays(7),
        },
        fixture.adminUserId,
      );

      const accepted = await invitations.accept(tokenHash(16), inviteeUserId);
      expect(accepted).toMatchObject({
        societyId: fixture.societyId,
        role: "resident",
        apartmentId: fixture.flat101,
        linkedShadow: false,
      });

      const [member] = await owner<
        {
          status: string;
          role: string;
          apartment_id: string | null;
          joined_at: string | null;
          approved_by: string | null;
        }[]
      >`
        select status, role::text as role, apartment_id, joined_at, approved_by
          from public.members where id = ${accepted.memberId}::uuid
      `;
      expect(member).toMatchObject({
        status: "active",
        role: "resident",
        apartment_id: fixture.flat101,
        approved_by: fixture.adminMemberId,
      });
      expect(member?.joined_at).not.toBeNull();

      // Single use: the row is accepted, and the invitation refuses a replay.
      const [invitationRow] = await owner<{ status: string }[]>`
        select status from public.invitations where id = ${invitation.id}::uuid
      `;
      expect(invitationRow?.status).toBe("accepted");
      const replay = await rejection(
        invitations.accept(tokenHash(16), inviteeUserId),
      );
      expect(replay.code).toBe("invitation_not_acceptable");
    });

    it("refuses an expired invitation", async () => {
      const inviteeUserId = (await createLocalUser(
        owner,
        "late@invite.ses.test",
        "Late",
      )) as UserId;
      await invitations.create(
        fixture.societyId,
        {
          channel: "link",
          role: "resident",
          email: null,
          phone: null,
          apartmentId: null,
          tokenHash: tokenHash(17),
          expiresAt: inDays(1),
        },
        fixture.adminUserId,
      );
      await owner`
        update public.invitations
           set created_at = now() - interval '20 days',
               expires_at = now() - interval '6 days'
         where token_hash = ${tokenHash(17)}
      `;

      const error = await rejection(
        invitations.accept(tokenHash(17), inviteeUserId),
      );
      expect(error.code).toBe("invitation_expired");
    });

    it("refuses a targeted invitation accepted by the wrong account", async () => {
      const wrongUserId = (await createLocalUser(
        owner,
        "wrong@invite.ses.test",
        "Wrong Person",
      )) as UserId;
      await invitations.create(
        fixture.societyId,
        {
          channel: "email",
          role: "resident",
          email: "intended@invite.ses.test",
          phone: null,
          apartmentId: null,
          tokenHash: tokenHash(18),
          expiresAt: inDays(7),
        },
        fixture.adminUserId,
      );

      const error = await rejection(
        invitations.accept(tokenHash(18), wrongUserId),
      );
      expect(error.code).toBe("invitation_recipient_mismatch");
    });

    it("admits the account the invitation names", async () => {
      const intendedUserId = (await createLocalUser(
        owner,
        "intended@invite.ses.test",
        "Intended",
      )) as UserId;
      await invitations.create(
        fixture.societyId,
        {
          channel: "email",
          role: "tenant",
          email: "intended@invite.ses.test",
          phone: null,
          apartmentId: null,
          tokenHash: tokenHash(19),
          expiresAt: inDays(7),
        },
        fixture.adminUserId,
      );

      const accepted = await invitations.accept(tokenHash(19), intendedUserId);
      expect(accepted).toMatchObject({ role: "tenant", linkedShadow: false });
    });

    it("refuses an invitation to somebody who is already an active member", async () => {
      await invitations.create(
        fixture.societyId,
        {
          channel: "link",
          role: "resident",
          email: null,
          phone: null,
          apartmentId: null,
          tokenHash: tokenHash(20),
          expiresAt: inDays(7),
        },
        fixture.adminUserId,
      );

      const error = await rejection(
        invitations.accept(tokenHash(20), fixture.residentUserId),
      );
      expect(error.code).toBe("invitation_already_member");
    });

    it("refuses to resurrect a removed membership through an invitation", async () => {
      const removedUserId = (await createLocalUser(
        owner,
        "removed@invite.ses.test",
        "Removed",
      )) as UserId;
      await insertMember(owner, fixture.societyId, {
        userId: removedUserId,
        displayName: "Removed",
        status: "removed",
      });
      await invitations.create(
        fixture.societyId,
        {
          channel: "link",
          role: "resident",
          email: null,
          phone: null,
          apartmentId: null,
          tokenHash: tokenHash(21),
          expiresAt: inDays(7),
        },
        fixture.adminUserId,
      );

      const error = await rejection(
        invitations.accept(tokenHash(21), removedUserId),
      );
      expect(error.code).toBe("invitation_membership_removed");
    });

    /**
     * The identity the acceptance transaction runs as — T050 Stage B, ADR-0014.
     *
     * `public.invitation_accept()` blanks `request.jwt.claim.sub` and
     * `request.jwt.claims` (transaction-locally) so that its own membership write is
     * not read as a self-service change by `chk_member_self_change()`. The clear is
     * deliberate and is *not* undone inside the function; what the seam guarantees is
     * that the actor is re-established **before the audit flush**, so the writer's
     * actor check is satisfied rather than refused (ADR-0014 D5).
     */
    it("clears the transaction's identity while it writes the membership", async () => {
      const inviteeUserId = (await createLocalUser(
        owner,
        "identity@invite.ses.test",
        "Identity",
      )) as UserId;
      await invitations.create(
        fixture.societyId,
        {
          channel: "link",
          role: "resident",
          email: null,
          phone: null,
          apartmentId: null,
          tokenHash: tokenHash(22),
          expiresAt: inDays(7),
        },
        fixture.adminUserId,
      );

      const timeline = await unitOfWork.transaction(
        { kind: "user", userId: inviteeUserId },
        async (tx) => {
          const before = await identity(tx);
          await tx.execute(
            sql`select public.invitation_accept(${tokenHash(22)}, ${inviteeUserId}::uuid) as accepted`,
          );
          const after = await identity(tx);
          return { before, after };
        },
      );

      expect(timeline.before.uid).toBe(inviteeUserId);
      expect(timeline.before.sub).toBe(inviteeUserId);
      expect(JSON.parse(timeline.before.claims ?? "null")).toEqual({
        sub: inviteeUserId,
        role: "authenticated",
      });
      // The RPC's clear is real and transaction-local: inside `work`, after it
      // returns, the transaction is nobody. That is exactly why the seam — not the
      // call site — has to put the actor back (asserted below, and end to end in
      // "records the acceptance as an audit row, keyed to the membership …").
      expect(timeline.after).toEqual({ uid: null, sub: null, claims: null });
    });

    /**
     * The seam that closes the blocker, at its narrowest: a transaction whose `work`
     * clears the identity exactly as `invitation_accept()` does still records its
     * audit batch, because `UnitOfWork` re-establishes the actor before the flush.
     * Without that re-application the writer would compare the entry's actor against
     * a blank `request.jwt.claim.sub` and raise `AUDIT_ACTOR_MISMATCH`.
     */
    it("re-establishes the actor before the audit flush, so a cleared transaction still records", async () => {
      const actor = (await createLocalUser(
        owner,
        "seam@invite.ses.test",
        "Seam",
      )) as UserId;
      const entry = buildAuditEntry({
        societyId: fixture.societyId,
        category: "other",
        action: "society.updated",
        entityType: "society",
        entityId: fixture.societyId,
        before: null,
        after: { name: "Seam Court" },
      });

      await unitOfWork.transaction(
        { kind: "user", userId: actor },
        async (tx) => {
          await tx.execute(
            sql`select set_config('request.jwt.claim.sub', '', true)`,
          );
          await tx.execute(
            sql`select set_config('request.jwt.claims', '', true)`,
          );
        },
        () => [entry],
      );

      const rows = await owner<{ actor_user_id: string | null }[]>`
        select actor_user_id from public.audit_logs order by id
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_user_id).toBe(actor);
    });

    /**
     * A nested transaction cannot change what the flush records. The ordering is
     * pinned by the unit suite; this proves the property against real PostgreSQL
     * savepoints. A savepoint that clears the identity — the shape a nested
     * transaction or an RPC takes — is still overridden by the outer transaction's
     * restoration, and the row carries the outer actor.
     */
    it("records the outer actor even when a nested savepoint clears the identity", async () => {
      const actor = (await createLocalUser(
        owner,
        "nested@invite.ses.test",
        "Nested",
      )) as UserId;
      const entry = buildAuditEntry({
        societyId: fixture.societyId,
        category: "other",
        action: "society.updated",
        entityType: "society",
        entityId: fixture.societyId,
        before: null,
        after: { name: "Nested Court" },
      });

      await unitOfWork.transaction(
        { kind: "user", userId: actor },
        async (tx) => {
          await tx.transaction(async (inner) => {
            await inner.execute(
              sql`select set_config('request.jwt.claim.sub', '', true)`,
            );
            await inner.execute(
              sql`select set_config('request.jwt.claims', '', true)`,
            );
          });
        },
        () => [entry],
      );

      const rows = await owner<{ actor_user_id: string | null }[]>`
        select actor_user_id from public.audit_logs order by id
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_user_id).toBe(actor);
    });

    it("records the acceptance as an audit row, keyed to the membership it produced", async () => {
      const inviteeUserId = (await createLocalUser(
        owner,
        "audited@invite.ses.test",
        "Audited",
      )) as UserId;
      await invitations.create(
        fixture.societyId,
        {
          channel: "link",
          role: "resident",
          email: null,
          phone: null,
          apartmentId: fixture.flat101,
          tokenHash: tokenHash(23),
          expiresAt: inDays(7),
        },
        fixture.adminUserId,
      );

      const accepted = await invitations.accept(tokenHash(23), inviteeUserId);

      const rows = await owner<
        {
          action: string;
          actor_user_id: string | null;
          category: string;
          entity_type: string;
          entity_id: string | null;
          before: unknown;
          after: Record<string, unknown> | null;
          metadata: Record<string, unknown> | null;
        }[]
      >`
        select action, actor_user_id, category, entity_type, entity_id,
               "before", "after", metadata
          from public.audit_logs
         where action = 'invitation.accepted'
         order by id
      `;

      // Exactly one acceptance row, in the same transaction as the membership it
      // describes. (The `create` above wrote its own `invitation.created` row in its
      // own transaction; the filter is what makes this assertion about acceptance.)
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "invitation.accepted",
        actor_user_id: inviteeUserId,
        category: "other",
        entity_type: "member",
        entity_id: accepted.memberId,
        before: null,
        after: {
          role: "resident",
          apartmentId: fixture.flat101,
          linkedShadow: false,
        },
      });
      // The digest is the credential's fingerprint, and the invitation itself is
      // unaddressable from this call site: neither may appear in any payload.
      expect(JSON.stringify(rows[0])).not.toContain(tokenHash(23));
      expect(rows[0]?.metadata).not.toHaveProperty("tokenHash");
    });

    it("commits the acceptance and its audit row together, or neither", async () => {
      const inviteeUserId = (await createLocalUser(
        owner,
        "locked@invite.ses.test",
        "Locked",
      )) as UserId;
      await invitations.create(
        fixture.societyId,
        {
          channel: "link",
          role: "resident",
          email: null,
          phone: null,
          apartmentId: null,
          tokenHash: tokenHash(24),
          expiresAt: inDays(7),
        },
        fixture.adminUserId,
      );

      // Make the *audit* write the statement that cannot happen: without the writer's
      // EXECUTE grant the flush fails, and the acceptance must go with it (ADR-0014
      // D1's fail-closed direction). Restored in `finally` so no later test inherits
      // the lockout.
      await owner`revoke execute on function public.write_audit_logs(jsonb) from ses_api`;
      try {
        // `rejection` throws if the promise resolves, which is the other half of
        // the assertion: an acceptance that survived a failed audit write would be
        // exactly the inversion ADR-0014 D1 forbids.
        await rejection(invitations.accept(tokenHash(24), inviteeUserId));
      } finally {
        await owner`grant execute on function public.write_audit_logs(jsonb) to ses_api`;
      }

      // Rolled back together: no membership, no audit row, and the invitation is
      // still exactly where it was.
      const members = await owner<
        { id: string }[]
      >`select id from public.members where user_id = ${inviteeUserId}::uuid`;
      expect(members).toHaveLength(0);
      const audits = await owner<{ id: string }[]>`
        select id from public.audit_logs where action = 'invitation.accepted'
      `;
      expect(audits).toHaveLength(0);
      const [invitation] = await owner<{ status: string }[]>`
        select status from public.invitations where token_hash = ${tokenHash(24)}
      `;
      expect(invitation?.status).toBe("sent");
    });
  });
});
