import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import postgres from "postgres";

/**
 * The project-owned migration runner (ADR-0008).
 *
 * ## Why this exists
 *
 * The schema's source of truth is the ordered SQL in `supabase/migrations/`.
 * Before this runner existed, that SQL was applied by the Supabase CLI on a
 * developer's machine with a linked project — and by **nothing** in CI or on the
 * API's deploy path: `apps/api/src/tools/migrate.ts` pointed Drizzle's migrator
 * at a journal that was never generated, so `db:migrate` printed "No migrations
 * to apply" and exited 0 while the readiness probe reported "no migrations
 * defined" as `up`. A deploy sequence whose critical step is a silent no-op, and
 * a probe that cannot fail, is worse than no tooling at all — it launders the
 * failure into a green check.
 *
 * This runner is now **the single mechanism that applies that SQL in every
 * environment** (ADR-0008): `pnpm db:migrate` locally, the CI `test-db` job, and
 * the deploy pipeline's migrate-before-deploy step. One runner, one ledger, one
 * place where "what the database has" is decided — no second migration path to
 * drift against it.
 *
 * ## Invariants
 *
 * 1. **Checksum ledger.** Every applied file's sha256 is recorded in a private
 *    schema (`ses_meta`). Before touching anything the runner verifies that each
 *    recorded checksum still matches its file — a migration edited after being
 *    applied means the database does not match the repository, and proceeding
 *    would silently fork the schema. (Drizzle's runner records only a relative
 *    hash, and Supabase's records only a timestamp; neither detects this.)
 * 2. **Prefix discipline.** The applied set must be a prefix of the sorted file
 *    list. Applied migrations are immutable: a file deleted from history leaves
 *    a gap that the ledger refuses to paper over.
 * 3. **Per-file transactions.** Each migration runs in its own transaction, so a
 *    failed migration leaves every earlier file applied and itself not applied —
 *    the next run retries exactly it. SQL files that cannot run inside a
 *    transaction (e.g. `CREATE INDEX CONCURRENTLY`) are not supported; none
 *    exist, and the file header template warns against adding one.
 * 4. **Single writer.** A session-level advisory lock guards the whole run, so
 *    two deploy pipelines racing on the same database serialise instead of
 *    interleaving DDL.
 * 5. **Owner connection only.** The runner takes `MIGRATION_DATABASE_URL` — the
 *    role that owns the database — and never the runtime `DATABASE_URL`, whose
 *    role is deliberately too weak to write DDL (SAD §8.7). The connection also
 *    sets a statement timeout of zero: a long migration must not die halfway
 *    because the runtime's 30-second cap applied to it.
 */

/** Schema holding the ledger. Kept out of `public` so RLS never sees it and a
 * `DROP SCHEMA public` (the reset path) can drop the ledger separately. Read
 * access is granted to `authenticated` for the readiness probe. */
const LEDGER_SCHEMA = "ses_meta";
/** Advisory-lock key. Arbitrary constant; only sameness across processes
 * matters. Passed as a plain number — postgres.js accepts numeric parameters,
 * and the value must fit a signed bigint, which any 31-bit constant does. */
const ADVISORY_LOCK_KEY = 847_211;
/** The migration history. One directory, in filename order. */
export const MIGRATIONS_DIR = "supabase/migrations";
/** Files must sort in apply order; the timestamp prefix guarantees it. */
const FILENAME_PATTERN = /^(\d{14})_[a-z0-9][a-z0-9_]*\.sql$/;

export interface MigrationFile {
  /** Filename only, e.g. `20260920120000_auth_profiles.sql`. The ledger key. */
  readonly name: string;
  /** Absolute path on disk. */
  readonly path: string;
  /** sha256 of the file bytes — what the ledger stores and compares. */
  readonly checksum: string;
}

export interface LedgerRow {
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
  readonly appliedBy: string;
  readonly durationMs: number | null;
}

export interface Preflight {
  /** Files on disk that have never been applied, in order. */
  readonly pending: MigrationFile[];
  /** Applied rows whose checksum no longer matches the file — fatal. */
  readonly editedAfterApply: { row: LedgerRow; file: MigrationFile }[];
  /** Ledger rows with no corresponding file — fatal. */
  readonly missingFromDisk: LedgerRow[];
  /** Applied files, ledger-verified. */
  readonly applied: LedgerRow[];
}

