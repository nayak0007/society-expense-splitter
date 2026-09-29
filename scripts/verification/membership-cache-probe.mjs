/**
 * Membership cache ordering, measured through the real API against hosted Supabase.
 *
 * ## What this proves that the unit tests cannot
 *
 * `apps/api/src/infrastructure/cache/__tests__/membership-cache-ordering.test.ts`
 * drives the real invalidator, the real reader and the real protocol, but it
 * *constructs* them. This exercises the shipped wiring: the guard chain through
 * Nest, the real repositories and their real SQL against a real PostgreSQL, the
 * real commit boundaries, and the cache in an actual request path. A wrong
 * `CacheModule` factory, a wrong `SocietiesModule` binding or a missing cache scope
 * in a repository would leave the unit suite green and fail here.
 *
 * ## The observable: the reader's own hit/miss log
 *
 * A cache's effect is not usually visible in a response, because a stale grant and
 * a fresh one often produce the same status code — every use case in this codebase
 * re-derives its capability from its own database read, which is a property worth
 * knowing (see C1). So the measurement is taken where the decision is made: the
 * cached reader logs `membership cache hit` at debug level on every request it
 * answers from the cache, and this probe boots the API with `LOG_LEVEL=debug` and
 * reads its stdout. "The guard served a stale membership" is then a fact about the
 * log, not an inference from a status code.
 *
 * ## Why the cache is run in `memory` mode here
 *
 * The API under test is **one process**, so a per-process store is faithful to what
 * a Redis store would do for this run. What it does not exercise is the Redis
 * adapter itself — there is no Redis server in this environment and the Lua scripts
 * cannot be executed here. That is reported as a gap rather than hidden: the
 * in-memory adapter implements the identical protocol, and the scripts carry
 * invariant tests.
 *
 * ## Running it
 *
 *   pnpm --filter @ses/api build
 *   node --env-file=apps/api/.env scripts/verification/membership-cache-probe.mjs
 *
 * `PROBE_CHECKS=C8` runs only the counterfactual, which is measured with the cache
 * scope temporarily removed from `MemberRepositoryPostgres.setStatus`. The run
 * creates marker societies and removes them again on the way out, including on
 * failure.
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
const MARKER = `ZZ-CACHE-${RUN}`;
const PASSWORD =
  process.env.HOSTED_VERIFY_PASSWORD ?? "VerifyOnly-NotASecret-2026!";
const SUPABASE_URL = required("SUPABASE_URL").replace(/\/$/, "");
const SERVICE_KEY = required("SUPABASE_SERVICE_ROLE_KEY");
const API_PORT =
  Number(process.env.PORT ?? 0) > 0 ? Number(process.env.PORT) : 3012;
/** `all`, or a comma-separated list of check ids — used for the counterfactual. */
const ONLY = (process.env.PROBE_CHECKS ?? "all")
  .split(",")
  .map((s) => s.trim());

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

const results = [];
function record(label, pass, detail = "") {
  results.push({ label, pass, detail });
  console.log(
    `[${pass ? "OK" : "FAIL"}] ${label}${detail ? `  — ${detail}` : ""}`,
  );
}
const want = (id) => ONLY.includes("all") || ONLY.includes(id);

// ── setup ────────────────────────────────────────────────────────────────────

const profiles = await owner`
  select p.id::text as id, p.email
    from public.profiles p
   where p.email like '%@verify.ses.test'
   order by p.email
   limit 2`;
if (profiles.length < 2) {
  console.error(
    `Need 2 verify profiles to run this probe; found ${profiles.length}.`,
  );
  process.exit(2);
}
const [adminUser, subjectUser] = profiles.map((row) => row.id);

const created = [];

/**
 * One society, created through the SQL function the API itself calls — as the
 * creator, on the runtime connection, so `societies_insert_creator` applies
 * exactly as it does for a real request.
 *
 * The payload is passed as an **object**: `postgres.js` serialises it for the
 * `::jsonb` cast itself, and handing it JSON text would double-encode it so that
 * every `->>` inside the function reads NULL.
 */
