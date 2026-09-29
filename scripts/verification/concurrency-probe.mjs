/**
 * Real concurrency probe for the membership invariants (T051).
 *
 * Every test runs **two genuinely overlapping transactions** on two connections, not a
 * sequential replay of check() → write(). Each test asserts the invariant, not the
 * mechanism:
 *
 *   T1  role cap        — two promotions at once cannot exceed PRD §2.2's cap (3 admins)
 *   T2  last admin      — two demotions at once cannot leave a society unadministered
 *   T3  invitation race — two *different* invitations accepted at once by one recipient
 *                         produce exactly one membership, and the loser is refused with
 *                         the same named error the sequential path raises
 *   T4  slug race       — two societies created at once with the same name, through the
 *                         API, so the repository's savepoint retry is exercised
 *   T5  bulk create     — a bulk create whose label is claimed mid-flight by a competing
 *                         writer, which must be absorbed into the report (one savepoint
 *                         per row) rather than poisoning the batch's transaction
 *
 * The membership writes run as `authenticated` under the same `SET LOCAL ROLE
 * authenticated` + `auth.uid()` preamble `UnitOfWork` uses, with a real admin identity,
 * because RLS decides *whose* row may be written. The invariants themselves are enforced
 * by triggers, which fire for every role.
 *
 * Secrets are read from the environment and never printed. Test rows are named
 * `ZZ-RACE-<runId> …` and are deleted at the end (they are this script's own rows).
 *
 * Run from the repo root:
 *   VERIFY_RUN_ID=<id> node --env-file=apps/api/.env scripts/verification/concurrency-probe.mjs
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const requireFromApi = createRequire(
  fileURLToPath(new URL("../../apps/api/package.json", import.meta.url)),
);
const postgres = requireFromApi("postgres");

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name} (use --env-file=apps/api/.env).`);
    process.exit(2);
  }
  return value;
}

const RUN = process.env.VERIFY_RUN_ID ?? randomBytes(3).toString("hex");
const MARKER = `ZZ-RACE-${RUN}`;
const PASSWORD =
  process.env.HOSTED_VERIFY_PASSWORD ?? "VerifyOnly-NotASecret-2026!";
const SUPABASE_URL = required("SUPABASE_URL").replace(/\/$/, "");
const SERVICE_KEY = required("SUPABASE_SERVICE_ROLE_KEY");
// `PORT` is exported as `0` by some harnesses and the API's config schema rejects a
// non-positive port, so it is only honoured when it is a usable one.
const API_PORT =
  Number(process.env.PORT ?? 0) > 0 ? Number(process.env.PORT) : 3011;

const owner = postgres(required("MIGRATION_DATABASE_URL"), {
  max: 4,
  prepare: false,
  connect_timeout: 20,
});
const runtime = postgres(required("DATABASE_URL"), {
  max: 4,
  prepare: false,
  connect_timeout: 20,
});

const results = [];
function record(label, pass, detail = "") {
  results.push({ label, pass, detail });
  console.log(
    `[${pass ? "OK" : "FAIL"}] ${label}${detail ? `  — ${detail}` : ""}`,
  );
}

/** The identity bridge, exactly as `UnitOfWork` sets it for one transaction. */
async function actAs(tx, sub) {
  await tx.unsafe("SET LOCAL ROLE authenticated");
  await tx.unsafe("SELECT set_config('app.user_id', $1, true)", [sub]);
  await tx.unsafe("SELECT set_config('request.jwt.claim.sub', $1, true)", [
    sub,
  ]);
  await tx.unsafe("SELECT set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub, role: "authenticated" }),
  ]);
}

/**
 * Runs `work` on two connections that are inside their transactions — and past their
 * identity setup — at the same time. `subs` names the identity each one acts as.
 */
async function overlap(sql, subs, work) {
  let arrived = 0;
  let release;
  const both = new Promise((resolve) => {
    release = resolve;
  });
  const arrive = async () => {
    arrived += 1;
    if (arrived === 2) release();
    await both;
  };

  const run = (index) =>
    sql.begin(async (tx) => {
      await actAs(tx, subs[index]);
      await arrive();
      return work(tx, index);
    });

  const settled = await Promise.allSettled([run(0), run(1)]);
  return settled.map((outcome) =>
    outcome.status === "fulfilled"
      ? { ok: true, value: outcome.value }
      : { ok: false, error: outcome.reason },
  );
}

