import { Injectable } from "@nestjs/common";
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from "@nestjs/terminus";

import { DatabaseService } from "../../../infrastructure/database/database.service";

/**
 * Readiness check for Postgres — SAD §17.5 (`GET /health/ready`).
 *
 * `SELECT 1` rather than a table read on purpose: readiness asks "can this
 * process reach the database", not "is the schema what I expect". Migration state
 * is a separate indicator, so a pending migration is reported as a pending
 * migration rather than as a database that is down.
 *
 * `.withTimeout()` is not decoration. A probe that hangs is worse than one that
 * reports `down`: the orchestrator eventually gives up on its own schedule, and
 * in the meantime nothing is serving traffic and nothing has been restarted. The
 * driver's `connect_timeout` covers only the TCP handshake, not a database that
 * accepts connections and then stops answering.
 */
@Injectable()
export class PostgresIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly database: DatabaseService,
  ) {}

  async check(): Promise<HealthIndicatorResult> {
    return this.healthIndicatorService
      .check("postgres")
      .attempt(async () => {
        await this.database.ping();
      })
      .withTimeout(5_000);
  }
}