/** A migration failed mid-file. The message carries the SQLSTATE and position
 * postgres.js exposes, so a broken migration names itself instead of the
 * runner. */
export class MigrationFailedError extends Error {
  constructor(
    readonly migration: MigrationFile,
    cause: unknown,
  ) {
    const detail =
      cause instanceof Error ? cause.message : String(cause ?? "unknown");
    super(`Migration ${migration.name} failed: ${detail}`, { cause });
    this.name = "MigrationFailedError";
  }
}

/** History discipline violation: edited-after-apply, a file deleted from
 * history, or duplicate timestamps. Fatal in `apply` and `check` both. */
export class HistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

/** Resolves the migrations directory.
 *
 * Order: an explicit value (from `MIGRATIONS_DIR`, read by `src/config` — this
 * module never touches `process.env`, per the SAD T008 rule), else the nearest
 * `supabase/migrations` walking up from `startDir`, else `startDir` itself
 * joined with the default (whose failure `listMigrationFiles` reports with the
 * full path).
 *
 * The walk-up exists because callers run from different working directories:
 * `pnpm --filter @ses/api db:migrate` executes in `apps/api`, root scripts in
 * the repo root, and the container in `/app` — all of which have (or can see)
 * `supabase/migrations` at some parent level.
 */
export function resolveMigrationsDir(
  explicit?: string,
  startDir: string = process.cwd(),
): string {
  if (explicit && explicit !== "") return explicit;

  let current = startDir;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(current, MIGRATIONS_DIR);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(startDir, MIGRATIONS_DIR);
}

export function listMigrationFiles(dir: string): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith(".sql"));
  } catch (error) {
    throw new Error(
      `Cannot read the migrations directory at ${dir}: ${describe(error)}`,
    );
  }

  const files = entries.sort().map((name): MigrationFile => {
    const path = join(dir, name);
    const bytes = readFileSync(path);
    return {
      name,
      path,
      checksum: createHash("sha256").update(bytes).digest("hex"),
    };
  });

  for (const file of files) {
    if (!FILENAME_PATTERN.test(file.name)) {
      throw new HistoryError(
        `Migration filename "${file.name}" does not match ` +
          `YYYYMMDDHHMMSS_subject.sql (14 digits, lowercase subject). ` +
          `Renames break the ledger — generate new files with \`pnpm db:migrate:new\`.`,
      );
    }
  }

  // Duplicate timestamps would make apply order depend on the sort's
  // stability. The timestamp prefix makes this a naming mistake, not a
  // concurrency problem — reject it at discovery time.
  const timestamps = new Map<string, number>();
  for (const file of files) {
    const ts = file.name.slice(0, 14);
    timestamps.set(ts, (timestamps.get(ts) ?? 0) + 1);
  }
  const duplicates = [...timestamps.entries()].filter(([, n]) => n > 1);
  if (duplicates.length > 0) {
    throw new HistoryError(
      `Duplicate migration timestamp(s): ${duplicates.map(([t]) => t).join(", ")}`,
    );
  }

  if (files.length === 0) {
    throw new Error(
      `No .sql migrations found in ${dir}. ` +
        `Create one with \`pnpm db:migrate:new <slug>\`.`,
    );
  }

  for (const file of files) {
    if (statSync(file.path).size === 0) {
      throw new HistoryError(`Migration ${file.name} is empty.`);
    }
  }

  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ledger
// ─────────────────────────────────────────────────────────────────────────────

const LEDGER_TABLE_SQL = `
  create schema if not exists ${LEDGER_SCHEMA};

  create table if not exists ${LEDGER_SCHEMA}.migrations (
    name         text primary key,
    checksum     text not null,
    applied_at   timestamptz not null default now(),
    applied_by   text not null,
    duration_ms  integer
  );

  -- The ledger is infrastructure, not data: no application role may write it.
  -- The owner connection is the only writer. Read access goes to
  -- "authenticated" only — the readiness probe (which connects with the
  -- weaker runtime role, a NOINHERIT member of "authenticated") reads the
  -- ledger under SET LOCAL ROLE authenticated to compare what this build
  -- expects against what the database has actually applied.
  revoke all on schema ${LEDGER_SCHEMA} from public;
  revoke all on ${LEDGER_SCHEMA}.migrations from public;
  grant usage on schema ${LEDGER_SCHEMA} to authenticated;
  grant select on ${LEDGER_SCHEMA}.migrations to authenticated;
`;

