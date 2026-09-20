import { Module } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";

import { CacheModule } from "../../infrastructure/cache/cache.module";
import { DatabaseModule } from "../../infrastructure/database/database.module";
import { HealthController } from "./health.controller";
import { MigrationsIndicator } from "./indicators/migrations.indicator";
import { PostgresIndicator } from "./indicators/postgres.indicator";
import { RedisIndicator } from "./indicators/redis.indicator";

/**
 * `TerminusModule` supplies `HealthCheckService` and the `@HealthCheck()`
 * decorator that turns a failing indicator into a `503` — re-providing it here
 * would bypass the library's error handling and leave every probe answering
 * `200` with a body that says `down`.
 */
@Module({
  imports: [TerminusModule, DatabaseModule, CacheModule],
  controllers: [HealthController],
  providers: [PostgresIndicator, RedisIndicator, MigrationsIndicator],
})
export class HealthModule {}
