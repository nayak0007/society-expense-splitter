import { Injectable } from "@nestjs/common";
import {
  HealthIndicatorService,
  type HealthIndicatorResult,
} from "@nestjs/terminus";

import { RedisService } from "../../../infrastructure/cache/redis.service";

/**
 * Readiness check for Redis — SAD §17.5.
 *
 * Redis is *required* for readiness but not for correctness: SAD §18 is explicit
 * that balances are never cached, "they must be read transactionally". So a down
 * Redis means degraded — rate limits uncacheable, cache cold, queues paused — and
 * the probe reports it, while the process itself stays up.
 *
 * The retained connection error is rethrown rather than the `ping` symptom
 * ("Stream isn't writeable"), so the probe body says *why* Redis is down.
 */
@Injectable()
export class RedisIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly redis: RedisService,
  ) {}

  async check(): Promise<HealthIndicatorResult> {
    return this.healthIndicatorService
      .check("redis")
      .attempt(async () => {
        try {
          await this.redis.ping();
        } catch (error) {
          throw this.redis.connectionError ?? error;
        }
      })
      .withTimeout(5_000);
  }
}