/**
 * Read-only ledger inspection — the readiness probe's and `status`'s view of
 * the database.
 *
 * Deliberately does **not** create the ledger table (unlike `preflight`): the
 * probe connects with the runtime role, which must never run DDL, and "the
 * ledger table does not exist" *is* the "migrations have never run" condition
 * it needs to report as `down`. Returns the same shape as `preflight` so the
 * comparison logic (`assertCleanHistory`, count comparisons) is shared.
 */
export async function inspectState(
  sql: postgres.Sql,
  files: MigrationFile[],
): Promise<Preflight> {
  const tableExists = await sql<{ present: boolean }[]>`
    select exists (
      select 1 from information_schema.tables
      where table_schema = ${LEDGER_SCHEMA} and table_name = 'migrations'
    ) as present
  `;

  // A missing ledger with files on disk means migrations have not run — return
  // everything as pending rather than attempting DDL with a non-owner role.
  if (tableExists[0]?.present !== true) {
    return {
      pending: files,
      editedAfterApply: [],
      missingFromDisk: [],
      applied: [],
    };
  }

  const rows = await readLedger(sql);
  const byName = new Map(files.map((f) => [f.name, f]));

  const applied: LedgerRow[] = [];
  const editedAfterApply: Preflight["editedAfterApply"] = [];
  const missingFromDisk: LedgerRow[] = [];

  for (const row of rows) {
    const file = byName.get(row.name);
    if (!file) {
      missingFromDisk.push(row);
      continue;
    }
    if (file.checksum !== row.checksum) {
      editedAfterApply.push({ row, file });
      continue;
    }
    applied.push(row);
  }

  const appliedNames = new Set(applied.map((r) => r.name));
  const pending = files.filter((f) => !appliedNames.has(f.name));
  return { pending, editedAfterApply, missingFromDisk, applied };
}

