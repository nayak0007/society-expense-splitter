// @ts-check
import { builtinModules } from "node:module";

import nodeExternals from "webpack-node-externals";

/**
 * Rspack build for the API.
 *
 * WHY A CUSTOM CONFIG AT ALL — `@ses/contracts`, `@ses/domain` and
 * `@ses/db-schema` publish **TypeScript source** (`main: src/index.ts`), which is
 * what lets Metro and tsc consume them with no build step and keeps the mobile
 * app's zero-build dev loop intact. Node cannot execute that source, so the API
 * has to receive it compiled. Nest's stock rspack defaults cannot do it: they set
 * `externals: [nodeExternals()]` with no allowlist, so every bare specifier —
 * `@ses/contracts` included — is left as a runtime import pointing at a `.ts`
 * file. Adding the allowlist is the whole reason this file exists.
 *
 * WHY RSPACK AND NOT WEBPACK: NestJS 12's webpack compiler **throws** on an ESM
 * project ("The webpack compiler does not support ESM projects"), and NestJS 12
 * is ESM-only, so webpack cannot build this app at all. Webpack is also
 * deprecated in the CLI in favour of rspack. Rspack's defaults happen to be a
 * better fit regardless: `builtin:swc-loader` with `legacyDecorator` and
 * `decoratorMetadata` — the decorator support Nest's constructor injection needs,
 * and which esbuild does not implement — plus `TsconfigPathsPlugin` and the ESM
 * output settings this project requires.
 *
 * Exported as a **function of the defaults** so everything Nest configures
 * (ESM output, swc loader, tsconfig paths, the lazy-import IgnorePlugin, the
 * type-checker plugin) is inherited rather than reimplemented. Only `entry` and
 * `externals` are replaced. Replacing `externals` wholesale is deliberate: the
 * defaults build two entries there, and the ESM one must keep
 * `importType: 'module'` — a plain `require()` left inside an ES module output
 * would fail at runtime.
 *
 * @param {import('@rspack/core').Configuration} defaults
 * @returns {import('@rspack/core').Configuration}
 */
export default function configure(defaults) {
  /** Third-party packages stay external; workspace packages are bundled. */
  const WORKSPACE_PACKAGES = /^@ses\//;

  return {
    ...defaults,

    entry: {
      main: "./src/main.ts",
      worker: "./src/worker.ts",
      // The tools below boot the real app module, so they need the same transform
      // pipeline. Building them as entries keeps one toolchain instead of adding a
      // second TypeScript runner: tsx/esbuild cannot emit decorator metadata (Nest
      // DI needs it) and Node's native type stripping rejects decorators outright.
      openapi: "./src/tools/export-openapi.ts",
      migrate: "./src/tools/migrate.ts",
      reset: "./src/tools/reset.ts",
    },

    output: {
      ...defaults.output,
      // One file per entry, named after it (`dist/main.js`, `dist/worker.js`),
      // because `nest start` and the Dockerfile run them by name.
      filename: "[name].js",
      clean: false,
    },

    externals: [
      nodeExternals({ allowlist: [WORKSPACE_PACKAGES], importType: "module" }),
      /**
       * Node built-ins must stay imports, and must be imported as `module ...`
       * in an ESM bundle. Reimplemented because the defaults' version lives in
       * the array this config replaces.
       */
      ({ request }, callback) => {
        if (!request) {
          return callback();
        }
        const bare = request.startsWith("node:") ? request.slice(5) : request;
        if (builtinModules.includes(bare)) {
          return callback(null, `module ${request}`);
        }
        return callback();
      },
    ],
  };
}
