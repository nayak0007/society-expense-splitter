import { existsSync } from "node:fs";
import { dirname, join, parse } from "node:path";

/**
 * Locates the workspace root by walking up from the current working directory.
 *
 * WHY THIS EXISTS AT ALL: the OpenAPI export has to write to
 * `<repo>/docs/api/OPENAPI.yaml`, and there is no portable way to compute that
 * from inside the bundle.
 *
 * - `__dirname` does not exist — the API build is ESM (NestJS 12 is ESM-only).
 * - `import.meta.url` is **statically replaced at build time** by rspack with the
 *   absolute URL of the *source* file it came from. This is not a subtlety worth
 *   guessing at; the shipped bundle literally contains
 *   `fileURLToPath('file:///D:/Projects/.../apps/api/src/tools/export-openapi.ts')`,
 *   which meant the first version of the export wrote to `apps/docs/api/` and
 *   would have written to a path that does not exist at all inside the container
 *   image. Anything derived from a baked path is wrong on every machine but the
 *   one that built it.
 *
 * So the root is discovered at runtime instead, from the directory the command
 * was invoked in — the same convention `tools/migrate.ts` already uses for its
 * `migrations/` folder. `pnpm-workspace.yaml` is the marker because it is the file
 * that defines the workspace, and every package lives beneath it.
 *
 * Walking up rather than assuming a fixed number of `..` levels means the helper
 * survives the package being moved, and running a tool from the repository root
 * instead of `apps/api` still resolves correctly.
 */
export function findRepoRoot(startDirectory: string = process.cwd()): string {
  let current = startDirectory;
  const { root } = parse(current);

  // Terminates at the filesystem root, so a misconfigured invocation throws a
  // readable error instead of looping forever.
  while (current !== root) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    current = dirname(current);
  }

  throw new Error(
    `Could not find the repository root: no pnpm-workspace.yaml in ${startDirectory} or any parent directory. ` +
      "Run this command from inside the repository (e.g. `pnpm --filter @ses/api openapi`).",
  );
}
