import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";

import { AppModule } from "./app.module";

/**
 * BullMQ worker bootstrap — SAD §2.2: "running in a separate worker process from
 * the same codebase (`apps/api` with a `--worker` entrypoint). Never run queue
 * processing in the API process — a long report job must not starve request
 * handling."
 *
 * So this is a *process*, not a module: it shares the composition root and the
 * infrastructure, but it is an application context with no HTTP server. Deploying
 * it as a second command against the same image keeps one build (see
 * `Dockerfile`) rather than the two the SAD's folder listing implies.
 *
 * **No queues are registered yet.** The first processor arrives with the job it
 * serves (maintenance cycle generation, reminders, report export). Three things
 * are deliberately established now because retrofitting them is where workers go
 * wrong:
 *
 * - Idempotent processors. SAD §19.3: "BullMQ redelivers anything interrupted —
 *   every processor must therefore be idempotent"; asserting that in tests only
 *   works if the process is a first-class entrypoint.
 * - Graceful drain. SAD §19.3: finish in-flight jobs, stop polling, exit within
 *   60s. That is what the signal handling below does.
 * - Worker connection settings. §14.4 gives worker connections a 120s
 *   `statement_timeout` instead of the API's 10s, because a cycle publish for
 *   2,000 flats is legitimately slow. **When the first processor lands it must
 *   raise `DB_STATEMENT_TIMEOUT_MS` for this process** — the value is
 *   configuration precisely so that is a one-line change rather than a code path.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  const logger = app.get(Logger);

  /**
   * Nothing holds the event loop open while there are no queues, so the process
   * would exit immediately — which a supervisor reads as a crash loop and
   * restarts forever. An interval is an honest placeholder: this process is
   * *supposed* to be long-lived, and it will be genuinely busy once a queue is
   * registered.
   */
  const keepAlive = setInterval(() => {
    logger.debug("worker heartbeat — no queues registered yet");
  }, 60_000);

  const shutdown = async (signal: string): Promise<void> => {
    logger.log(`Received ${signal}; draining and exiting`);
    clearInterval(keepAlive);
    await app.close();
  };

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  logger.log(
    "Worker started. No queues registered yet — see the Roadmap job tasks.",
  );
}

bootstrap().catch((error: unknown) => {
  console.error("\nWorker failed to start.\n");
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
