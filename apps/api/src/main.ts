import "reflect-metadata";

import helmet from "@fastify/helmet";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Logger } from "nestjs-pino";

import { AppModule } from "./app.module";
import { createAdapter, GLOBAL_PREFIX } from "./bootstrap";
import { AppConfig } from "./config/app-config";
import { setupSwagger } from "./swagger";

/**
 * HTTP bootstrap.
 *
 * Fastify rather than Express (SAD §2.2: "roughly 2× throughput and better JSON
 * serialisation"), which is why this file talks to `NestFastifyApplication` and
 * registers Fastify plugins rather than Express middleware. The adapter's own
 * settings live in `bootstrap.ts` so the integration tests exercise the same ones.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    createAdapter(),
    {
      // Defers the first log lines until pino is installed, so a boot is structured
      // JSON from its very first entry.
      bufferLogs: true,
    },
  );

  app.useLogger(app.get(Logger));

  // SAD §7.3: URL-based versioning. Applied once here so no controller writes the
  // prefix itself, and a future /v2 is a routing decision rather than a rename.
  app.setGlobalPrefix(GLOBAL_PREFIX);

  // T006: "Graceful shutdown drains in-flight requests within 30 s". Nest hooks
  // SIGTERM/SIGINT into the lifecycle, which closes the Fastify server (waiting
  // for in-flight responses) and then runs each provider's
  // `onApplicationShutdown` — where the Postgres pool and Redis connection close.
  app.enableShutdownHooks();

  // Security headers for the API surface. `contentSecurityPolicy` is off because
  // this process renders no HTML (the only HTML is Swagger UI in non-production),
  // and a CSP here would only ever be misconfigured.
  await app.register(helmet, { contentSecurityPolicy: false });

  const config = app.get(AppConfig);
  setupSwagger(app, config);

  await app.listen({ port: config.port, host: config.host });
}

bootstrap().catch((error: unknown) => {
  // The console is the correct transport here, not the logger: configuration
  // validation throws *before* pino exists, so this is the only channel that is
  // guaranteed to work. `console.error` is the one console method the API's lint
  // config permits, for exactly this case.
  console.error("\nAPI failed to start.\n");
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