const errorText = (outcome) =>
  outcome.ok
    ? ""
    : `${outcome.error?.code ?? ""} ${outcome.error?.message ?? ""}`.trim();

/**
 * The wizard's payload as a plain object, not a pre-stringified string: `postgres.js`
 * infers a parameter's type from the `$1::jsonb` cast in the statement and then runs its
 * *own* serializer for it, so handing it JSON text double-encodes the value and every
 * `->>` inside `society_create()` reads NULL (which surfaces as a not-null violation on
 * `societies.name`, a long way from the cause).
 */
const societyPayload = (name) => ({
  name,
  type: "apartment",
  city: "Verify City",
  state: "Verify State",
  pincode: "560001",
  billingDay: 5,
  dueDay: 10,
  approvalThresholdPaise: 500_000,
});

async function createSocietyAs(sub, name) {
  return runtime.begin(async (tx) => {
    await actAs(tx, sub);
    const r = await tx.unsafe(
      "select public.society_create($1::jsonb) as snapshot",
      [societyPayload(name)],
    );
    return r[0].snapshot.society.id;
  });
}

const setRole = (userId, role, societyId) =>
  owner`update public.members set role = ${role}::public.member_role
         where society_id = ${societyId}::uuid and user_id = ${userId}::uuid`;

// ── setup ────────────────────────────────────────────────────────────────────

const profiles = await owner`
  select p.id::text as id, p.email
    from public.profiles p
   where p.email like '%@verify.ses.test'
   order by p.email
   limit 4`;
if (profiles.length < 4) {
  console.error(
    `Need 4 verify profiles to run this probe; found ${profiles.length}.`,
  );
  process.exit(2);
}
const [u1, u2, u3, u4] = profiles.map((row) => row.id);

const societyA = await createSocietyAs(u1, `${MARKER} Society A`);
await owner`
  insert into public.members (society_id, user_id, display_name, phone, role, status, occupancy)
  values
    (${societyA}::uuid, ${u2}::uuid, 'Race Admin Two', '9000000002', 'admin', 'active', 'owner_occupied'),
    (${societyA}::uuid, ${u3}::uuid, 'Race Resident Three', '9000000003', 'resident', 'active', 'owner_occupied'),
    (${societyA}::uuid, ${u4}::uuid, 'Race Resident Four', '9000000004', 'resident', 'active', 'owner_occupied')`;

const activeAdmins = async (societyId) =>
  (
    await owner`select count(*)::int as n from public.members
                 where society_id = ${societyId}::uuid and role = 'admin' and status = 'active'`
  )[0].n;

const setRoleSql = (societyId, userId, role) => [
  "update public.members set role = $3::public.member_role where society_id = $1::uuid and user_id = $2::uuid",
  [societyId, userId, role],
];

// ── T0 · the premise, measured ───────────────────────────────────────────────

// Read-only, and it is the reason every test below matters: two concurrent
// transactions in the same society observe the *same* pre-state. That is exactly the
// value the pre-fix `chk_role_caps()` / `chk_admin_present()` made their decision from
// (`SELECT count(*)` under READ COMMITTED, no lock), which is why two write bursts each
// passed their own check and both committed. The lock added by
// `20260928120000_membership_write_concurrency.sql` is what stops a *write* from being
// based on this stale read.
{
  const [a, b] = await overlap(runtime, [u1, u1], async (tx) => {
    const r = await tx.unsafe(
      "select count(*)::int as n from public.members where society_id = $1::uuid and role = 'admin' and status = 'active'",
      [societyA],
    );
    return r[0].n;
  });
  record(
    "T0  two concurrent transactions read the same stale count (the premise)",
    a.ok && b.ok && a.value === b.value && a.value === 2,
    `both read admins=${a.value},${b.value}`,
  );
}

// ── T1 · the cap, under two concurrent promotions ────────────────────────────

