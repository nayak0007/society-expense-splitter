/**
 * Architecture boundary rules — SAD §3.1 (layer model) and §1.2 (Supabase behind
 * an adapter).
 *
 * WHY A SECOND TOOL WHEN ESLINT ALREADY HAS AN IMPORT BOUNDARY RULE: ESLint's
 * `no-restricted-imports` rule sees the specifier a file writes, so it catches
 * `import { x } from '@supabase/supabase-js'` and nothing else. It cannot see that
 * `A → B → C` means A transitively reaches the Supabase SDK, and it cannot see a
 * cycle at all. dependency-cruiser works on the resolved graph, so it answers the
 * questions the architecture actually asserts:
 *
 *   * can anything in the UI layer reach a database driver, however indirectly?
 *   * does any package point back at an app?
 *
 * Run with `pnpm lint:arch`. CI fails on error-severity violations.
 *
 * A NOTE ON PATH ALIASES: the mobile app resolves `@/*` through `tsconfig` paths,
 * and dependency-cruiser is not told about that here. A rule matching an aliased
 * import would therefore silently skip. Every rule below matches either a real npm
 * specifier or a workspace-relative path, both of which are visible without alias
 * resolution. That is a deliberate constraint on which rules can be written, not an
 * oversight — the alternative is a config that appears to cover `@/*` and does not.
 *
 * A NOTE ON HOW `to.path` MATCHES AN NPM DEPENDENCY: not against the specifier the
 * file wrote, but against the RESOLVED path. Under pnpm that is
 * `node_modules/.pnpm/<name>@<version>/node_modules/<name>/...`, which still ends in
 * `node_modules/<name>/` — so patterns below are anchored on that trailing segment
 * rather than on the start of the string, and work whether the package is hoisted or
 * not. (A pattern like `(\.pnpm/[^/]+/node_modules/)?@supabase` is rejected outright
 * by dependency-cruiser's ReDoS check, so the simple form is also the only one.)
 *
 * A NOTE ON `dependencyTypes: ['npm']` — DO NOT USE IT ALONE. Under pnpm's
 * non-hoisted layout, a dependency that is NOT declared in the nearest
 * package.json is reported as `npm-no-pkg`, not `npm`. That is measured, not
 * inferred: a planted `import { Injectable } from '@nestjs/common'` inside
 * packages/domain (which does not declare @nestjs/common) reported
 * `dependencyTypes: ["npm-no-pkg","import"]`, while the same import inside
 * apps/mobile for its DECLARED `@supabase/supabase-js` reported
 * `["npm","import"]`. Since the whole point of the framework-free rules is to
 * catch a package reaching for a framework it has no business declaring, a
 * filter of `['npm']` alone would match only the case that barely needs
 * forbidding — a dep the manifest already admits to — and stay silent on the
 * rogue import. Both types are listed wherever a vendor boundary is asserted.
 */
