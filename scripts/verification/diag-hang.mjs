/**
 * One-shot diagnostic for the hosted `POST /buildings` hang.
 *
 * Reuses the previous verify run's throwaway users (RUN marker known from the
 * API log filename), re-logs in, starts the API, replays the failing request,
 * and — while it is in flight — dumps `pg_stat_activity` / locks from the
 * OWNER connection (migrations URL) to see exactly what the API's session is
 * waiting on. Hard watchdog guarantees exit.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN = "9fc89b"; // previous run marker (API log: ses-verify-api-9fc89b.log)
const PORT = 3011;
const BASE = `http://127.0.0.1:${PORT}/v1`;
const PASSWORD =
  process.env.HOSTED_VERIFY_PASSWORD ?? "VerifyOnly-NotASecret-2026!";
const EMAIL = `hosted-verify-${RUN}-creator@verify.ses.test`;

const require0 = (name) => {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}`);
    process.exit(2);
  }
  return v;
};
const SUPABASE_URL = require0("SUPABASE_URL");
const SERVICE_KEY = require0("SUPABASE_SERVICE_ROLE_KEY");
const OWNER_URL = require0("MIGRATION_DATABASE_URL");
const API_DIR = fileURLToPath(new URL("../../apps/api/", import.meta.url));
const API_LOG = join(tmpdir(), `ses-diag-api-${RUN}.log`);
const { appendFileSync } = await import("node:fs");

const requireFromApi = createRequire(
  fileURLToPath(new URL("../../apps/api/package.json", import.meta.url)),
);
const postgres = requireFromApi("postgres");
const ownerSql = postgres(OWNER_URL, {
  max: 1,
  prepare: false,
  connect_timeout: 15,
  idle_timeout: 5,
});

const watchdog = setTimeout(async () => {
  console.error("\nWATCHDOG fired — dumping activity before exit");
  try {
    await dump("watchdog");
  } catch (e) {
    console.error("dump failed:", e.message);
  }
  console.error("WATCHDOG exit 9");
  process.exit(9);
}, 75_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dump(tag) {
  const rows = await ownerSql`
    select pid,
           coalesce(application_name,'') as app,
           state,
           coalesce(wait_event_type,'') as wait_type,
           coalesce(wait_event,'') as wait_event,
           to_char(now() - xact_start, 'SS"s"') as xact_age,
           to_char(now() - state_change, 'SS"s"') as state_age,
           left(regexp_replace(query, '\\s+', ' ', 'g'), 110) as query
      from pg_stat_activity
     where datname = current_database()
       and pid <> pg_backend_pid()
     order by xact_start nulls last`;
  console.log(`\n--- pg_stat_activity (${tag}) ---`);
  for (const r of rows) {
    console.log(
      `pid=${r.pid} app=${r.app} state=${r.state} wait=${r.wait_type}/${r.wait_event} xact=${r.xact_age} stateAge=${r.state_age} q=${r.query}`,
    );
  }
  const idleTx = rows.filter((r) => r.state === "idle in transaction").length;
  const apiActive = rows.filter((r) => r.app === "ses-api").length;
  console.log(
    `summary: ses-api sessions=${apiActive} idle-in-tx=${idleTx} total=${rows.length}`,
  );
}

async function login() {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`login HTTP ${res.status}`);
  return body.access_token;
}

async function call(token, method, path, extraHeaders = {}) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    return `HTTP ${res.status} in ${Date.now() - started}ms body=${text.slice(0, 220)}`;
  } catch (error) {
    return `FETCH FAILED after ${Date.now() - started}ms: ${error.name}: ${error.message}`;
  }
}

const server = spawn("node", ["dist/main.js"], {
  cwd: API_DIR,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (c) => appendFileSync(API_LOG, c));
server.stderr.on("data", (c) => appendFileSync(API_LOG, c));

try {
  const token = await login();
  console.log("login OK");

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/health/live`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (r.ok) break;
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error("API never became live");
    await sleep(1_000);
  }
  console.log("API live");

  console.log(
    "memberships →",
    await call(token, "GET", "/societies/memberships"),
  );

  // Find the leftover society id from the previous run.
  const res = await fetch(`${BASE}/societies/memberships`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => null);
  const memberships = body?.data?.memberships ?? [];
  let societyId =
    memberships.find((m) => m.status === "active")?.societyId ?? null;
  console.log("leftover society id:", societyId);
  if (!societyId) {
    console.log(
      "no leftover society — creating one to reproduce the guard path",
    );
    const created = await fetch(`${BASE}/societies`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: `ZZ-DIAG-${RUN}`,
        type: "apartment",
        city: "Diag",
        state: "Diag",
        billingDay: 5,
        dueDay: 10,
        approvalThresholdPaise: 0,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const createdBody = await created.json().catch(() => null);
    console.log(
      "create:",
      created.status,
      createdBody?.data?.society?.id ??
        JSON.stringify(createdBody).slice(0, 200),
    );
    societyId = createdBody?.data?.society?.id;
  }

  await dump("before-buildings");

  // Fire the request that hung last time — capture the promise, dump activity
  // while it is in flight, then read the result.
  const t0 = Date.now();
  const pendingBody = fetch(`${BASE}/buildings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-society-id": societyId,
    },
    body: JSON.stringify({ name: "Diag Tower", totalFloors: 3 }),
    signal: AbortSignal.timeout(30_000),
  })
    .then(
      async (r) =>
        `HTTP ${r.status} in ${Date.now() - t0}ms body=${(await r.text()).slice(0, 220)}`,
    )
    .catch((e) => `buildings FETCH FAILED: ${e.name}: ${e.message}`);

  await sleep(8_000);
  await dump("t+8s");
  await sleep(7_000);
  await dump("t+15s");

  console.log("\nbuildings result:", await pendingBody);
  console.log(
    "memberships again →",
    await call(token, "GET", "/societies/memberships"),
  );
  await dump("final");
  clearTimeout(watchdog);
  console.log("\nDIAG COMPLETE");
} catch (error) {
  console.error("DIAG ERROR:", error.message);
} finally {
  server.kill("SIGTERM");
  try {
    await ownerSql.end({ timeout: 3 });
  } catch {
    /* ignore */
  }
  await sleep(1_000);
}
process.exit(0);
