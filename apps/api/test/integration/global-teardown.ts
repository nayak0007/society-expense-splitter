import { readFileSync } from "node:fs";

import { getContainerRuntimeClient } from "testcontainers";

import { STATE_FILE, type IntegrationState } from "./state";

/**
 * Jest `globalTeardown` for the integration suite — Roadmap T034.
 *
 * Separate from `global-setup.ts` because Jest does not call a teardown function
 * *returned* by `globalSetup`: `@jest/core`'s `runGlobalHook` awaits the exported
 * function and discards its return value. That was verified against the installed
 * Jest 30 source after the first execution showed the returned closure never
 * running and the "containers removed" line never printing — cleanup had been
 * silently left to Ryuk. The setup therefore records the container ids in the
 * state file, and this module stops exactly those, by id.
 *
 * Ryuk remains enabled as the crash safety net: it reaps the session's containers
 * if this process dies mid-run. On a normal run, removing the containers is this
 * module's explicit work rather than an inference from a disconnect.
 *
 * A missing state file means the run failed before the containers were recorded —
 * a migration failure stops them in `global-setup.ts`, and a start failure has
 * nothing to stop — so there is nothing to do here.
 */
export default async function globalTeardown(): Promise<void> {
  let state: IntegrationState;
  try {
    state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as IntegrationState;
  } catch {
    return;
  }

  const startedAt = Date.now();
  const client = await getContainerRuntimeClient();

  for (const id of [state.postgresId, state.redisId]) {
    const container = client.container.getById(id);
    try {
      // `t: 0` — both images tolerate an immediate stop, and a test container
      // must never slow a run down by negotiating a graceful shutdown.
      await client.container.stop(container, { timeout: 0 });
    } catch (error) {
      process.stdout.write(
        `[integration] container ${id.slice(0, 12)} stop: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    try {
      await client.container.remove(container, { removeVolumes: true });
    } catch (error) {
      // Best effort: a container Ryuk (or the migration-failure path) already
      // removed must not redden an otherwise passing run.
      process.stdout.write(
        `[integration] container ${id.slice(0, 12)} remove: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  process.stdout.write(
    `[integration] containers removed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`,
  );
}
