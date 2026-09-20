import "reflect-metadata";

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { NestFactory } from "@nestjs/core";
import { stringify } from "yaml";

import { createAdapter, GLOBAL_PREFIX } from "../bootstrap";
import { findRepoRoot } from "../common/paths";
import { seedToolEnvironment } from "../config/tool-env";
import { buildOpenApiDocument } from "../swagger";

/**
 * Writes the committed OpenAPI document — SAD §7.3 and §4.5
 * (`docs/api/OPENAPI.yaml`).
 *
 * CI diffs this file on every pull request and fails on a breaking change unless
 * the PR carries `breaking-change-approved`, so it has to be regenerated here and
 * committed rather than fetched from a running server: the diff is only
 * meaningful if the artefact is in the repository.
 *
 * Run via `pnpm openapi`. It boots the real `AppModule`, which means the document
 * is derived from the same decorators the server serves from.
 *
 * **This is why nothing connects eagerly at boot.** Booting the whole module graph
 * to introspect its routes would otherwise open a Postgres pool and a Redis
 * socket to produce a text file; both services connect lazily instead (see
 * `DatabaseService` and `RedisService`), so this tool needs no infrastructure.
 */
async function main(): Promise<void> {
  const seeded = seedToolEnvironment();
  if (seeded.length > 0) {
    console.log(
      `Environment: supplied placeholder values for unset variables — ${seeded.join(", ")}. ` +
        "Nothing is contacted while building the document.",
    );
  }

  // IMPORTED HERE, NOT AT THE TOP OF THE FILE, and that placement is load-bearing.
  // `ConfigModule.forRoot({ validate })` runs while the module graph is built, so a
  // static import would evaluate it before `main()` existed — and a configuration
  // failure then killed the process with exit code 1 and no output whatsoever,
  // because the throw happened during module evaluation, outside every handler in
  // this file. Deferring it puts the failure inside the `catch` below, so a missing
  // or malformed variable is reported instead of silently failing a CI gate.
  const { AppModule } = await import("../app.module");

  // The Fastify adapter explicitly, from the same factory `main.ts` uses. Omitting
  // it would make Nest fall back to Express, which is not a dependency of this
  // package at all — and would silently build the document from a different
  // adapter than the one that serves it.
  // `logger: ["error"]`, not `logger: false`. That distinction cost real debugging
  // time: Nest's `ExceptionsZone` catches a bootstrap failure and calls
  // `process.exit(1)` ITSELF, from inside the framework, so an error thrown while
  // the graph is constructed never reaches the `catch` at the bottom of this file.
  // With logging disabled the process simply died with status 1 and printed
  // nothing — `pnpm openapi` failing silently. Errors are the one level that must
  // stay on, and they are only produced when the tool is already failing.
  const app = await NestFactory.create(AppModule, createAdapter(), {
    logger: ["error"],
  });

  // The global prefix is applied in `main.ts`, which this bootstrap does not run,
  // so it is repeated here — from the same constant, so the document cannot drift
  // from the served routes. Without it every path would be missing `/v1` and the
  // spec would be wrong in a way CI cannot detect.
  app.setGlobalPrefix(GLOBAL_PREFIX);

  const document = buildOpenApiDocument(app);

  // Discovered at runtime, never derived from the module's own URL — rspack
  // replaces `import.meta.url` at build time with the absolute path of the source
  // file, which produced `apps/docs/api/` locally and would point outside the
  // image in Docker. See `common/paths.ts` for the full reasoning.
  const outputPath = join(findRepoRoot(), "docs", "api", "OPENAPI.yaml");
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, stringify(document), "utf8");

  console.log(`OpenAPI document written to ${outputPath}`);

  await app.close();
}

main().catch((error: unknown) => {
  console.error("\nOpenAPI export failed.\n");
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exitCode = 1;
});
