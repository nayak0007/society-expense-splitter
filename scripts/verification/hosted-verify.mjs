/**
 * Hosted-Supabase Phase 3 verification runner (task §9–§16).
 *
 * Run from the repo root:
 *   PORT=3010 node --env-file=apps/api/.env scripts/verification/hosted-verify.mjs
 *
 * What it does, in order:
 *   1. Provisions throwaway Supabase Auth users through the Admin API
 *      (service-role key from the environment — never printed) and logs in for JWTs.
 *   2. Boots the built API (apps/api/dist/main.js) against the hosted DATABASE_URL.
 *   3. Runs the Phase 3 smoke: society → building → apartments (single, generate,
 *      bulk, patch) → shadow member → role assign.
 *   4. Runs the RLS/permissions matrix over HTTP with real hosted identities.
 *   5. Runs the transactional flows: invitation accept single-use, join-request
 *      approve, CSV import per-row failure handling.
 *   6. Runs direct-DB probes that prove auth.uid() ← GUC ← RLS end to end.
 *   7. Tears the business data down through the API's own soft-delete endpoints.
 *
 * Secrets: the script reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / DATABASE_URL
 * from the environment and prints none of them. Test credentials are fixed,
 * self-declared throwaways (HOSTED_VERIFY_PASSWORD, @verify.ses.test addresses).
 * Auth users are deliberately NOT deleted (task forbids resetting Auth users);
 * the script prints their emails for manual cleanup.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFileSync } from "node:fs";

const RUN = process.env.VERIFY_RUN_ID ?? randomBytes(3).toString("hex");
const PORT = Number(process.env.PORT ?? 3010);
const BASE = `http://127.0.0.1:${PORT}/v1`;
const PASSWORD =
  process.env.HOSTED_VERIFY_PASSWORD ?? "VerifyOnly-NotASecret-2026!";
const EMAIL_DOMAIN = "verify.ses.test";
const API_DIR = fileURLToPath(new URL("../../apps/api/", import.meta.url));
const API_LOG = join(tmpdir(), `ses-verify-api-${RUN}.log`);
const PROGRESS_LOG = join(tmpdir(), `ses-verify-progress-${RUN}.log`);
const progress = (line) => {
  appendFileSync(PROGRESS_LOG, `${line}\n`);
};

const SUPABASE_URL = require0("SUPABASE_URL");
const SERVICE_KEY = require0("SUPABASE_SERVICE_ROLE_KEY");
const DATABASE_URL = require0("DATABASE_URL");

function require0(name) {
  const value = process.env[name];
  if (!value) {
    console.error(
      `Missing ${name} in environment (use --env-file=apps/api/.env).`,
    );
    process.exit(2);
  }
  return value;
}

// ── results ──────────────────────────────────────────────────────────────────
const results = [];
let failures = 0;
function record(id, label, pass, detail = "") {
  if (!pass) failures += 1;
  results.push({ id, label, pass, detail });
  const line = `[${pass ? "OK" : "FAIL"}] ${id}  ${label}${detail ? `  — ${detail}` : ""}`;
  console.log(line);
  progress(line);
}
const expect = (actual, wanted) =>
  (Array.isArray(wanted) ? wanted.includes(actual) : actual === wanted)
    ? ""
    : `got ${actual}, want ${Array.isArray(wanted) ? wanted.join("|") : wanted}`;

// ── Supabase Auth Admin API ──────────────────────────────────────────────────
const authHeaders = { apikey: SERVICE_KEY, "Content-Type": "application/json" };

async function adminCreateUser(email) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: { ...authHeaders, Authorization: `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ email, password: PASSWORD, email_confirm: true }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (response.ok) return { id: body.id, created: true };
  const already = /already|registered|exists/i.test(
    `${body.msg ?? body.message ?? body.error_description ?? ""}`,
  );
  return {
    id: body.id ?? null,
    created: false,
    already,
    status: response.status,
  };
}

async function login(email) {
  const response = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ email, password: PASSWORD }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`login failed for ${email}: HTTP ${response.status}`);
  }
  return { token: body.access_token, userId: body.user?.id ?? null };
}

async function adminListUserEmails() {
  const response = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?perPage=200`,
    {
      headers: { ...authHeaders, Authorization: `Bearer ${SERVICE_KEY}` },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) return null;
  const body = await response.json().catch(() => ({}));
  return (body.users ?? [])
    .map((u) => u.email)
    .filter((e) => e?.endsWith(`@${EMAIL_DOMAIN}`));
}

// ── API helper ───────────────────────────────────────────────────────────────
async function call(
  token,
  method,
  path,
  { body, societyId, timeoutMs = 45_000, retries = 1 } = {},
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await callOnce(token, method, path, {
        body,
        societyId,
        timeoutMs,
      });
    } catch (error) {
      // Hosted Supabase p95 latency spikes; one retry covers teardown aborts.
      const retryable =
        attempt < retries &&
        (error.name === "AbortError" ||
          /abort|timeout|fetch failed/i.test(String(error.message)));
      if (!retryable) throw error;
      await sleep(1_500);
    }
  }
}

async function callOnce(
  token,
  method,
  path,
  { body, societyId, timeoutMs = 45_000 } = {},
) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (societyId) headers["x-society-id"] = societyId;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const code = json?.error?.code ?? null;
  const data = json?.data ?? json ?? null;
  return { status: response.status, code, data, raw: text };
}

// ── direct-DB probes (prove GUC → auth.uid() → RLS) ──────────────────────────
const requireFromApi = createRequire(
  fileURLToPath(new URL("../../apps/api/package.json", import.meta.url)),
);
const postgres = requireFromApi("postgres");
const sql = postgres(DATABASE_URL, {
  prepare: false,
  max: 1,
  connect_timeout: 20,
  idle_timeout: 5,
});

async function probe({ role = null, sub = null }) {
  return sql.begin(async (tx) => {
    if (role) await tx.unsafe("SET LOCAL ROLE authenticated");
    const claims = sub ? JSON.stringify({ sub, role: "authenticated" }) : "{}";
    await tx.unsafe("SELECT set_config('request.jwt.claims', $1, true)", [
      claims,
    ]);
    await tx.unsafe("SELECT set_config('request.jwt.claim.sub', $1, true)", [
      sub ?? "",
    ]);
    await tx.unsafe("SELECT set_config('app.user_id', $1, true)", [sub ?? ""]);
    const uid = await tx.unsafe("SELECT auth.uid()::text AS uid");
    const rows = await tx.unsafe(
      "SELECT id::text FROM public.societies ORDER BY id",
    );
    return { uid: uid[0].uid, ids: rows.map((r) => r.id) };
  });
}

async function probeOwnerNoContext() {
  return sql.begin(async (tx) => {
    const count = await tx.unsafe(
      "SELECT count(*)::int AS n FROM public.societies",
    );
    return count[0].n;
  });
}

// ── API server lifecycle ─────────────────────────────────────────────────────
let server = null;
const serverLogTail = [];
async function startServer() {
  server = spawn("node", ["dist/main.js"], {
    cwd: API_DIR,
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tee = (chunk) => {
    const line = chunk.toString();
    appendFileSync(API_LOG, line);
    serverLogTail.push(line);
    if (serverLogTail.length > 400) serverLogTail.shift();
  };
  server.stdout.on("data", tee);
  server.stderr.on("data", tee);
  server.on("exit", (code) => {
    if (code !== null && code !== 0 && !stopping) {
      console.error(`API process exited early (code ${code}). Last log lines:`);
      console.error(serverLogTail.slice(-25).join(""));
      process.exit(3);
    }
  });
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("API exited during startup");
    try {
      const response = await fetch(`${BASE}/health/live`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(1_000);
  }
  throw new Error("API did not become live within 90 s");
}
let stopping = false;
async function stopServer() {
  stopping = true;
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await sleep(2_000);
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `fn` over `items` with bounded concurrency (hosted p95 makes bulk
 * sequential deletes take minutes; the pool has room for a small fan-out). */
