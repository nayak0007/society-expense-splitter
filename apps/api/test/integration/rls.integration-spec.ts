import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import type { TransactionContext } from "../../src/infrastructure/database/unit-of-work";

import { createLocalUser, resetData } from "../utils/integration-db";
import {
  startIntegrationHarness,
  type IntegrationHarness,
} from "../utils/integration-harness";

/**
 * Row Level Security through the app's own transaction boundary — Roadmap T034.
 *
 * Why this belongs to an integration suite and not to a repository unit test: the
 * policies are the boundary. SAD §8.7 is explicit that they are primary rather
 * than defence in depth, because the anon key ships in the app bundle — so what
 * matters is what PostgreSQL decides for a given `auth.uid()`, and no amount of
 * testing against a fake repository can produce that answer.
 *
 * In the canonical CI canary these assertions run as SQL under a psql preamble.
 * Here they run through `UnitOfWork`, which is the point: the preamble the canary
 * *simulates* is the one this suite actually uses, so a drift between the two
 * fails here rather than in production.
 */

let harness: IntegrationHarness;
let owner: IntegrationHarness["owner"];
let unitOfWork: IntegrationHarness["unitOfWork"];

/** Fixture ids, established once per test as the owner (RLS-exempt). */
interface Fixtures {
  readonly memberUserId: string;
  readonly strangerUserId: string;
  readonly societyId: string;
  readonly otherSocietyId: string;
}

async function rows<T = Record<string, unknown>>(
  tx: TransactionContext,
  query: SQL,
): Promise<readonly T[]> {
  return (await tx.execute(query)) as unknown as readonly T[];
}

async function seed(): Promise<Fixtures> {
  const memberUserId = await createLocalUser(
    owner,
    "member@rls.ses.test",
    "Member",
  );
  const strangerUserId = await createLocalUser(
    owner,
    "stranger@rls.ses.test",
    "Stranger",
  );
  // The second society's creator: an account in no other assertion below, which
  // is what keeps "only the policies separate the two societies" true.
  const builderUserId = await createLocalUser(
    owner,
    "builder@rls.ses.test",
    "Builder",
  );

  // Both societies are created through the real RPC, so membership is not what
  // separates them — only the policies are.
  const societyId = await unitOfWork.transaction(
    { kind: "user", userId: memberUserId },
    async (tx) => {
      const [created] = await rows<{ value: string }>(
        tx,
        sql`select (public.society_create(jsonb_build_object(
              'name', 'Alpha Court', 'type', 'apartment', 'city', 'Pune', 'state', 'MH'
            )))->'society'->>'id' as value`,
      );
      return created!.value;
    },
  );

  // A second society for the cross-tenant assertions. It cannot be inserted as the
  // owner — `societies.created_by` is NOT NULL and the write trigger seeds an Admin
  // membership from that identity — so it is created by a third account through the
  // same RPC. (The canary's owner-insert shortcut is valid only for tables with no
  // identity column, like buildings and flats.)
  const otherSocietyId = await unitOfWork.transaction(
    { kind: "user", userId: builderUserId },
    async (tx) => {
      const [created] = await rows<{ value: string }>(
        tx,
        sql`select (public.society_create(jsonb_build_object(
              'name', 'Beta Court', 'type', 'apartment', 'city', 'Pune', 'state', 'MH'
            )))->'society'->>'id' as value`,
      );
      return created!.value;
    },
  );

  return {
    memberUserId,
    strangerUserId,
    societyId,
    otherSocietyId,
  };
}

beforeAll(async () => {
  harness = await startIntegrationHarness();
  owner = harness.owner;
  unitOfWork = harness.unitOfWork;
}, 60_000);

afterAll(async () => {
  await harness.stop();
});

