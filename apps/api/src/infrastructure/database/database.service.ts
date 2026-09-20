import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { AppConfig } from "../../config/app-config";

export type Database = PostgresJsDatabase<Record<string, never>>;

/**
 * The API's Postgres connection.
 *
 * Two connection details are not stylistic choices:
 *
 * 1. **`prepare: false`.** Supabase's pooler runs in transaction mode, where a
 *    prepared statement cannot be reused because the next statement may run on a
 *    different backend. Leaving prepared statements on produces intermittent
 *    "prepared statement does not exist" failures under load, which look like
 *    race conditions in application code.
 * 2. **`DATABASE_URL`, never `SUPABASE_SERVICE_ROLE_KEY`.** The runtime role is
 *    scoped so RLS applies; the service-role key bypasses RLS entirely and would
 *    turn every policy into decoration. Migrations use the separate owner URL
 *    through `MIGRATION_DATABASE_URL` (see `scripts`/`tools`).
 *
 * The client connects **lazily**, on first query. Nothing here opens a socket at
 * boot: a database outage must not stop the process starting, because SAD §17.5
 * makes `/health/live` explicitly independent of dependencies — "a database blip
 * must not restart the pod".
 */
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseService.name);
  readonly client: ReturnType<typeof postgres>;
  readonly db: Database;

  constructor(config: AppConfig) {
    this.client = postgres(config.databaseUrl, {
      max: config.databasePoolMax,
      // Fail fast rather than queue forever behind an unreachable database:
      // a queued request that eventually times out is worse than a fast 503.
      connect_timeout: 10,
      idle_timeout: 30,
      prepare: false,
      connection: {
        application_name: "ses-api",
        // SAD §14.4: a runaway query must not take the service down.
        statement_timeout: config.databaseStatementTimeoutMs,
      },
    });

    this.db = drizzle(this.client);
  }

  /** `SELECT 1` — the readiness probe's Postgres check. */
  async ping(): Promise<void> {
    await this.client`select 1`;
  }

  /**
   * Drains the pool on shutdown. `timeout` bounds the wait so a stalled
   * connection cannot hold the 30-second graceful-shutdown budget (T006).
   */
  async onApplicationShutdown(): Promise<void> {
    try {
      await this.client.end({ timeout: 5 });
    } catch (error) {
      this.logger.warn(
        `Postgres pool did not close cleanly: ${describe(error)}`,
      );
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