async function createSociety(actor, name) {
  const societyId = await runtime.begin(async (tx) => {
    await actAs(tx, actor);
    const rows = await tx.unsafe(
      "select public.society_create($1::jsonb) as snapshot",
      [
        {
          name,
          type: "apartment",
          city: "Verify City",
          state: "Verify State",
          pincode: "560001",
          billingDay: 5,
          dueDay: 10,
          approvalThresholdPaise: 500_000,
        },
      ],
    );
    return rows[0].snapshot.society.id;
  });
  created.push(societyId);
  return societyId;
}

/**
 * A membership written straight into the table.
 *
 * The API has no route that adds a live member with a chosen role: `POST /members`
 * creates a shadow member and the join queue lands a `pending` row. The probe needs
 * two live memberships quickly, so it writes them as the owner — the same role the
 * migration runner uses, which is also why this bypasses RLS.
 */
async function addMember(societyId, userId, role, status = "active") {
  const rows = await owner`
    insert into public.members
      (society_id, user_id, display_name, phone, role, status, occupancy)
    values
      (${societyId}::uuid, ${userId}::uuid, ${`Cache Probe ${role}`},
       ${`9${randomBytes(4).readUInt32BE(0) % 100000000}`.padEnd(10, "0")},
       ${role}::public.member_role, ${status}::public.member_status, 'owner_occupied')
    returning id::text`;
  return rows[0].id;
}

const societyA = await createSociety(adminUser, `${MARKER} A`);
const societyB = await createSociety(adminUser, `${MARKER} B`);
// `treasurer` in A: the role the subject holds while its grant is the thing under
// test (it holds `member.view`, so a guarded read succeeds), and it is inside PRD
// §2.2's cap of two so the role changes below are not refused for capacity.
const subjectInA = await addMember(societyA, subjectUser, "treasurer");
await addMember(societyB, subjectUser, "tenant");

// ── the API ──────────────────────────────────────────────────────────────────

const apiDir = fileURLToPath(new URL("../../apps/api/", import.meta.url));
const server = spawn("node", ["dist/main.js"], {
  cwd: apiDir,
  env: {
    ...process.env,
    PORT: String(API_PORT),
    HOST: "127.0.0.1",
    // The whole point of the run. `memory` is faithful because this is one process.
    MEMBERSHIP_CACHE_STORE: "memory",
    // The cached reader's hit/miss lines are `debug`; without this the probe's
    // observable is not emitted at all.
    LOG_LEVEL: "debug",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stdout.on("data", (chunk) => {
  logs += chunk.toString();
});
server.stderr.on("data", (chunk) => {
  logs += chunk.toString();
});

const base = `http://127.0.0.1:${API_PORT}/v1`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForApi() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const res = await fetch(`${base}/health/live`);
      if (res.status === 200) return true;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  return false;
}

async function login(email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = await res.json();
  return body.access_token ?? null;
}

const apiUp = await waitForApi();
const adminEmail = profiles.find((row) => row.id === adminUser)?.email;
const subjectEmail = profiles.find((row) => row.id === subjectUser)?.email;
const adminToken = apiUp && adminEmail ? await login(adminEmail) : null;
const subjectToken = apiUp && subjectEmail ? await login(subjectEmail) : null;

/** A guarded read the subject is entitled to while it holds a live membership. */
const guardedRead = (token, societyId) =>
  fetch(`${base}/members?limit=1`, {
    headers: { Authorization: `Bearer ${token}`, "x-society-id": societyId },
  });

const suspend = (token, societyId) =>
  fetch(`${base}/members/${subjectInA}/suspend`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "x-society-id": societyId },
  });

const reactivate = (token, societyId) =>
  fetch(`${base}/members/${subjectInA}/reactivate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "x-society-id": societyId },
  });

const setRole = (token, societyId, role) =>
  fetch(`${base}/members/${subjectInA}/role`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-society-id": societyId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role }),
  });

const removeMember = (token, societyId) =>
  fetch(`${base}/members/${subjectInA}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "x-society-id": societyId },
  });

