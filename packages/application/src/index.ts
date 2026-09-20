/**
 * `@ses/application` — the application layer.
 *
 * One use case per business operation, each a pure function of
 * `(deps, actor, command)` returning a `Result`. This is the layer the UI and the
 * API both call. It is the only layer that orchestrates a repository, and it
 * depends on `@ses/domain` alone — no framework, no React, no provider SDK, no
 * knowledge of HTTP or of Supabase.
 *
 * Layering (SAD §3.1 — dependencies point inward):
 *
 *   presentation    screens, route wrappers, hooks, controllers
 *   application     ← this package: use cases + their commands
 *   domain          @ses/domain: entities, value objects, rules, ports
 *   infrastructure  repository adapters, gateways — implements the domain's ports
 *
 * WHY THIS IS A PACKAGE AND NOT A FOLDER INSIDE AN APP: the sole-admin invariant
 * in `leaveSociety` and the capability checks in `updateSociety`/`deleteSociety`
 * are the same rules the API must enforce. If each consumer keeps its own copy,
 * client and server drift — and in a money application that drift is a security
 * bug rather than an inconvenience. One implementation, two callers.
 */
export * from "./society";