{
  const before = await activeAdmins(societyA);
  const [a, b] = await overlap(runtime, [u1, u1], async (tx, index) => {
    // One Admin promoting two residents at the same moment — the ordinary double-tap,
    // not an exotic case.
    const [statement, params] = setRoleSql(
      societyA,
      index === 0 ? u3 : u4,
      "admin",
    );
    await tx.unsafe(statement, params);
    return index === 0 ? u3 : u4;
  });
  const successes = [a, b].filter((outcome) => outcome.ok).length;
  const after = await activeAdmins(societyA);
  const refused = [a, b].find((outcome) => !outcome.ok);
  record(
    "T1  the admin cap survives two concurrent promotions",
    before === 2 &&
      successes === 1 &&
      after === 3 &&
      /SOCIETY_ROLE_CAP_EXCEEDED/.test(errorText(refused)),
    `admins ${before} → ${after}, successes=${successes}, loser=[${errorText(refused).slice(0, 60)}]`,
  );

  // Back to two admins, sequentially, for the next test.
  const promoted = [a, b].find((outcome) => outcome.ok)?.value;
  if (promoted) await setRole(promoted, "resident", societyA);
}

// ── T2 · the last active Admin, under two concurrent demotions ───────────────

{
  const before = await activeAdmins(societyA);
  // Each Admin demotes the *other* — so neither write is a self-change (which the
  // self-service guard refuses for a different reason), and both run as an Admin.
  const [a, b] = await overlap(runtime, [u1, u2], async (tx, index) => {
    const [statement, params] = setRoleSql(
      societyA,
      index === 0 ? u2 : u1,
      "resident",
    );
    await tx.unsafe(statement, params);
    return index;
  });
  const successes = [a, b].filter((outcome) => outcome.ok).length;
  const after = await activeAdmins(societyA);
  const refused = [a, b].find((outcome) => !outcome.ok);
  record(
    "T2  a society cannot be left without an active Admin by two concurrent demotions",
    before === 2 &&
      successes === 1 &&
      after === 1 &&
      /SOCIETY_ADMIN_REQUIRED/.test(errorText(refused)),
    `admins ${before} → ${after}, successes=${successes}, loser=[${errorText(refused).slice(0, 60)}]`,
  );
}

// ── T3 · invitation vs invitation for one recipient ─────────────────────────

{
  const societyB = await createSocietyAs(u1, `${MARKER} Society B`);

  // Two live *link* invitations, stamped by the real trigger as the Admin who made them.
  const tokenHashes = ["1".repeat(64), "2".repeat(64)];
  for (const tokenHash of tokenHashes) {
    await runtime.begin(async (tx) => {
      await actAs(tx, u1);
      await tx.unsafe(
        `insert into public.invitations (society_id, channel, role, token_hash, expires_at)
         values ($1::uuid, 'link', 'resident', $2, now() + interval '14 days')`,
        [societyB, tokenHash],
      );
    });
  }

  const [a, b] = await overlap(runtime, [u3, u3], async (tx, index) => {
    const r = await tx.unsafe(
      "select public.invitation_accept($1, $2::uuid) as result",
      [tokenHashes[index], u3],
    );
    return r[0].result;
  });

  const successes = [a, b].filter((outcome) => outcome.ok).length;
  const refused = [a, b].find((outcome) => !outcome.ok);
  const memberships = (
    await owner`select count(*)::int as n from public.members
                   where society_id = ${societyB}::uuid and user_id = ${u3}::uuid`
  )[0].n;
  record(
    "T3  two invitations accepted at once create exactly one membership, the loser named",
    successes === 1 &&
      memberships === 1 &&
      /INVITATION_ALREADY_MEMBER/.test(errorText(refused)),
    `successes=${successes}, memberships=${memberships}, loser=[${errorText(refused).slice(0, 60)}]`,
  );

  await owner`update public.societies set deleted_at = now() where id = ${societyB}::uuid`;
}

// ── the API, booted once: T4 and T5 both drive the real server ────────────────
//
// The slug retry and the bulk savepoint are *repository* behaviours, and only a
// request reaches them: a direct SQL transaction cannot tell the two apart.

