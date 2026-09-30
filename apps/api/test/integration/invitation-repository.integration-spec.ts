import type { ApartmentId, InvitationRepository, UserId } from "@ses/domain";
import type postgres from "postgres";

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

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
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
  });
});