function readLedger(sql: postgres.Sql): Promise<LedgerRow[]> {
  return sql<LedgerRow[]>`
    select name, checksum, applied_at as "appliedAt", applied_by as "appliedBy",
           duration_ms as "durationMs"
    from ${sql(LEDGER_SCHEMA)}.migrations
    order by name asc
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Preflight
// ─────────────────────────────────────────────────────────────────────────────

export async function preflight(
  sql: postgres.Sql,
  files: MigrationFile[],
): Promise<Preflight> {
  await sql.unsafe(LEDGER_TABLE_SQL);
  const rows = await readLedger(sql);
  const byName = new Map(files.map((f) => [f.name, f]));

  const applied: LedgerRow[] = [];
  const editedAfterApply: Preflight["editedAfterApply"] = [];
  const missingFromDisk: LedgerRow[] = [];

  for (const row of rows) {
    const file = byName.get(row.name);
    if (!file) {
      missingFromDisk.push(row);
      continue;
    }
    if (file.checksum !== row.checksum) {
      editedAfterApply.push({ row, file });
      continue;
    }
    applied.push(row);
  }

  // Prefix discipline: everything applied must be exactly the first N files.
  const appliedNames = new Set(applied.map((r) => r.name));
  const prefix = files.slice(0, applied.length);
  const gaps = prefix.filter((f) => !appliedNames.has(f.name));
  if (gaps.length > 0) {
    throw new HistoryError(
      "Migration history has gaps: the following files sort before applied " +
        `migrations but have no ledger row: ${gaps
          .map((f) => f.name)
          .join(
            ", ",
          )}. A migration was likely renamed or deleted — history is ` +
        "append-only (ADR-0008).",
    );
  }

  const pending = files.filter((f) => !appliedNames.has(f.name));
  return { pending, editedAfterApply, missingFromDisk, applied };
}

export function assertCleanHistory(preflightResult: Preflight): void {
  const problems: string[] = [];
  for (const { row, file } of preflightResult.editedAfterApply) {
    problems.push(
      `  ${file.name} was modified after it was applied ` +
        `(ledger ${row.checksum.slice(0, 12)}, file ${file.checksum.slice(0, 12)}). ` +
        "Applied migrations are immutable — add a new migration instead.",
    );
  }
  for (const row of preflightResult.missingFromDisk) {
    problems.push(
      `  ${row.name} is in the ledger but not on disk. History is append-only.`,
    );
  }
  if (problems.length > 0) {
    throw new HistoryError(
      `Migration history does not match the repository:\n${problems.join("\n")}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Operations
// ─────────────────────────────────────────────────────────────────────────────

/** Opens the owner connection, acquires the advisory lock, verifies the
 * preflight invariants, and runs `operation` with the lock held. The lock and
 * the connection are released even on failure. */
export async function withMigrations<T>(
  migrationUrl: string,
  operation: (sql: postgres.Sql, preflight: Preflight) => Promise<T>,
  /** `dir` overrides the migrations directory (from `MIGRATIONS_DIR`).
   * `undefined`-tolerant for `exactOptionalPropertyTypes`. */
  options: { dir?: string | undefined } = {},
): Promise<T> {
  const sql = postgres(migrationUrl, {
    max: 1, // the advisory lock is session-scoped: one connection, one writer
    connect_timeout: 10,
    prepare: false,
    connection: {
      application_name: "ses-migrations",
      // DDL duration is unbounded by design; the runtime's statement timeout
      // must not abort a long migration halfway.
      statement_timeout: 0,
    },
  });

  try {
    await sql`select pg_advisory_lock(${ADVISORY_LOCK_KEY})`;
    try {
      const files = listMigrationFiles(resolveMigrationsDir(options.dir));
      const state = await preflight(sql, files);
      assertCleanHistory(state);
      return await operation(sql, state);
    } finally {
      await sql`select pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export interface ApplyResult {
  readonly appliedNow: string[];
  readonly alreadyApplied: number;
}

/** Applies every pending migration, each in its own transaction. */
export async function applyMigrations(
  sql: postgres.Sql,
  state: Preflight,
): Promise<ApplyResult> {
  const appliedNow: string[] = [];

  for (const file of state.pending) {
    const content = readFileSync(file.path, "utf8");
    const startedAt = Date.now();
    try {
      await sql.begin(async (tx) => {
        // The migration body runs as a simple query so a single file may
        // contain many statements; the ledger row is written inside the same
        // transaction, so "applied" and "recorded" can never diverge.
        await tx.unsafe(content);
        // `current_user` is emitted as a column reference, not a bound
        // parameter — postgres.js treats uninterpolated template text as
        // literal SQL. It records the role the migration actually ran as,
        // which is how "someone applied this by hand as the wrong role"
        // becomes visible in `status` output.
        await tx`
          insert into ${tx(LEDGER_SCHEMA)}.migrations
            (name, checksum, applied_by, duration_ms)
          values (${file.name}, ${file.checksum}, current_user, ${Date.now() - startedAt})
        `;
      });
    } catch (error) {
      throw new MigrationFailedError(file, error);
    }
    appliedNow.push(file.name);
  }

  return { appliedNow, alreadyApplied: state.applied.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// `new` scaffold
// ─────────────────────────────────────────────────────────────────────────────

const TEMPLATE = (name: string) => `-- ${name}
--
-- What this migration does and why (one paragraph).
--
-- Down (for reference — the runner is forward-only; this documents the
-- reverse operation and is executed by hand when needed):
--   ...
`;

/** Creates the next migration file. Returns its path for CLI output. */
export function createMigration(dir: string, subject: string): string {
  const slug = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (slug === "") {
    throw new Error(
      `Subject "${subject}" produces an empty slug. Use [a-z0-9_] words.`,
    );
  }
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14); // UTC YYYYMMDDHHMMSS
  const name = `${timestamp}_${slug}.sql`;
  const path = join(dir, name);
  writeFileSync(path, TEMPLATE(name), { flag: "wx" });
  return path;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