describe("tenancy policies", () => {
  let fixtures: Fixtures;

  beforeEach(async () => {
    await resetData(owner);
    fixtures = await seed();
  });

  it("shows a member their own society and nothing else", async () => {
    const visible = await unitOfWork.transaction(
      { kind: "user", userId: fixtures.memberUserId },
      (tx) =>
        rows<{ name: string }>(tx, sql`select name from public.societies`),
    );

    // `society_create` makes the creator an Admin, so exactly one row is visible —
    // the second society exists and is deliberately not returned.
    expect(visible.map((row) => row.name)).toEqual(["Alpha Court"]);
  });

  it("shows a stranger no society at all, rather than an error", async () => {
    // The PRD rule the policies encode: a non-member learns *nothing*. A refusal
    // that named the society would confirm it exists, which is the enumeration
    // channel T041 closes — so the assertion is on an empty set, not on a throw.
    const visible = await unitOfWork.transaction(
      { kind: "user", userId: fixtures.strangerUserId },
      (tx) => rows(tx, sql`select id from public.societies`),
    );

    expect(visible).toEqual([]);
  });

  it("shows an anonymous caller no society at all", async () => {
    const visible = await unitOfWork.transaction({ kind: "anonymous" }, (tx) =>
      rows(tx, sql`select id from public.societies`),
    );

    expect(visible).toEqual([]);
  });

  it("refuses a cross-tenant update by matching zero rows", async () => {
    // An UPDATE the policy filters matches no row, so the refusal is silent by
    // design — and the owner read afterwards is what proves nothing changed.
    await unitOfWork.transaction(
      { kind: "user", userId: fixtures.memberUserId },
      (tx) =>
        rows(
          tx,
          sql`update public.societies set name = 'Hijacked' where id = ${fixtures.otherSocietyId}::uuid`,
        ),
    );

    const [row] = await owner<{ name: string }[]>`
      select name from public.societies where id = ${fixtures.otherSocietyId}
    `;
    expect(row?.name).toBe("Beta Court");
  });

  it("shows a pending member the society they applied to, and only that one", async () => {
    // A pending membership is the state every applicant is in. The row is added as
    // the owner in `pending`, mirroring the self-join policy's landing state.
    //
    // The visibility is deliberate, and the first execution of this suite asserted
    // its opposite: `societies_select_member` uses `is_society_member(id, false)`
    // so the "waiting for approval" screen can show the society's name, and
    // requiring an ACTIVE membership would blank that screen. What active scoping
    // does hide (buildings, flats, the roster beyond one's own row) is asserted by
    // the CI canary, not here.
    const pendingUserId = await createLocalUser(
      owner,
      "pending@rls.ses.test",
      "Pending",
    );
    await owner`
      insert into public.members (society_id, user_id, display_name, status, role)
      values (${fixtures.societyId}::uuid, ${pendingUserId}::uuid, 'Pending', 'pending', 'resident')
    `;

    const visible = await unitOfWork.transaction(
      { kind: "user", userId: pendingUserId },
      (tx) => rows<{ id: string }>(tx, sql`select id from public.societies`),
    );

    // Exactly the society they applied to — never the second society, which they
    // have no relationship with.
    expect(visible.map((row) => row.id)).toEqual([fixtures.societyId]);
  });
});

describe("credential-shaped columns", () => {
  it("keeps invitations.token_hash out of every identity's reach", async () => {
    // The token is a credential: the row is readable by a manager and the hash is
    // not in any SELECT grant, which is what "the token never leaks through a
    // response" has to mean at the layer that owns the column.
    await resetData(owner);
    const adminUserId = await createLocalUser(
      owner,
      "admin@rls.ses.test",
      "Admin",
    );

    const societyId = await unitOfWork.transaction(
      { kind: "user", userId: adminUserId },
      async (tx) => {
        const [created] = await rows<{ value: string }>(
          tx,
          sql`select (public.society_create(jsonb_build_object(
                'name', 'Credential Court', 'type', 'apartment', 'city', 'Pune', 'state', 'MH'
              )))->'society'->>'id' as value`,
        );
        return created!.value;
      },
    );

    // Inserted under the Admin's identity, not the owner's: `invited_by` is not a
    // client-settable column, and the write trigger resolves it from the caller's
    // own active membership — as the owner there is no identity and it raises
    // P0001/INVITATION_INVITER_REQUIRED.
    const invitation = await unitOfWork.transaction(
      { kind: "user", userId: adminUserId },
      async (tx) => {
        const [row] = await rows<{ id: string }>(
          tx,
          sql`insert into public.invitations (society_id, channel, email, token_hash, expires_at)
              values (
                ${societyId}::uuid, 'email', 'invitee@rls.ses.test',
                ${"a".repeat(64)}, now() + interval '7 days'
              )
              returning id`,
        );
        return row;
      },
    );
    expect(invitation?.id).toBeTruthy();

    // The row itself is visible to the Admin…
    const visible = await unitOfWork.transaction(
      { kind: "user", userId: adminUserId },
      (tx) => rows(tx, sql`select id from public.invitations`),
    );
    expect(visible).toHaveLength(1);

    // …and the credential column is not, for anyone.
    await expect(
      unitOfWork.transaction({ kind: "user", userId: adminUserId }, (tx) =>
        rows(tx, sql`select token_hash from public.invitations`),
      ),
    ).rejects.toThrow();
  });
});