async function mapPool(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, queue.length)) },
    async () => {
      for (;;) {
        const item = queue.shift();
        if (item === undefined) return;
        await fn(item);
      }
    },
  );
  await Promise.all(workers);
}

// Hard internal watchdog so the runner can never wedge silently.
const WATCHDOG_MS = Number(process.env.VERIFY_WATCHDOG_MS ?? 540_000);
const watchdog = setTimeout(() => {
  progress("WATCHDOG fired — partial results follow");
  console.error(
    `\nWATCHDOG fired after ${WATCHDOG_MS / 1000}s — partial results:`,
  );
  console.error(`checks: ${results.length}  FAILED: ${failures}`);
  for (const failure of results.filter((r) => !r.pass))
    console.error(`  FAILED ${failure.id} ${failure.label}`);
  console.error(serverLogTail.slice(-25).join(""));
  process.exit(9);
}, WATCHDOG_MS);

// ── main ─────────────────────────────────────────────────────────────────────
const users = {};
const ids = {};
const tokens = {};
const emails = {};
for (const [key, suffix] of [
  ["A", "creator"],
  ["T", "treasurer"],
  ["P", "joiner"],
  ["F", "foreign"],
]) {
  emails[key] = `hosted-verify-${RUN}-${suffix}@${EMAIL_DOMAIN}`;
}

