import { Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";

import { ApiExceptionFilter } from "./common/filters/api-exception.filter";
import { RequestContextInterceptor } from "./common/interceptors/request-context.interceptor";
import { AppConfigModule } from "./config/config.module";
import { AppConfig } from "./config/app-config";
import { CacheModule } from "./infrastructure/cache/cache.module";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { HealthModule } from "./modules/health/health.module";
import { buildLoggerParams } from "./observability/logger";

/**
 * The composition root.
 *
 * A modular monolith (SAD §1.2): one deployable process with hard module
 * boundaries, and no cross-module imports except through a module's public
 * surface. Business modules (`societies`, `expenses`, `payments`, …) are added
 * here as they land; this slice deliberately contains only the platform.
 *
 * `APP_INTERCEPTOR`/`APP_FILTER` rather than `app.useGlobal*()` in `main.ts`, so
 * the pipeline is constructed by Nest and can inject dependencies (the filter
 * needs `HttpAdapterHost`). Registering them imperatively in `main.ts` would also
 * mean a test that builds the module gets a different pipeline than production —
 * the classic way an error shape is verified in tests and wrong in production.
 */
@Module({
  imports: [
    AppConfigModule,

    // `bufferLogs` in the bootstrap defers the first lines until pino is ready,
    // so the very first log of a boot is already structured JSON.
    LoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfig],
      useFactory: buildLoggerParams,
    }),

    DatabaseModule,
    CacheModule,

    HealthModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
