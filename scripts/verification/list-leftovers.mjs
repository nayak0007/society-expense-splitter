/**
 * Read-only enumeration of verification leftovers on hosted Supabase.
 * Lists every society whose name carries the ZZ-VERIFY- marker (live and
 * soft-deleted), plus its members and the caller-visible counts under
 * `SET LOCAL ROLE authenticated` for the creator identity.
 * Never writes anything.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const requireFromApi = createRequire(
  fileURLToPath(new URL("../../apps/api/package.json", import.meta.url)),
);
const postgres = requireFromApi("postgres");

const env = {};
for (const line of readFileSync(
  fileURLToPath(new URL("../../apps/api/.env", import.meta.url)),
  "utf8",
).split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const ownerSql = postgres(env.MIGRATION_DATABASE_URL, {
  max: 1,
  prepare: false,
  connect_timeout: 20,
});

const societies = await ownerSql`
  select s.id::text as id, s.name, s.created_by::text as created_by,
         s.deleted_at is not null as deleted, s.created_at
    from public.societies s
   where s.name like 'ZZ-VERIFY-%'
   order by s.created_at`;

console.log(`ZZ-VERIFY societies: ${societies.length}`);
for (const s of societies) {
  console.log(
    `  ${s.id}  deleted=${s.deleted}  created_by=${s.created_by.slice(0, 8)}…  "${s.name}"`,
  );
}

const members = await ownerSql`
  select m.society_id::text as society_id, m.user_id::text as user_id, m.role, m.status
    from public.members m
   where m.society_id in (select id from public.societies where name like 'ZZ-VERIFY-%')
   order by m.society_id`;
console.log(`\nmembers of those societies: ${members.length}`);
for (const m of members) {
  const who = m.user_id
    ? `${m.user_id.slice(0, 8)}…`
    : "(unclaimed invite row)";
  console.log(
    `  society ${m.society_id.slice(0, 8)}…  user ${who}  ${m.role}/${m.status}`,
  );
}

const liveDocs = await ownerSql`
  select (select count(*)::int from public.buildings b
            where b.society_id in (select id from public.societies where name like 'ZZ-VERIFY-%')) as buildings,
         (select count(*)::int from public.apartments a
            where a.society_id in (select id from public.societies where name like 'ZZ-VERIFY-%')) as apartments,
         (select count(*)::int from public.invitations i
            where i.society_id in (select id from public.societies where name like 'ZZ-VERIFY-%')) as invitations`;
console.log(`\nrelated rows on leftovers: ${JSON.stringify(liveDocs[0])}`);

const runtimeSql = postgres(env.DATABASE_URL, {
  max: 1,
  prepare: false,
  connect_timeout: 20,
});
for (const s of societies.filter((x) => !x.deleted)) {
  const count = await runtimeSql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE authenticated");
    await tx.unsafe("SELECT set_config('request.jwt.claim.sub', $1, true)", [
      s.created_by,
    ]);
    await tx.unsafe("SELECT set_config('app.user_id', $1, true)", [
      s.created_by,
    ]);
    await tx.unsafe("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: s.created_by, role: "authenticated" }),
    ]);
    const r = await tx.unsafe(
      "SELECT count(*)::int AS n FROM public.societies",
    );
    return r[0].n;
  });
  const all = await runtimeSql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE authenticated");
    await tx.unsafe("SELECT set_config('request.jwt.claim.sub', $1, true)", [
      s.created_by,
    ]);
    await tx.unsafe("SELECT set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: s.created_by, role: "authenticated" }),
    ]);
    const r = await tx.unsafe(
      "SELECT count(*)::int AS n FROM public.societies WHERE deleted_at IS NULL",
    );
    return r[0].n;
  });
  console.log(
    `creator ${s.created_by.slice(0, 8)}… : societies visible via auth.uid()=${count}, of which live=${all}`,
  );
}

await ownerSql.end({ timeout: 3 });
await runtimeSql.end({ timeout: 3 });