const apiDir = fileURLToPath(new URL("../../apps/api/", import.meta.url));
const server = spawn("node", ["dist/main.js"], {
  cwd: apiDir,
  env: { ...process.env, PORT: String(API_PORT), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
const logs = [];
server.stdout.on("data", (chunk) => logs.push(chunk.toString()));
server.stderr.on("data", (chunk) => logs.push(chunk.toString()));

const base = `http://127.0.0.1:${API_PORT}/v1`;
const waitForApi = async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const res = await fetch(`${base}/health/live`);
      if (res.status === 200) return true;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
};

const login = async (email) => {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await res.json();
  return body.access_token ?? null;
};

const apiUp = await waitForApi();
const adminEmail = profiles.find((row) => row.id === u1)?.email;
const token = apiUp && adminEmail ? await login(adminEmail) : null;

// T2 left exactly one of u1/u2 an Admin, and only an Admin may write structure, so
// the admin identity T4 and T5 act as is restored explicitly rather than assumed.
await setRole(u1, "admin", societyA);

try {
  {
    if (!token) {
      record(
        "T4  one name created twice at once still yields two societies (savepoint retry)",
        false,
        `API up=${apiUp}, login=${token ? "ok" : "failed"} — check skipped`,
      );
      // If the server never answered, its own log says why (a port already in use, a
      // missing provider) — without it this failure reads only as "login failed".
      console.log(
        logs.join("").split("\n").filter(Boolean).slice(-4).join("\n"),
      );
    } else {
      const create = () =>
        fetch(`${base}/societies`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(societyPayload(`${MARKER} Duplicate Name`)),
        });
      const [first, second] = await Promise.all([create(), create()]);
      const statuses = [first.status, second.status];
      const bodies = [await first.json(), await second.json()];
      const slugs = bodies
        .map((body) => body?.data?.society?.slug)
        .filter((slug) => typeof slug === "string");
      const passed =
        statuses.every((status) => status === 201) &&
        slugs.length === 2 &&
        slugs[0] !== slugs[1];
      record(
        "T4  one name created twice at once still yields two societies (savepoint retry)",
        passed,
        `statuses=${statuses.join("|")} slugs=${slugs.join(", ") || "(none)"}`,
      );
      if (!passed) {
        // The server's own words, without any secret in them: `dist/main.js` logs the
        // request line and the classifier's answer, which is what makes a failure here
        // diagnosable from the transcript alone.
        console.log(logs.join("").split("\n").slice(-6).join("\n"));
      }
    }
  }

  // ── T5 · the bulk-create collision, absorbed rather than fatal ─────────────
  //
  // `ApartmentRepository.createMany` writes the whole batch in ONE transaction and
  // absorbs `uq_apartments_building_number` per row so that a concurrent creator
  // lands in the report instead of failing the request. That is only sound if the
  // refusal is *contained*: a refused statement aborts the transaction it ran in,
  // and every later statement in it then fails with 25P02 however unrelated. This
  // check reproduces the situation the absorption exists for, on purpose and in a
  // fixed order rather than as a race:
  //
  //   1. a competing writer inserts the label and stays uncommitted, so the batch
  //      cannot see it when it reads (READ COMMITTED sees committed rows only);
  //   2. the batch inserts that label and blocks on the unique index;
  //   3. the competitor commits, so the batch's insert is refused;
  //   4. the batch's *second* row is the discriminator — it can only be created if
  //      the refusal was rolled back to a savepoint rather than the whole
  //      transaction being poisoned.
  //
  // Measured before the fix: `409` with nothing created — the refusal was neither
  // recognised (the predicate searched the classifier's prose for the column name, so
  // it could not match the constraint it was written for) nor contained. The assertion
  // below is `201`, with the claimed label accounted for and the following row created.
  //
  // Note the status: the claimed label comes back `existing`, not `duplicate`, because
  // the repository's per-row absorption and the caller's own read are two ways of
  // learning the same fact (that label is live) and the use case reports both the same
  // way — `duplicate` is reserved for two rows of one request claiming one label. What
  // distinguishes the write path from the read path is therefore the blocked insert
  // captured below, not the status: from the response alone the two are identical.
  {
    if (!token) {
      record(
        "T5  a bulk create absorbs a label a concurrent writer claimed mid-flight",
        false,
        "no API session — check skipped",
      );
    } else {
      const headers = {
        Authorization: `Bearer ${token}`,
        "X-Society-Id": societyA,
        "Content-Type": "application/json",
      };
      const buildingResponse = await fetch(`${base}/buildings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: `${MARKER} Bulk Tower` }),
      });
      const buildingBody = await buildingResponse.json();
      const buildingId = buildingBody?.data?.building?.id ?? null;

      const claimed = `${MARKER}-B-1`;
      const free = `${MARKER}-B-2`;

      let commitCompetitor;
      const competitorGate = new Promise((resolve) => {
        commitCompetitor = resolve;
      });
      const competitor = owner.begin(async (tx) => {
        await tx.unsafe(
          `insert into public.apartments (society_id, building_id, apartment_number)
           values ($1::uuid, $2::uuid, $3)`,
          [societyA, buildingId, claimed],
        );
        await competitorGate;
      });

      const bulk = fetch(`${base}/buildings/${buildingId}/apartments/bulk`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          rows: [{ apartmentNumber: claimed }, { apartmentNumber: free }],
        }),
      });

      // Release the competitor only once the batch's own insert is *actually* waiting
      // on it. A fixed sleep would be a guess at the request's latency (guards, RLS
      // reads and pooler round trips take seconds against the hosted project), and a
      // guess that is too short lets the batch read *after* the commit — the label then
      // lands in `existing` from the *read*, the write path is never exercised, and the
      // check could pass while testing nothing. Polling the server's own lock state
      // makes the interleaving a fact, and the waiting statement is captured so that
      // "the batch's insert was blocked" is evidence rather than an inference.
      const waitForBlockedInsert = async () => {
        for (let attempt = 0; attempt < 600; attempt += 1) {
          const waiting = await owner`
            select usename, wait_event, left(coalesce(query, ''), 80) as query
              from pg_stat_activity
             where state = 'active' and wait_event_type = 'Lock'
             limit 2`;
          if (waiting.length > 0) return waiting;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return [];
      };
      const blockedBy = await waitForBlockedInsert();
      commitCompetitor();
      await competitor;
      const blockedInsert = blockedBy.some((row) =>
        /insert into public\.apartments/i.test(row.query),
      );

      const response = await bulk;
      const body = await response.json().catch(() => ({}));
      const data = body?.data ?? {};
      const outcomes = Array.isArray(data.outcomes) ? data.outcomes : [];
      const statusOf = (label) =>
        outcomes.find((row) => row.apartmentNumber === label)?.status;
      const liveFlats = (
        await owner`select count(*)::int as n from public.apartments
                     where building_id = ${buildingId}::uuid
                       and apartment_number in (${claimed}, ${free})
                       and deleted_at is null`
      )[0].n;

      const passed =
        buildingId !== null &&
        blockedInsert &&
        response.status === 201 &&
        data.createdCount === 1 &&
        statusOf(claimed) === "existing" &&
        statusOf(free) === "created" &&
        liveFlats === 2;
      record(
        "T5  a bulk create absorbs a label a concurrent writer claimed mid-flight",
        passed,
        `blockedInsert=${blockedInsert} status=${response.status} created=${data.createdCount} outcomes=${outcomes
          .map((row) => `${row.apartmentNumber}:${row.status}`)
          .join(",")} live=${liveFlats}`,
      );
      if (!passed) {
        // The server's own words: the classifier's answer and the request line, which
        // is what makes a failure here diagnosable from the transcript alone.
        console.log(logs.join("").split("\n").slice(-8).join("\n"));
      }
    }
  }
} finally {
  server.kill();
}

// ── teardown ─────────────────────────────────────────────────────────────────

// The society is soft-deleted first so `chk_admin_present()` stands down (it returns
// early for a tenant that is gone), then this probe's own rows are removed. Only
// `ZZ-RACE-<runId>%` rows are touched.
await owner`update public.societies set deleted_at = now() where name like ${MARKER + "%"}`;
await owner`delete from public.invitations
             where society_id in (select id from public.societies where name like ${MARKER + "%"})`;
await owner`update public.members set approved_by = null, removed_by = null, rejected_by = null
             where society_id in (select id from public.societies where name like ${MARKER + "%"})`;
await owner`delete from public.members
             where society_id in (select id from public.societies where name like ${MARKER + "%"})`;
await owner`delete from public.societies where name like ${MARKER + "%"}`;

const leftover = (
  await owner`select count(*)::int as n from public.societies where name like ${MARKER + "%"}`
)[0].n;

const passed = results.filter((result) => result.pass).length;
console.log("");
console.log(`run ${RUN}: ${passed}/${results.length} checks passed`);
console.log(`leftover ${MARKER} societies: ${leftover} (expect 0)`);

await owner.end({ timeout: 3 });
await runtime.end({ timeout: 3 });

if (passed !== results.length || leftover !== 0) process.exitCode = 1;