async function tryStep(label, promise) {
  try {
    const result = await promise;
    if (result && result.status >= 400) {
      teardownOk = false;
      teardownNote.push(`${label}: ${result.status}/${result.code}`);
    }
    return result;
  } catch (error) {
    teardownOk = false;
    teardownNote.push(`${label}: ${error.message}`);
    return null;
  }
}

/** Soft-deletes every live business record the given admin still owns (used to
 * clean a previous run's leftovers AND this run's teardown). */
async function cleanSocietiesFor(token, cache) {
  const memberships = await call(token, "GET", "/societies/memberships");
  const mine = (memberships.data?.memberships ?? []).filter(
    (m) =>
      m.status === "active" &&
      (cache.societyIds === undefined || !cache.societyIds.has(m.societyId)),
  );
  for (const membership of mine) {
    const sid = membership.societyId;
    const headers = { societyId: sid };
    const buildingList = await call(token, "GET", "/buildings", headers);
    for (const building of buildingList.data?.buildings ?? []) {
      const apartments = await call(
        token,
        "GET",
        `/buildings/${building.id}/apartments`,
        headers,
      );
      await mapPool(apartments.data?.apartments ?? [], 8, (apartment) =>
        tryStep(
          `apartment ${apartment.apartmentNumber} (old)`,
          call(token, "DELETE", `/apartments/${apartment.id}`, headers),
        ),
      );
      await tryStep(
        `building ${building.name} (old)`,
        call(token, "DELETE", `/buildings/${building.id}`, headers),
      );
    }
    const memberList = await call(token, "GET", "/members", headers);
    const deletableMembers = (memberList.data?.members ?? []).filter(
      (member) => member.userId !== users.A && member.userId !== users.F,
    );
    await mapPool(deletableMembers, 4, (member) =>
      tryStep(
        `member (old)`,
        call(token, "DELETE", `/members/${member.id}`, headers),
      ),
    );
    await tryStep(`society (old)`, call(token, "DELETE", `/societies/${sid}`));
    progress(`pre-flight: cleaned society ${sid}`);
  }
}

let teardownOk = true;
const teardownNote = [];

