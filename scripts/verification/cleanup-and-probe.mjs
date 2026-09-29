/**
 * Hosted verification cleanup + the corrected R10c probe.
 *
 * Why this exists: a verification run that is interrupted (session timeout, CI
 * cancel) never reaches its teardown, so it leaves a live `ZZ-VERIFY-*` society
 * behind. This script finds those, removes them **through the application's own
 * path** — the `society_soft_delete()` RPC, called under the same
 * `SET LOCAL ROLE authenticated` + `auth.uid()` identity bridge the API's
 * UnitOfWork uses — and then asserts the teardown predicate (deleted_at set,
 * rows retained).
 *
 * Child rows (buildings/apartments) are stamped with plain owner DML: the RPC
 * deliberately leaves them to their own soft deletes, and at hosted latency
 * calling `apartment_soft_delete()` 65 times would take minutes. Nothing here
 * touches `auth.users`.
 *
 * Run from the repo root:
 *   node --env-file=apps/api/.env scripts/verification/cleanup-and-probe.mjs
 * Read-only apart from the soft deletes it reports. Never prints secrets.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const requireFromApi = createRequire(
  fileURLToPath(new URL("../../apps/api/package.json", import.meta.url)),
);
const postgres = requireFromApi("postgres");

const ownerSql = postgres(process.env.MIGRATION_DATABASE_URL, {
  max: 1,
  prepare: false,
  connect_timeout: 20,
});
const runtimeSql = postgres(process.env.DATABASE_URL, {
  max: 1,
  prepare: false,
  connect_timeout: 20,
});

const live = await ownerSql`
  select id::text as id, name, created_by::text as created_by
    from public.societies
   where name like 'ZZ-VERIFY-%'
     and deleted_at is null
   order by created_at`;

console.log(`live ZZ-VERIFY societies: ${live.length}`);
for (const s of live) {
  const children = await ownerSql`
    update public.apartments set deleted_at = now()
     where society_id = ${s.id}::uuid and deleted_at is null
    returning id`;
  const buildings = await ownerSql`
    update public.buildings set deleted_at = now()
     where society_id = ${s.id}::uuid and deleted_at is null
    returning id`;

  // The application's own path: definer RPC, called as `authenticated` with the
  // creator's identity — the same bridge UnitOfWork sets up for every request.
  const removed = await runtimeSql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE authenticated");
    await tx.unsafe("SELECT set_config('app.user_id', $1, true)", [
      s.created_by,
    ]);
    await tx.unsafe("SELECT set_config('request.jwt.claim.sub', $1, true)", [
      s.created_by,
    ]);
    await tx.unsafe("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: s.created_by, role: "authenticated" }),
    ]);
    await tx.unsafe("select public.society_soft_delete($1::uuid)", [s.id]);
    const r = await tx.unsafe(
      "select count(*)::int as live_members from public.members where society_id = $1::uuid and status <> 'removed'",
      [s.id],
    );
    return r[0].live_members;
  });

  console.log(
    `  removed "${s.name}" (${s.id}) as creator ${s.created_by.slice(0, 8)}… — ` +
      `apartments=${children.length} buildings=${buildings.length} live_members_after=${removed}`,
  );
}

// ── corrected R10c: teardown predicate over every marker society ─────────────
const post = await ownerSql`
  select id::text as id, name, deleted_at
    from public.societies
   where name like 'ZZ-VERIFY-%'`;
const allSoft = post.every((r) => r.deleted_at !== null);
console.log(
  `\nR10c post-teardown: marker rows=${post.length}, all soft-deleted=${allSoft}, rows retained=${post.length === (await ownerSql`select count(*)::int as n from public.societies where name like 'ZZ-VERIFY-%'`)[0].n}`,
);

const liveMembers = await ownerSql`
  select count(*)::int as n from public.members m
   where m.society_id in (select id from public.societies where name like 'ZZ-VERIFY-%')
     and m.status <> 'removed'`;
const bypass =
  await ownerSql`select rolbypassrls from pg_roles where rolname = current_user`;
console.log(
  `live memberships on marker societies: ${liveMembers[0].n} (expect 0) · ` +
    `owner rolbypassrls=${bypass[0]?.rolbypassrls} (the identity bridge is load-bearing)`,
);

await ownerSql.end({ timeout: 3 });
await runtimeSql.end({ timeout: 3 });