module.exports = {
  forbidden: [
    // ── Structural ───────────────────────────────────────────────────────────
    {
      name: "no-circular",
      severity: "error",
      comment:
        "A cycle makes module initialisation order load-bearing, which surfaces as " +
        "an intermittently undefined import. ESLint cannot see multi-hop cycles.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-app-depends-on-app",
      severity: "error",
      comment:
        "The mobile app and the API share code through packages/, never through each " +
        "other. A direct edge would drag React Native into the server bundle and make " +
        "the two deployments unshippable independently (SAD §4.1).",
      from: { path: "^apps/mobile" },
      to: { path: "^apps/api" },
    },
    {
      name: "no-api-depends-on-mobile",
      severity: "error",
      comment:
        "The reverse of the above, stated separately so the message names the right file.",
      from: { path: "^apps/api" },
      to: { path: "^apps/mobile" },
    },

    // ── The domain core (SAD §3.1, §1.2 principle 3) ─────────────────────────
    {
      name: "domain-is-framework-free",
      severity: "error",
      comment:
        "packages/domain is the layer every other layer depends on, so it must depend " +
        "on nothing. One `import { Injectable }` and the purity claim, the fast test " +
        "run and the mobile bundle all go at once.",
      from: { path: "^packages/domain" },
      to: {
        // `npm-no-pkg` is required, not optional — see the header note. It is the
        // type an UNDECLARED framework import carries under pnpm, i.e. the exact
        // violation these rules exist to catch.
        dependencyTypes: ["npm", "npm-no-pkg"],
        path: "node_modules/(react|react-native|expo|@nestjs|drizzle-orm|postgres|ioredis|@supabase|zustand|@tanstack)",
      },
    },
    {
      name: "domain-does-not-depend-on-application",
      severity: "error",
      comment:
        "Dependencies point inward: use cases depend on the domain, never the reverse. " +
        "An import in this direction is how a port interface quietly becomes a use case.",
      from: { path: "^packages/domain" },
      to: { path: "^packages/application" },
    },
    {
      name: "application-depends-only-on-domain",
      severity: "error",
      comment:
        "The application layer orchestrates the domain and is otherwise framework-free, " +
        "which is what lets the same use cases serve the API, a worker and a test. " +
        "Supabase, Nest and Drizzle arrive through ports the callers inject.",
      from: { path: "^packages/application" },
      to: {
        // Both types are required — see the `dependencyTypes` note in the header.
        dependencyTypes: ["npm", "npm-no-pkg"],
        path: "node_modules/(react|react-native|expo|@nestjs|drizzle-orm|postgres|ioredis|@supabase|zustand|@tanstack)",
      },
    },
    {
      name: "contracts-are-dependency-light",
      severity: "error",
      comment:
        "packages/contracts is imported by the mobile app, the API and (later) the " +
        "generated client. Anything but zod here lands in all three bundles.",
      from: { path: "^packages/contracts" },
      to: {
        // Both types are required — see the `dependencyTypes` note in the header.
        dependencyTypes: ["npm", "npm-no-pkg"],
        path: "node_modules/(react|react-native|expo|@nestjs|drizzle-orm|postgres|ioredis|@supabase)",
      },
    },

    // ── The API's own layers ─────────────────────────────────────────────────
    {
      name: "infrastructure-does-not-depend-on-modules",
      severity: "error",
      comment:
        "A module owns a feature; infrastructure owns a capability. Reaching back from " +
        "infrastructure into a feature module inverts the dependency and is the usual " +
        "first step to a cycle (SAD §4.2).",
      from: { path: "^apps/api/src/infrastructure" },
      to: { path: "^apps/api/src/(modules|jobs)" },
    },
    {
      name: "common-is-foundation-only",
      severity: "error",
      comment:
        "common/ holds the pipeline (pipes, filters, interceptors, guards) and must not " +
        "know about any feature. Nest resolves it before the module graph, so an edge " +
        "out of it is also a boot-order hazard.",
      from: { path: "^apps/api/src/common" },
      to: { path: "^apps/api/src/(modules|jobs|infrastructure)" },
    },

    // ── The Supabase adapter boundary (SAD §1.2 principle 3) ─────────────────
    {
      name: "supabase-sdk-is-behind-an-adapter",
      severity: "error",
      comment:
        "Supabase is infrastructure, not architecture. Feature code and screens must go " +
        "through lib/supabase or the feature repository, so replacing the platform is an " +
        "adapter change (SAD §1.2 principle 3).",
      from: {
        path: "^apps/mobile/src/(features|components|theme|stores)",
      },
      to: {
        path: "node_modules/@supabase",
        // TYPE-ONLY EDGES ARE NOT VIOLATIONS, and this exclusion is what keeps the
        // rule honest rather than noisy. `import type { SupabaseClient }` is erased
        // by the compiler, so it cannot keep the platform from being swapped — the
        // coupling this rule exists to prevent is CONSTRUCTING a client outside the
        // adapter. Measured on the real tree: with no exclusion this rule reported
        // two violations, both of them `import type` declarations in
        // `features/society/repository/society.repository.supabase.ts` and
        // `features/auth/api/auth.api.ts`, while both files actually reached the SDK
        // through the shared `@/lib/supabase/supabase.client`. Banning those would
        // have forced hand-copied duplicate types — the opposite of the intent.
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "features-do-not-import-features",
      severity: "error",
      comment:
        "Vertical slices (SAD §4.2): a feature exposes hooks, and another feature calls " +
        "those hooks. Reaching into a sibling’s internals is what turns a slice into a " +
        "tangle. Complements the ESLint rule of the same intent, which only sees files " +
        "it lints.",
      from: { path: "^apps/mobile/src/features/([^/]+)/" },
      to: {
        path: "^apps/mobile/src/features/([^/]+)/",
        pathNot: "^apps/mobile/src/features/$1/",
      },
    },
    {
      name: "no-schemas-import-hooks",
      severity: "error",
      comment:
        "Within a feature the direction is components → hooks → services → schemas. A " +
        "schema importing a hook is a form that cannot be tested or reused without React.",
      from: { path: "^apps/mobile/src/features/.*/schemas/" },
      to: { path: "^apps/mobile/src/features/.*/hooks/" },
    },
  ],

  options: {
    // Never traverse into dependencies — the rules above only need to know that an
    // edge exists and where it lands. Following node_modules makes the run take
    // minutes and says nothing new.
    //
    // `doNotFollow` and `exclude` are NOT interchangeable, and the difference was
    // measured rather than assumed:
    //
    //   doNotFollow node_modules            → the edge is reported, marked
    //                                         `followable: false`. Rules see it.
    //   exclude node_modules                → the edge is REMOVED. Rules cannot
    //                                         see it. Every vendor-boundary rule
    //                                         below becomes silently vacuous.
    //
    // An earlier version of this file had node_modules in both, and the four
    // `*-framework-free` / `*-behind-an-adapter` rules passed on a deliberately
    // planted `import { createClient } from '@supabase/supabase-js'` inside a
    // mobile feature. They were enforcing nothing.
    doNotFollow: { path: "(^|/)node_modules" },
    //
    // `exclude` must name OUR OWN build output, never a bare `dist`. A blanket
    // `(^|/)(dist|...)/` also matches the resolved path of every npm package that
    // ships compiled files — `@supabase/supabase-js` resolves to
    // `node_modules/.pnpm/@supabase+supabase-js@2.116.0/node_modules/@supabase/
    // supabase-js/dist/module/index.js` — so the target module is excluded, the
    // edge disappears, and the vendor-boundary rules go quiet again by a second,
    // subtler route than the `doNotFollow`/`exclude` confusion above. Measured:
    // with a bare `dist`, a planted `@supabase/supabase-js` import reported
    // "0 dependencies cruised" — not a pass, an empty graph.
    exclude: {
      path: "(^|/)\\.expo/|(^|/)(apps|packages)/[^/]+/(dist|coverage|android|ios)/",
    },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    enhancedResolveOptions: {
      // Metro and Node both accept extensionless relative imports; without this
      // the graph has holes and a rule can pass because the edge was invisible.
      extensions: [".js", ".jsx", ".ts", ".tsx", ".json"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