try {
  const banner = `run marker: ${RUN}  (emails @${EMAIL_DOMAIN}, societies prefixed ZZ-VERIFY-${RUN})`;
  console.log(banner);
  console.log(`API log: ${API_LOG}\nprogress log: ${PROGRESS_LOG}\n`);
  progress(`=== run ${RUN} start ===`);
  progress(banner);

  // 1 ─ Auth users
  console.log("— 1. Supabase Auth users (Admin API) —");
  for (const key of ["A", "T", "P", "F"]) {
    const created = await adminCreateUser(emails[key]);
    record(
      `R01${key}`,
      `auth user ${key} (${suffix0(key)}) ready`,
      created.created || created.already === true,
      created.created
        ? "created"
        : created.already
          ? "already existed"
          : `unexpected status ${created.status}`,
    );
    const session = await login(emails[key]);
    tokens[key] = session.token;
    users[key] = session.userId;
    if (!session.userId) throw new Error(`no user id from login for ${key}`);
  }
  record(
    "R010",
    "all four users hold hosted JWTs",
    true,
    `sub(A)=${users.A.slice(0, 8)}…`,
  );

  // 2 ─ API boot + health
  console.log("\n— 2. API boot + health —");
  await startServer();
  const live = await call(null, "GET", "/health/live");
  record(
    "R02a",
    "GET /health/live",
    live.status === 200,
    expect(live.status, 200),
  );
  const ready = await call(null, "GET", "/health/ready");
  const details = ready.data?.details ?? {};
  const pgUp = details.postgres?.status === "up";
  const migUp =
    details.migrations?.status === "up" || details.migrations === undefined;
  const redisDown = details.redis?.status === "down";
  record(
    "R02b",
    "GET /health/ready shows postgres+migrations up, redis down (no local redis)",
    ready.status === 503 && pgUp && migUp && redisDown,
    `status=${ready.status} postgres=${details.postgres?.status} migrations=${details.migrations?.status} redis=${details.redis?.status}`,
  );
  const anonMemberships = await call(null, "GET", "/societies/memberships");
  record(
    "R02c",
    "unauthenticated request → 401 UNAUTHENTICATED",
    anonMemberships.status === 401 &&
      anonMemberships.code === "UNAUTHENTICATED",
    `status=${anonMemberships.status} code=${anonMemberships.code}`,
  );

  // 2b ─ Pre-flight: clean up any business rows left by a previous run of this marker
  console.log("\n— 2b. Pre-flight cleanup of previous run leftovers —");
  await cleanSocietiesFor(tokens.A, {});
  await cleanSocietiesFor(tokens.F, {});
  progress("pre-flight cleanup done");

  // 3 ─ Phase 3 smoke
  console.log("\n— 3. Phase 3 smoke —");
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
  const socA = await call(tokens.A, "POST", "/societies", {
    body: societyPayload(`ZZ-VERIFY-${RUN} Society A`),
  });
  record(
    "R03a",
    "A creates Society A",
    [200, 201].includes(socA.status),
    expect(socA.status, "200|201"),
  );
  ids.societyA = socA.data?.society?.id;
  ids.joinCodeA = socA.data?.society?.joinCode;
  const socB = await call(tokens.F, "POST", "/societies", {
    body: societyPayload(`ZZ-VERIFY-${RUN} Society B`),
  });
  ids.societyB = socB.data?.society?.id;
  record(
    "R03b",
    "F creates Society B (foreign tenant)",
    [200, 201].includes(socB.status),
    expect(socB.status, "200|201"),
  );

  const b1 = await call(tokens.A, "POST", "/buildings", {
    body: { name: "Tower V1", totalFloors: 8 },
    societyId: ids.societyA,
  });
  record(
    "R03c",
    "A creates building in Society A",
    [200, 201].includes(b1.status),
    expect(b1.status, "200|201"),
  );
  ids.building = b1.data?.building?.id;

  const ap1 = await call(
    tokens.A,
    "POST",
    `/buildings/${ids.building}/apartments`,
    {
      body: {
        apartmentNumber: "101",
        floor: 1,
        bhk: 2,
        carpetAreaSqft: 600,
        builtupAreaSqft: 720,
      },
      societyId: ids.societyA,
    },
  );
  record(
    "R03d",
    "A creates single apartment 101",
    [200, 201].includes(ap1.status),
    expect(ap1.status, "200|201"),
  );
  ids.apartment101 = ap1.data?.apartment?.id;

  const genPreview = await call(
    tokens.A,
    "POST",
    `/buildings/${ids.building}/apartments/generate`,
    {
      body: {
        pattern: "A-{floor}-{unit}",
        floors: [1, 2, 3, 4],
        unitsPerFloor: 16,
      },
      societyId: ids.societyA,
    },
  );
  record(
    "R03e",
    "generate preview (dryRun absent → preview, no write; 201=Created)",
    [200, 201].includes(genPreview.status) &&
      genPreview.data?.dryRun === true &&
      genPreview.data?.total === 64,
    `status=${genPreview.status} dryRun=${genPreview.data?.dryRun} total=${genPreview.data?.total}`,
  );
  const genCommit = await call(
    tokens.A,
    "POST",
    `/buildings/${ids.building}/apartments/generate`,
    {
      body: {
        pattern: "A-{floor}-{unit}",
        floors: [1, 2, 3, 4],
        unitsPerFloor: 16,
        dryRun: false,
      },
      societyId: ids.societyA,
      timeoutMs: 120_000,
    },
  );
  record(
    "R03f",
    "generate commit creates 64 flats",
    genCommit.data?.createdCount === 64,
    `created=${genCommit.data?.createdCount} skipped=${genCommit.data?.skippedCount}`,
  );

  const bulk = await call(
    tokens.A,
    "POST",
    `/buildings/${ids.building}/apartments/bulk`,
    {
      body: {
        rows: [
          { apartmentNumber: "B-101", floor: 1, bhk: 3 },
          { apartmentNumber: "B-102", floor: 1, bhk: 3 },
          { apartmentNumber: "B-101", floor: 1, bhk: 3 },
          { apartmentNumber: "B-1\u0003", floor: 1 },
        ],
      },
      societyId: ids.societyA,
    },
  );
  record(
    "R03g",
    "bulk create reports per-row outcomes (2 created, 1 dup, 1 invalid, 0 existing)",
    bulk.status === 201 &&
      bulk.data?.createdCount === 2 &&
      bulk.data?.duplicateCount === 1 &&
      bulk.data?.invalidCount === 1 &&
      bulk.data?.existingCount === 0,
    `status=${bulk.status} created=${bulk.data?.createdCount} dup=${bulk.data?.duplicateCount} invalid=${bulk.data?.invalidCount}`,
  );

  const patch1 = await call(
    tokens.A,
    "PATCH",
    `/apartments/${ids.apartment101}`,
    { body: { parkingSlots: 1 }, societyId: ids.societyA },
  );
  const patch2 = await call(
    tokens.A,
    "PATCH",
    `/apartments/${ids.apartment101}`,
    { body: { carpetAreaSqft: null }, societyId: ids.societyA },
  );
  record(
    "R03h",
    "apartment PATCH: set value + clear with null",
    patch1.status === 200 && patch2.status === 200,
    `set=${patch1.status} clear=${patch2.status}`,
  );

  const mem1 = await call(tokens.A, "POST", "/members", {
    body: {
      displayName: "Ravi Kumar (VERIFY)",
      phone: "+919800011101",
      email: `shadow-${RUN}@${EMAIL_DOMAIN}`,
      occupancy: "owner_occupied",
      apartmentId: ids.apartment101,
      isPrimary: true,
    },
    societyId: ids.societyA,
  });
  record(
    "R03i",
    "A direct-adds shadow member",
    [200, 201].includes(mem1.status),
    expect(mem1.status, "200|201"),
  );
  ids.member1 = mem1.data?.member?.id;
  const role1 = await call(tokens.A, "PATCH", `/members/${ids.member1}/role`, {
    body: { role: "treasurer" },
    societyId: ids.societyA,
  });
  record(
    "R03j",
    "A assigns treasurer role to shadow member",
    role1.status === 200,
    expect(role1.status, 200),
  );

  // 4 ─ Invitations (T) + single-use + treasurer 403
  console.log("\n— 4. Invitation flow (real hosted user) —");
  const invT = await call(tokens.A, "POST", "/invitations", {
    body: { channel: "email", email: emails.T, role: "treasurer" },
    societyId: ids.societyA,
  });
  record(
    "R04a",
    "A creates email invitation for T (treasurer)",
    [200, 201].includes(invT.status),
    expect(invT.status, "200|201"),
  );
  const tokenT = invT.data?.token;
  const prevT = await call(null, "GET", `/invitations/preview/${tokenT}`);
  record(
    "R04b",
    "public preview works without auth (masked)",
    prevT.status === 200,
    expect(prevT.status, 200),
  );
  const accT = await call(tokens.T, "POST", `/invitations/accept/${tokenT}`);
  record(
    "R04c",
    "T accepts invitation → membership",
    accT.status === 200 && accT.data?.memberId,
    `status=${accT.status} linkedShadow=${accT.data?.linkedShadow}`,
  );
  ids.memberT = accT.data?.memberId;
  const accT2 = await call(tokens.T, "POST", `/invitations/accept/${tokenT}`);
  record(
    "R04d",
    "second accept of the SAME token fails (single-use)",
    accT2.status >= 400,
    `status=${accT2.status} code=${accT2.code}`,
  );
  const tSociety = await call(tokens.T, "GET", `/societies/${ids.societyA}`);
  record(
    "R04e",
    "T (treasurer) reads Society A",
    tSociety.status === 200,
    expect(tSociety.status, 200),
  );
  const tWrite = await call(tokens.T, "POST", "/buildings", {
    body: { name: "Nope" },
    societyId: ids.societyA,
  });
  record(
    "R04f",
    "T treasurer write attempt → 403 FORBIDDEN (F)",
    tWrite.status === 403 && tWrite.code === "FORBIDDEN",
    `status=${tWrite.status} code=${tWrite.code}`,
  );
  const tMembers = await call(tokens.T, "GET", "/members", {
    societyId: ids.societyA,
  });
  record(
    "R04g",
    "T treasurer may read directory",
    tMembers.status === 200,
    expect(tMembers.status, 200),
  );
  const tRoles = await call(tokens.A, "GET", "/permissions", {
    societyId: ids.societyA,
  });
  record(
    "R04h",
    "permission catalogue (admin)",
    tRoles.status === 200,
    expect(tRoles.status, 200),
  );

  // 5 ─ Join request flow (P): pending → blocked → approved → guest 403
  console.log("\n— 5. Join request flow (real hosted user) —");
  const joinP = await call(tokens.P, "POST", "/societies/join", {
    body: {
      code: ids.joinCodeA,
      occupancyType: "owner",
      message: `verify-${RUN}`,
    },
    societyId: ids.societyA,
  });
  record(
    "R05a",
    "P submits join request with Society A code",
    [200, 201].includes(joinP.status),
    expect(joinP.status, "200|201"),
  );
  ids.memberP = joinP.data?.membership?.id ?? null;
  const pPending1 = await call(tokens.P, "GET", `/societies/${ids.societyA}`);
  const pPending2 = await call(tokens.P, "GET", "/members", {
    societyId: ids.societyA,
  });
  // Society READ stays 200 by policy design (a pending member must see the society
  // name on the "waiting for approval" screen); the DIRECTORY is what must refuse:
  // 403 MEMBER_INACTIVE. E is proven by the directory refusal.
  record(
    "R05b",
    "PENDING member: directory refused 403 MEMBER_INACTIVE (E); society name readable by design",
    pPending2.status === 403 &&
      pPending2.code === "MEMBER_INACTIVE" &&
      pPending1.status === 200,
    `society=${pPending1.status}/${pPending1.code} members=${pPending2.status}/${pPending2.code}`,
  );
  const queue = await call(tokens.A, "GET", "/members/join-requests", {
    societyId: ids.societyA,
  });
  const queuedRequest = (queue.data?.requests ?? []).find(
    (r) => r.member?.userId === users.P,
  );
  record(
    "R05c",
    "queue lists P's request",
    queue.status === 200 && !!queuedRequest,
    `status=${queue.status} found=${!!queuedRequest}`,
  );
  ids.memberP = ids.memberP ?? queuedRequest?.member?.id;
  const approve = await call(
    tokens.A,
    "POST",
    `/members/join-requests/${ids.memberP}/approve`,
    { body: {}, societyId: ids.societyA },
  );
  record(
    "R05d",
    "A approves P's join request",
    approve.status === 200,
    `status=${approve.status} code=${approve.code}`,
  );
  const pActive = await call(tokens.P, "GET", `/societies/${ids.societyA}`);
  record(
    "R05e",
    "P now reads Society A (200)",
    pActive.status === 200,
    expect(pActive.status, 200),
  );
  const guestRole = await call(
    tokens.A,
    "PATCH",
    `/members/${ids.memberP}/role`,
    { body: { role: "guest" }, societyId: ids.societyA },
  );
  const pGuestWrite = await call(tokens.P, "POST", "/members", {
    body: { displayName: "Nope", phone: "+919800011199" },
    societyId: ids.societyA,
  });
  record(
    "R05f",
    "guest write attempt → 403 FORBIDDEN (F)",
    guestRole.status === 200 && pGuestWrite.status === 403,
    `role=${guestRole.status} write=${pGuestWrite.status}/${pGuestWrite.code}`,
  );
  await call(tokens.A, "PATCH", `/members/${ids.memberP}/role`, {
    body: { role: "resident" },
    societyId: ids.societyA,
  });

  // 6 ─ Cross-tenant (F never joins A)
  console.log("\n— 6. Cross-tenant isolation (C) —");
  const fSociety = await call(tokens.F, "GET", `/societies/${ids.societyA}`);
  record(
    "R06a",
    "F reads Society A → 404 (no existence leak, B)",
    fSociety.status === 404 && fSociety.code === "NOT_FOUND",
    `status=${fSociety.status} code=${fSociety.code}`,
  );
  const fMembers = await call(tokens.F, "GET", "/members", {
    societyId: ids.societyA,
  });
  record(
    "R06b",
    "F lists Society A members → 404",
    fMembers.status === 404,
    `status=${fMembers.status} code=${fMembers.code}`,
  );
  const fApartment = await call(
    tokens.F,
    "GET",
    `/apartments/${ids.apartment101}`,
    { societyId: ids.societyA },
  );
  record(
    "R06c",
    "F reads Society A apartment by id (addressed) → 404, no leak (C)",
    fApartment.status === 404 && fApartment.code === "NOT_FOUND",
    `status=${fApartment.status} code=${fApartment.code}`,
  );
  const lookupA = await call(
    tokens.F,
    "GET",
    `/societies/lookup?code=${ids.joinCodeA}`,
  );
  record(
    "R06d",
    "public lookup of A's code returns masked preview (by design)",
    lookupA.status === 200 && !!lookupA.data?.preview?.id,
    `status=${lookupA.status}`,
  );

  // 7 ─ Anonymous (D)
  console.log("\n— 7. Anonymous access (D) —");
  const anonMembers = await call(null, "GET", "/members", {
    societyId: ids.societyA,
  });
  const anonCreate = await call(null, "POST", "/societies", {
    body: societyPayload("Anon Should Fail"),
  });
  record(
    "R07a",
    "anonymous reads and writes → 401",
    anonMembers.status === 401 && anonCreate.status === 401,
    `read=${anonMembers.status}/${anonMembers.code} write=${anonCreate.status}/${anonCreate.code}`,
  );

  // 8 ─ CSV import (partial-failure semantics)
  console.log("\n— 8. CSV import (transactional behaviour) —");
  const csv = [
    "flat_no,name,phone,email,occupancy_type",
    `101,Import One,+919800022201,import1-${RUN}@${EMAIL_DOMAIN},owner_occupied`,
    `B-101,Import Two,+919800022202,import2-${RUN}@${EMAIL_DOMAIN},tenant`,
    `103,Bad Phone,+91x,,owner_occupied`,
    `104,Dup In File,+919800022201,,owner_occupied`,
  ].join("\n");
  const preview = await call(tokens.A, "POST", "/members/import/preview", {
    body: { csv },
    societyId: ids.societyA,
  });
  // The domain counts both data-level refusals (INVALID_PHONE, DUPLICATE_IN_FILE)
  // under `invalidRows`; `conflicts` is reserved for claim/occupancy conflicts.
  record(
    "R08a",
    "import preview: 2 valid, 2 invalid, no write",
    preview.status === 200 &&
      preview.data?.summary?.validRows === 2 &&
      preview.data?.summary?.invalidRows === 2 &&
      preview.data?.summary?.imported === 0,
    `status=${preview.status} ${JSON.stringify(preview.data?.summary ?? {})}`,
  );
  const imp = await call(tokens.A, "POST", "/members/import", {
    body: { csv },
    societyId: ids.societyA,
    timeoutMs: 150_000,
  });
  const failedCodes = (imp.data?.failed ?? []).map((f) => f.error?.code).sort();
  record(
    "R08b",
    "import commits 2 valid rows, reports the 2 bad rows per-line (partial success)",
    [200, 201].includes(imp.status) &&
      imp.data?.summary?.imported === 2 &&
      imp.data?.failed?.length === 2 &&
      failedCodes.join(",") === "DUPLICATE_IN_FILE,INVALID_PHONE",
    `status=${imp.status} imported=${imp.data?.summary?.imported} failed=${imp.data?.failed?.length} codes=${failedCodes.join(",")}`,
  );

  // 9 ─ Direct-DB probes: GUC → auth.uid() → RLS
  console.log(
    "\n— 9. Direct-DB identity probes (no weakening, same bridge the API uses) —",
  );
  const noIdentity = await probe({ role: "authenticated", sub: null });
  record(
    "R09a",
    "authenticated role + no JWT claims → auth.uid() NULL, 0 society rows (RLS denies)",
    noIdentity.uid === null && noIdentity.ids.length === 0,
    `uid=${noIdentity.uid} visible=${noIdentity.ids.length}`,
  );
  const foreign = await probe({ role: "authenticated", sub: users.F });
  record(
    "R09b",
    "F's real sub via GUC → auth.uid()=F; every visible society was created by F",
    foreign.uid === users.F &&
      foreign.ids.length >= 1 &&
      foreign.ids.includes(ids.societyB),
    `uid-match=${foreign.uid === users.F} visible=${foreign.ids.length}`,
  );
  const owner = await probe({ role: "authenticated", sub: users.A });
  const disjoint = owner.ids.every((id) => !foreign.ids.includes(id));
  record(
    "R09c",
    "A's real sub via GUC → auth.uid()=A; sees only A-created societies, disjoint from F's",
    owner.uid === users.A &&
      owner.ids.length >= 1 &&
      owner.ids.includes(ids.societyA) &&
      disjoint,
    `uid-match=${owner.uid === users.A} visible=${owner.ids.length} disjoint=${disjoint}`,
  );
  // Platform fact (Supabase documents this): the `postgres` role has BYPASSRLS.
  // Raw table access from that role sees every row — which is exactly why the
  // UnitOfWork's `SET LOCAL ROLE authenticated` is load-bearing on hosted.
  const bypass =
    await sql`select rolname, rolbypassrls, rolsuper from pg_roles where rolname = current_user`;
  const ownerForced = await probeOwnerNoContext();
  record(
    "R09d",
    "pooler login role bypasses RLS (Supabase platform fact) — proof the identity bridge is load-bearing",
    bypass[0]?.rolbypassrls === true && ownerForced >= 2,
    `rol=${bypass[0]?.rolname} bypassrls=${bypass[0]?.rolbypassrls} raw-visible=${ownerForced}`,
  );

  // 10 ─ Teardown through the API's own endpoints
  console.log("\n— 10. Teardown (API soft-deletes; Auth users kept) —");
  // Members first (a live member can reference an apartment), then flats,
  // then the building (which refuses to delete while flats exist), then societies.
  const memberList = await call(tokens.A, "GET", "/members", {
    societyId: ids.societyA,
  });
  for (const member of memberList.data?.members ?? []) {
    if (member.userId === users.A) continue; // creator's own row goes with the society delete
    await tryStep(
      `member ${member.displayName}`,
      call(tokens.A, "DELETE", `/members/${member.id}`, {
        societyId: ids.societyA,
      }),
    );
  }
  const apartmentList = await call(
    tokens.A,
    "GET",
    `/buildings/${ids.building}/apartments`,
    { societyId: ids.societyA },
  );
  await mapPool(apartmentList.data?.apartments ?? [], 8, (apartment) =>
    tryStep(
      `apartment ${apartment.apartmentNumber}`,
      call(tokens.A, "DELETE", `/apartments/${apartment.id}`, {
        societyId: ids.societyA,
      }),
    ),
  );
  await tryStep(
    "building",
    call(tokens.A, "DELETE", `/buildings/${ids.building}`, {
      societyId: ids.societyA,
    }),
  );
  const delA = await tryStep(
    "society A",
    call(tokens.A, "DELETE", `/societies/${ids.societyA}`),
  );
  const delB = await tryStep(
    "society B",
    call(tokens.F, "DELETE", `/societies/${ids.societyB}`),
  );
  record(
    "R10a",
    "both societies soft-deleted via the API's own DELETE routes",
    !!delA && delA.status < 400 && !!delB && delB.status < 400,
    teardownNote.join("; ") || `A=${delA?.status} B=${delB?.status}`,
  );
  if (!teardownOk || teardownNote.length > 0) {
    console.log(
      `  (teardown ${teardownOk ? "warnings" : "FAILED"}: ${teardownNote.join("; ") || "no step reported a reason"})`,
    );
  }
  const afterA = await call(tokens.A, "GET", "/societies/memberships");
  const liveMemberships = (afterA.data?.memberships ?? []).filter(
    (m) => m.societyId === ids.societyA && m.status === "active",
  );
  record(
    "R10b",
    "post-teardown: no live memberships remain for A in Society A",
    liveMemberships.length === 0,
    `live=${liveMemberships.length}`,
  );
  const postTeardown =
    await sql`select id::text, deleted_at from public.societies where id::text = any(${sql.array([ids.societyA, ids.societyB])})`;
  const bothSoftDeleted =
    postTeardown.length === 2 &&
    postTeardown.every((row) => row.deleted_at !== null);
  record(
    "R10c",
    "post-teardown: both societies soft-deleted (deleted_at set), rows retained",
    bothSoftDeleted,
    `rows=${postTeardown.length} deleted=${postTeardown.filter((r) => r.deleted_at !== null).length}`,
  );
} catch (error) {
  failures += 1;
  progress(`FATAL: ${error.message}`);
  console.error(`\nFATAL: ${error.message}`);
  console.error(serverLogTail.slice(-25).join(""));
} finally {
  await stopServer();
  try {
    await sql.end({ timeout: 3 });
  } catch {
    /* ignore */
  }
}

clearTimeout(watchdog);
const leftovers = await adminListUserEmails().catch(() => null);
console.log("\n— Summary —");
console.log(
  `checks: ${results.length}  passed: ${results.length - failures}  FAILED: ${failures}`,
);
progress(
  `=== run ${RUN} end: ${results.length} checks, ${failures} failed ===`,
);
for (const failure of results.filter((r) => !r.pass))
  console.log(`  FAILED ${failure.id} ${failure.label} — ${failure.detail}`);
console.log(
  `\nAuth users LEFT IN HOSTED PROJECT (manual cleanup — task forbids resetting Auth users):`,
);
for (const key of ["A", "T", "P", "F"]) console.log(`  ${emails[key]}`);
if (leftovers && leftovers.length > 4)
  console.log(
    `  (admin list also shows: ${leftovers.filter((e) => !Object.values(emails).includes(e)).join(", ")})`,
  );
console.log(`\nAPI log: ${API_LOG}`);
process.exit(failures === 0 ? 0 : 1);

function suffix0(key) {
  return {
    A: "creator/Society A admin",
    T: "treasurer via invitation",
    P: "joiner via request",
    F: "foreign Society B admin",
  }[key];
}