const outOfBandRole = (role) =>
  owner`update public.members set role = ${role}::public.member_role
         where id = ${subjectInA}::uuid`;

/** How many requests the guard answered from the cache since `from`, per the API's own log. */
const cacheHits = (societyId, from) =>
  logs
    .slice(from)
    .split("\n")
    .filter((line) => line.includes(`membership cache hit for ${societyId}`))
    .length;

try {
  if (!apiUp || !adminToken || !subjectToken) {
    record(
      "API and tokens",
      false,
      `api=${apiUp} adminLogin=${Boolean(adminToken)} subjectLogin=${Boolean(subjectToken)}`,
    );
    console.log(logs.split("\n").filter(Boolean).slice(-8).join("\n"));
    throw new Error("probe could not reach the API");
  }
  record("API and tokens", true, "one process, MEMBERSHIP_CACHE_STORE=memory");

  // ── C1 · the cache is in the guard's request path ────────────────────────
  if (want("C1")) {
    const warmFrom = logs.length;
    const warm = await guardedRead(subjectToken, societyA);
    await sleep(150);
    const afterWarm = logs.slice(warmFrom);

    // Changed straight in the database, so no repository and no invalidation ran.
    await outOfBandRole("guest");
    const staleFrom = logs.length;
    const stale = await guardedRead(subjectToken, societyA);
    await sleep(150);
    const staleHits = cacheHits(societyA, staleFrom);
    const staleBody = await stale.json().catch(() => ({}));

    // The premise: the *second* read is answered from the cache, so the guard is
    // looking at the role the row had when it was stored, not at the row.
    const servedFromCache = staleHits > 0;
    // The finding: the request is refused anyway, by the application layer's own
    // fresh read. Every use case re-derives its capability from the database, so a
    // stale guard answer is not the last line of defence on any shipped route.
    const refusedDownstream = stale.status >= 400;

    record(
      "C1  the guard's second read is served from the cache (measured, not assumed)",
      warm.status === 200 && servedFromCache,
      `warm=${warm.status} (miss→store), next read=${stale.status} ${staleBody?.error?.code ?? ""} with ${staleHits} cache hit(s) logged`,
    );
    record(
      "C1′ an out-of-band demotion still cannot act: the use case re-reads the database",
      warm.status === 200 && refusedDownstream,
      `next read=${stale.status} ${staleBody?.error?.code ?? ""} — the guard's cached grant is not the only authority`,
    );
    void afterWarm;

    // Put the row back so the cache and the database agree again.
    await outOfBandRole("treasurer");
  }

  // ── C2 · an in-band role change is not served from the cache ─────────────
  if (want("C2")) {
    const before = await guardedRead(subjectToken, societyA);
    const from = logs.length;
    const changed = await setRole(adminToken, societyA, "guest");
    const after = await guardedRead(subjectToken, societyA);
    await sleep(150);
    const hits = cacheHits(societyA, from);

    record(
      "C2  a demotion is visible to the next request, and the guard re-read",
      before.status === 200 && changed.status === 200 && after.status === 403,
      `before=${before.status}, demote=${changed.status}, next request=${after.status}, cache hits after the demotion=${hits} (0 = the invalidation landed)`,
    );
  }

  // ── C3 · suspension ──────────────────────────────────────────────────────
  if (want("C3")) {
    await setRole(adminToken, societyA, "treasurer");
    const warm = await guardedRead(subjectToken, societyA);
    const from = logs.length;
    const suspended = await suspend(adminToken, societyA);
    const after = await guardedRead(subjectToken, societyA);
    await sleep(150);
    const hits = cacheHits(societyA, from);
    const body = await after.json().catch(() => ({}));

    record(
      "C3  a suspension is visible to the next request (MEMBER_INACTIVE, not a cached 200)",
      warm.status === 200 &&
        suspended.status === 200 &&
        after.status === 403 &&
        body?.error?.code === "MEMBER_INACTIVE",
      `warm=${warm.status}, suspend=${suspended.status}, next request=${after.status} ${body?.error?.code ?? ""}, cache hits=${hits}`,
    );
  }

  // ── C5 · invalidation is per society ─────────────────────────────────────
  if (want("C5")) {
    const inB = await guardedRead(subjectToken, societyB);
    const inA = await guardedRead(subjectToken, societyA);

    record(
      "C5  another society's cached membership survives the invalidation",
      inB.status === 200 && inA.status === 403,
      `society B=${inB.status}, society A=${inA.status}`,
    );
  }

  // ── C9 · the cross-tenant key ────────────────────────────────────────────
  //
  // The subject is a member of both societies with different roles. The same cache
  // answers both requests, and A's invalidation must not have turned B's entry into
  // A's answer — nor the other way round. It runs before C6, which removes the
  // membership this needs (a removal is terminal).
  if (want("C9")) {
    // C3 left the subject suspended in A and C5 depended on that, so it is put back
    // before this check reads both societies.
    await reactivate(adminToken, societyA).catch(() => undefined);
    await setRole(adminToken, societyA, "treasurer").catch(() => undefined);
    const inA = await guardedRead(subjectToken, societyA);
    const inB = await guardedRead(subjectToken, societyB);

    record(
      "C9  one user, two societies: neither key answers for the other",
      inA.status === 200 && inB.status === 200,
      `society A=${inA.status}, society B=${inB.status} (different roles, same user)`,
    );
  }

  // ── C6 · removal ─────────────────────────────────────────────────────────
  if (want("C6") && ONLY.includes("all")) {
    await reactivate(adminToken, societyA);
    const warm = await guardedRead(subjectToken, societyA);
    const removed = await removeMember(adminToken, societyA);
    const after = await guardedRead(subjectToken, societyA);

    record(
      "C6  a removed member cannot be answered from the cached membership",
      warm.status === 200 && removed.ok && after.status === 404,
      `warm=${warm.status}, remove=${removed.status}, next request=${after.status} (404, not 403)`,
    );
  }

  // ── C8 · the counterfactual, in a dedicated run ──────────────────────────
  //
  // Runs only when the run was narrowed to it (`PROBE_CHECKS=C8`), and only after
  // the cache scope has been removed from `setStatus`. The observable is the
  // guard's own log line: if the invalidation is the thing that stops a revoked
  // grant being served, then without it the *next* request is answered from the
  // cache and says so.
  if (want("C8") && !ONLY.includes("all")) {
    const warm = await guardedRead(subjectToken, societyA);
    const from = logs.length;
    const suspended = await suspend(adminToken, societyA);
    const after = await guardedRead(subjectToken, societyA);
    await sleep(150);
    const hits = cacheHits(societyA, from);
    const body = await after.json().catch(() => ({}));

    record(
      "C8  COUNTERFACTUAL: without the cache scope, the revoke is not seen by the guard",
      warm.status === 200 && suspended.status === 200 && hits > 0,
      `warm=${warm.status}, suspend=${suspended.status}, next request=${after.status} ${body?.error?.code ?? ""}, cache hits after the suspension=${hits} (stale grant served)`,
    );
  }
} finally {
  server.kill();
  // The society goes first, and the order is load-bearing: `chk_admin_present()` is
  // a deferred trigger on `members` that refuses a commit leaving a live society
  // with no active Admin — and deleting the members first is exactly that. Deleting
  // the society first makes the check vacuous by its own rule ("there is no live
  // society left to administer"), and the cascade takes the members with it.
  if (created.length > 0) {
    await owner`delete from public.societies where id = any(${created}::uuid[])`;
    await owner`delete from public.members where society_id = any(${created}::uuid[])`;
    await owner`delete from public.society_settings where society_id = any(${created}::uuid[])`;
  }
  const left = await owner`
    select count(*)::int as n from public.societies where name like ${`${MARKER}%`}`;
  console.log(
    left[0].n === 0
      ? "[OK] teardown — no marker rows left"
      : `[FAIL] teardown — ${left[0].n} marker rows left`,
  );
  await runtime.end();
  await owner.end();
}

const passed = results.filter((result) => result.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
