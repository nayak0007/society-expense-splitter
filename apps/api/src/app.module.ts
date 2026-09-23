import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";

import { AuthModule } from "./common/auth/auth.module";
import { ApiExceptionFilter } from "./common/filters/api-exception.filter";
import { SupabaseAuthGuard } from "./common/guards/supabase-auth.guard";
import { ResponseEnvelopeInterceptor } from "./common/interceptors/envelope.interceptor";
import { RequestContextInterceptor } from "./common/interceptors/request-context.interceptor";
import { AppConfigModule } from "./config/config.module";
import { AppConfig } from "./config/app-config";
import { CacheModule } from "./infrastructure/cache/cache.module";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { HealthModule } from "./modules/health/health.module";
import { SocietiesModule } from "./modules/societies/societies.module";
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

    AuthModule,

    HealthModule,
    SocietiesModule,
  ],
  providers: [
    // The guard is global and fail-closed: a route is protected unless it is
    // marked `@Public()`. Registering it here rather than per controller means a
    // module nobody thought about is still authenticated, which is the same
    // argument `APP_INTERCEPTOR`/`APP_FILTER` make below — a default that is
    // correct everywhere beats a decorator repeated per file.
    { provide: APP_GUARD, useClass: SupabaseAuthGuard },
    // Order matters for interceptors: Nest runs them outermost-first, so the
    // request context is established before the envelope interceptor reads the
    // request id out of it.
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
