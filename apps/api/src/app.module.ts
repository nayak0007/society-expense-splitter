import { Module } from "@nestjs/common";

import { INVITATION_REPOSITORY } from "./modules/invitations/application/invitation.tokens";
import { IMPORT_INVITATION_LIST } from "./modules/members/application/csv-import.tokens";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { LoggerModule } from "nestjs-pino";

import { AuthModule } from "./common/auth/auth.module";
import { ApiExceptionFilter } from "./common/filters/api-exception.filter";
import { PermissionGuard } from "./common/guards/permission.guard";
import { SocietyGuard } from "./common/guards/society.guard";
import { SupabaseAuthGuard } from "./common/guards/supabase-auth.guard";
import { ResponseEnvelopeInterceptor } from "./common/interceptors/envelope.interceptor";
import { RequestContextInterceptor } from "./common/interceptors/request-context.interceptor";
import { AppConfigModule } from "./config/config.module";
import { AppConfig } from "./config/app-config";
import { CacheModule } from "./infrastructure/cache/cache.module";
import { DatabaseModule } from "./infrastructure/database/database.module";
import { ExpensesModule } from "./modules/expenses/expenses.module";
import { HealthModule } from "./modules/health/health.module";
import { InvitationsModule } from "./modules/invitations/invitations.module";
import { MembersModule } from "./modules/members/members.module";
import { SocietiesModule } from "./modules/societies/societies.module";
import { StructureModule } from "./modules/structure/structure.module";
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
    StructureModule,
    MembersModule,
    // T047's invitations: its own module, importing MembersModule for the one membership read it
    // needs. The route shapes (society-scoped management, a public preview, an authenticated
    // acceptance) are documented in its controller.
    InvitationsModule,
    // T062's expense categories: the first slice of the expenses module. It imports
    // SocietiesModule for the same narrow membership read the structure module uses, and
    // declares no provider of its own for it — see the module for why that is the whole point.
    ExpensesModule,
  ],
  providers: [
    // T048 — the member module's bulk import reads the invitations module's repository
    // through a narrow shape (ImportInvitationList) for its collision check. Bound here
    // rather than in MembersModule because InvitationsModule already imports
    // MembersModule; a second edge would be a module cycle. Nest resolves `useExisting`
    // across the whole graph, so this is the same adapter instance the invitation
    // routes use — one reader of one table, as the invitations module's own comment asks.
    {
      provide: IMPORT_INVITATION_LIST,
      useExisting: INVITATION_REPOSITORY,
    },

    // The guard is global and fail-closed: a route is protected unless it is
    // marked `@Public()`. Registering it here rather than per controller means a
    // module nobody thought about is still authenticated, which is the same
    // argument `APP_INTERCEPTOR`/`APP_FILTER` make below — a default that is
    // correct everywhere beats a decorator repeated per file.
    { provide: APP_GUARD, useClass: SupabaseAuthGuard },
    // The rest of the chain, in SAD §9.4's order — and the order is load-bearing.
    // `APP_GUARD` providers run in registration order, so each stage can rely on
    // the one before it having run: the permission guard evaluates a membership
    // that the society guard resolved, and both sit behind an authenticated
    // actor. Registering them the other way round would make every permission
    // check fail with "no society context" on a request that had one.
    //
    // Both are inert unless a route declares `@RequirePermission(…)
    // (see `society.guard.ts` for why an unconditional society guard would be
    // wrong), so adding them does not change any existing route.
    { provide: APP_GUARD, useClass: SocietyGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    // Order matters for interceptors: Nest runs them outermost-first, so the
    // request context is established before the envelope interceptor reads the
    // request id out of it.
    { provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
