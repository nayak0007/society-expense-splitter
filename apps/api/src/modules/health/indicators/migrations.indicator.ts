import { Injectable } from "@nestjs/common";
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from "@nestjs/terminus";

import { AppConfig } from "../../../config/app-config";
import {
  listMigrationFiles,
  resolveMigrationsDir,
} from "../../../infrastructure/database/migrations/runner";
import { DatabaseService } from "../../../infrastructure/database/database.service";

/**
 * Readiness check that the schema is current — SAD §17.5 lists "migrations
 * current" as one of the three things `/health/ready` verifies.
 *
 * This is the check that catches the failure mode SAD §16.4's deploy sequence
 * exists to prevent: a new API version running against a database that has not
 * had its expand-phase migration applied. Without it the mismatch surfaces as
 * random `column does not exist` errors under production traffic, long after
 * the deploy reported success.
 *
 * ## What it compares, precisely
 *
 * The **ledger** the migration runner maintains (ADR-0008): the rows in
 * `ses_meta.migrations` against the files this build ships. The runner's
 * preflight asserts the applied set is a prefix of the sorted file list, so
 * "the counts match" and "the names match" are the same fact — the count is
 * what distinguishes "pending" from "current" without shipping file contents
 * to the probe.
 *
 * The previous implementation counted Drizzle's journal against a migrations
 * table that never existed — in every environment it reported `up` with
 * "no migrations defined", which is exactly the laundering of a silent no-op
 * this rewrite removes.
 *
 * ## Why `SET LOCAL ROLE authenticated`
 *
 * The ledger is intentionally invisible to the runtime role (the runner revokes
 * it from `public`). The probe connects with `DATABASE_URL` — the
 * `authenticator` login — and borrows the `authenticated` role for this one
 * statement, inside a transaction. This is the same identity mechanism every
 * request uses (ADR-0007), pointed at infrastructure metadata instead of
 * tenant rows; the read-only grant in the runner's ledger DDL is what makes
 * the read legal.
 *
 * ## The containers/{jobs} rule
 *
 * `common` may not import `infrastructure` (`.dependency-cruiser.js`), and the
 * health module is under `modules/`, which is allowed to. The pure functions
 * (`listMigrationFiles`, `resolveMigrationsDir`) are deterministic filesystem
 * reads, not a database dependency — the indicator still owns its SQL.
 */
@Injectable()
export class MigrationsIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly database: DatabaseService,
    private readonly config: AppConfig,
  ) {}

  async check(): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check("migrations");

    // What this build expects. Unreadable directory counts as zero — reported
    // as a mismatch below rather than thrown, because a probe that crashes on
    // a misconfigured container tells the orchestrator nothing about WHY.
    let expected = 0;
    try {
      expected = listMigrationFiles(
        resolveMigrationsDir(this.config.migrationsDir),
      ).length;
    } catch (error) {
      return indicator.down({
        expected: 0,
        applied: 0,
        message: `migration history unreadable: ${describe(error)}`,
      });
    }

    let applied: number;
    try {
      // The one statement that borrows `authenticated` for ledger read access
      // (see the class docstring). `begin` wraps the callback in a transaction;
      // `set local role` inside it expires with the transaction, matching
      // ADR-0007's pooling rule — nothing leaks to the next borrower.
      const rows = await this.database.client.begin(async (tx) => {
        await tx.unsafe("set local role authenticated");
        return tx<{ count: number }[]>`
          select count(*)::int as count from ses_meta.migrations
        `;
      });
      applied = rows[0]?.count ?? 0;
    } catch (error) {
      // A missing ledger table with a non-empty history IS the "migrations
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
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
