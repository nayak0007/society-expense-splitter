import { Controller, Get } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  HealthCheck,
  HealthCheckService,
  type HealthCheckResult,
} from "@nestjs/terminus";

import { MigrationsIndicator } from "./indicators/migrations.indicator";
import { PostgresIndicator } from "./indicators/postgres.indicator";
import { RedisIndicator } from "./indicators/redis.indicator";

/**
 * Health probes — SAD §17.5.
 *
 * Mounted under the versioned prefix (`/v1/health/...`) per Roadmap T006, which
 * specifies both the `/v1` global prefix and these paths. The SAD's §17.5 table
 * writes them unversioned; T006 is the executable document, so it wins, and the
 * `Dockerfile` `HEALTHCHECK` and the compose health checks target `/v1`. Note
 * that a probe path baked into orchestrator config is one more thing to change if
 * the prefix ever moves — which §7.3 argues against doing anyway.
 *
 * **Responses are terminus-native (`{ status, info, error, details }`), not the
 * API's `{ data, meta }` envelope.** Orchestrators read the status code, and
 * wrapping a library's diagnostic body would discard the detail an operator
 * needs at 3am. The exception filter makes the same exception for these paths.
 */
@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly postgres: PostgresIndicator,
    private readonly redis: RedisIndicator,
    private readonly migrations: MigrationsIndicator,
  ) {}

  /**
   * Liveness. **Checks no dependencies, by design** — SAD §17.5: "a database
   * blip must not restart the pod". If this endpoint verified Postgres, a
   * transient network partition would cause every instance to be killed and
   * replaced at once, turning a blip into an outage.
   */
  @Get("live")
  @HealthCheck()
  @ApiOperation({
    summary: "Liveness — process responsive, dependencies not checked",
  })
  live(): Promise<HealthCheckResult> {
    return this.health.check([]);
  }

  /**
   * Readiness. A `503` means "do not send me traffic yet", not "restart me".
   *
   * Postgres and Redis are checked separately rather than as one "dependencies"
   * result so the failing component is visible in the body without reading logs.
   */
  @Get("ready")
  @HealthCheck()
  @ApiOperation({ summary: "Readiness — Postgres, Redis and migration state" })
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      () => this.postgres.check(),
      () => this.redis.check(),
      () => this.migrations.check(),
    ]);
  }
}
