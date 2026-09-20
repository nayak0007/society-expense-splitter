import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Injectable, Logger } from "@nestjs/common";
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from "@nestjs/terminus";

import { DatabaseService } from "../../../infrastructure/database/database.service";

/**
 * Readiness check that the schema is current — SAD §17.5 lists "migrations
 * current" as one of the three things `/health/ready` verifies.
 *
 * This is the check that catches the failure mode SAD §16.4's deploy sequence
 * exists to prevent: a new API version running against a database that has not
 * had its expand-phase migration applied. Without it the mismatch surfaces as
 * random `column does not exist` errors under production traffic, long after the
 * deploy reported success.
 *
 * Compares the number of entries in Drizzle's journal (what this build of the code
 * expects) against the rows in Drizzle's migrations table (what the database has).
 * Counts rather than hash comparison, because the count is what distinguishes
 * "pending" from "current"; equal counts with different hashes means a migration
 * file was edited after being applied — a different failure, caught by review.
 */
@Injectable()
export class MigrationsIndicator {
  private readonly logger = new Logger(MigrationsIndicator.name);

  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly database: DatabaseService,
  ) {}

  async check(): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check("migrations");
    const expected = this.countExpected();

    // No migrations defined yet (T017 adds the first). Reporting `down` for an
    // empty journal would make the probe unusable in exactly the situation it is
    // most needed — before any schema exists.
    if (expected === 0) {
      return indicator.up({ detail: "no migrations defined" });
    }

    let applied: number;
    try {
      const rows = await this.database.client<{ count: number }[]>`
        select count(*)::int as count from drizzle.__drizzle_migrations
      `;
      applied = rows[0]?.count ?? 0;
    } catch (error) {
      // A missing migrations table with a non-empty journal *is* the "migrations
      // have not run" condition, not a database failure.
      return indicator.down({
        message: `migration state could not be read: ${describe(error)}`,
        applied: 0,
        expected,
      });
    }

    if (applied < expected) {
      return indicator.down({
        applied,
        expected,
        message: `${String(expected - applied)} pending`,
      });
    }

    return indicator.up({ applied, expected });
  }

  /** Reads Drizzle's journal. Absent or unreadable counts as "none defined". */
  private countExpected(): number {
    const journalPath = join(
      process.cwd(),
      "migrations",
      "meta",
      "_journal.json",
    );
    try {
      const raw = readFileSync(journalPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const entries: unknown = (parsed as { entries?: unknown }).entries;
      return Array.isArray(entries) ? entries.length : 0;
    } catch {
      this.logger.debug(
        `No Drizzle journal at ${journalPath}; treating migrations as current`,
      );
      return 0;
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
