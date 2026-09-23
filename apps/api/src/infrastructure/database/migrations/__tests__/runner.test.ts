import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMigration,
  HistoryError,
  listMigrationFiles,
  resolveMigrationsDir,
} from "../runner";

/**
 * Unit tests for the runner's filesystem-pure logic (ADR-0008).
 *
 * Discovery and naming discipline are where history goes wrong *before* any
 * database is involved — a bad filename, a duplicate timestamp, an empty file —
 * and every one of those must fail here rather than at apply time. The
 * database-side behaviour (preflight, apply, lock) is exercised by the live
 * verification recorded in the ADR and by CI's `test-db` job, which is where
 * its premises are real.
 */
describe("migration runner — discovery and naming (ADR-0008)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ses-migrations-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body = "-- body\n") => {
    writeFileSync(join(dir, name), body);
  };

  describe("listMigrationFiles", () => {
    it("lists .sql files sorted by name with a sha256 checksum", () => {
      write("20260920120000_b.sql");
      write("20260919120000_a.sql");
      write("README.md"); // non-SQL files are ignored, not errors

      const files = listMigrationFiles(dir);

      expect(files.map((f) => f.name)).toEqual([
        "20260919120000_a.sql",
        "20260920120000_b.sql",
      ]);
      // A checksum is a 64-char hex digest; different bodies differ.
      expect(files[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(files[0]?.path).toContain("20260919120000_a.sql");
    });

    it("rejects a filename that does not match the timestamp pattern", () => {
      write("migration_a.sql");

      expect(() => listMigrationFiles(dir)).toThrow(HistoryError);
      expect(() => listMigrationFiles(dir)).toThrow(/YYYYMMDDHHMMSS/);
    });

    it("rejects uppercase subjects (apply order must not depend on locale)", () => {
      write("20260920120000_ApperCase.sql");

      expect(() => listMigrationFiles(dir)).toThrow(HistoryError);
    });

    it("rejects duplicate timestamps — apply order must never depend on sort stability", () => {
      write("20260920120000_alpha.sql");
      write("20260920120000_beta.sql");

      expect(() => listMigrationFiles(dir)).toThrow(
        /Duplicate migration timestamp/,
      );
    });

    it("rejects an empty migration file", () => {
      write("20260920120000_empty.sql", "");

      expect(() => listMigrationFiles(dir)).toThrow(/is empty/);
    });

    it("reports an unreadable directory with its path", () => {
      expect(() => listMigrationFiles(join(dir, "does-not-exist"))).toThrow(
        /Cannot read the migrations directory/,
      );
    });

    it("rejects a directory with no migrations", () => {
      expect(() => listMigrationFiles(dir)).toThrow(/No \.sql migrations/);
    });
  });

  describe("resolveMigrationsDir", () => {
    it("honours an explicit override", () => {
      expect(resolveMigrationsDir("/opt/ses/migrations", dir)).toBe(
        "/opt/ses/migrations",
      );
    });

    it("finds supabase/migrations walking up from a nested working directory", () => {
      // This spec sits at apps/api/src/infrastructure/database/migrations/__tests__.
      // Walking up from this very directory must skip every intermediate level
      // (none of which has a supabase/ directory) and land on the repo root's
      // real history — what makes `pnpm --filter @ses/api db:migrate` and
      // root-level invocations agree regardless of cwd.
      const resolved = resolveMigrationsDir(undefined, __dirname);
      expect(resolved).toBe(
        join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "..",
          "..",
          "..",
          "supabase",
          "migrations",
        ),
      );
      expect(existsSync(resolved)).toBe(true);
    });

    it("falls back to startDir/supabase/migrations when nothing exists above", () => {
      const resolved = resolveMigrationsDir(undefined, dir);
      expect(resolved).toBe(join(dir, "supabase", "migrations"));
    });
  });

  describe("createMigration", () => {
    it("creates the next file with a UTC-timestamp name and header template", () => {
      const path = createMigration(dir, "Expense Core");
      const name =
        path
          .slice(path.lastIndexOf("/") + 1, path.length)
          .split("\\")
          .pop() ?? path;

      expect(name).toMatch(/^\d{14}_expense_core\.sql$/);
      const body = require("node:fs").readFileSync(path, "utf8") as string;
      expect(body).toContain("-- 2026"); // timestamped header
      expect(body).toContain("Down"); // the down-block contract
    });

    it("refuses an empty slug", () => {
      expect(() => createMigration(dir, "!!!")).toThrow(/empty slug/);
    });

    it("never overwrites an existing file", () => {
      const first = createMigration(dir, "same_subject");
      // Two creations within the same second collide on the timestamp; the
      // `wx` flag must turn that into a failure rather than a clobber.
      expect(() => createMigration(dir, "same_subject")).toThrow();
      expect(existsSync(first)).toBe(true);
    });
  });
});
