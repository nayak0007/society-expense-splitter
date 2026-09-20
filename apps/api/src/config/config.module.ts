import { Global, Module } from "@nestjs/common";
import { ConfigModule as NestConfigModule } from "@nestjs/config";

import { AppConfig } from "./app-config";
import { validateEnv } from "./validation.schema";

/**
 * Loads `.env`, validates it, and exposes the typed `AppConfig`.
 *
 * `@Global` because configuration is genuinely cross-cutting (SAD §1.7) — every
 * module needs it, and re-importing it in twenty modules adds noise without
 * adding isolation.
 *
 * `validate` is what makes the boot fail loudly: it runs before any provider is
 * constructed, so a missing `DATABASE_URL` stops the process at startup rather
 * than at the first query. `expandVariables: false` keeps `$` in a secret from
 * being interpreted as a dotenv reference.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      expandVariables: false,
      validate: validateEnv,
    }),
  ],
  providers: [AppConfig],
  exports: [AppConfig],
})
export class AppConfigModule {}
