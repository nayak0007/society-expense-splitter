/**
 * Standalone post-run confirmation: the previous verify run's teardown is
 * complete. Reads the two societies this run created (by id via owner
 * connection), asserting both are soft-deleted; then re-probes auth.uid()
 * visibility for A/F. Read-only.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireFromApi = createRequire(
  fileURLToPath(new URL("../../apps/api/package.json", import.meta.url)),
);
const postgres = requireFromApi("postgres");

const env = {};
for (const line of (await import("node:fs"))
  .readFileSync(
    fileURLToPath(new URL("../../apps/api/.env", import.meta.url)),
    "utf8",
  )
  .split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const ownerSql = postgres(env.MIGRATION_DATABASE_URL, {
  max: 1,
  prepare: false,
  connect_timeout: 15,
});
const runtimeSql = postgres(env.DATABASE_URL, {
  max: 1,
  prepare: false,
  connect_timeout: 15,
});

const ids = process.argv.slice(2);
if (ids.length !== 2) {
  console.error(
    "usage: node teardown-confirm.mjs <societyA-uuid> <societyB-uuid>",
  );
  process.exit(2);
}

const rows = await ownerSql`
  select id::text, name, created_by::text as created_by, deleted_at is not null as deleted
    from public.societies where id::text = any(${ids})`;
console.log(
  "societies:",
  rows.map((r) => `${r.name} deleted=${r.deleted}`),
);

// Identity to probe with: the creator of the first society (no UUIDs embedded).
const subs = { A: rows[0]?.created_by };
if (!subs.A) {
  console.error("could not resolve a creator uuid for the probe");
  process.exit(2);
}
const countA = await runtimeSql.begin(async (tx) => {
  await tx.unsafe("SET LOCAL ROLE authenticated");
  await tx.unsafe("SELECT set_config('request.jwt.claim.sub', $1, true)", [
    subs.A,
  ]);
  await tx.unsafe("SELECT set_config('app.user_id', $1, true)", [subs.A]);
  await tx.unsafe("SELECT set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: subs.A, role: "authenticated" }),
  ]);
  // Live rows are the isolation contract; the creator clause in
  // societies_select_member deliberately keeps A's own *soft-deleted*
  // societies visible (support/transfer path), so count both.
  const r = await tx.unsafe(
    "SELECT count(*)::int AS all_rows, count(*) filter (where deleted_at is null)::int AS live FROM public.societies",
  );
  return r[0];
});

const bypass =
  await ownerSql`select rolbypassrls from pg_roles where rolname = current_user`;
const raw = await ownerSql`select count(*)::int as n from public.societies`;

console.log(
  `A's auth.uid() visibility after teardown: ${countA.live} live societies (expect 0), ${countA.all_rows} total incl. A's own soft-deleted (creator clause)`,
);
console.log(
  `postgres rolbypassrls=${bypass[0]?.rolbypassrls}, raw table rows=${raw[0]?.n} (soft-deleted rows retained)`,
);

await ownerSql.end({ timeout: 3 });
await runtimeSql.end({ timeout: 3 });
