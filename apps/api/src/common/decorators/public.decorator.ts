import { SetMetadata } from "@nestjs/common";

/**
 * Marks a route (or a whole controller) as reachable without a session.
 *
 * The auth guard is registered **globally** and this is the only way to opt out,
 * which is the deliberate direction (Roadmap T041): a new endpoint is protected
 * unless someone writes `@Public()` on it, so forgetting the guard fails closed.
 * The opposite default — protecting routes one decorator at a time — fails open,
 * and the failure is invisible until a cross-tenant test happens to cover the
 * route that was missed.
 *
 * Every current use is a documented exception rather than a convenience:
 * health probes (SAD §17.5 — orchestrators cannot hold a session) and the public
 * join-code lookup (PRD §3.2, whose exposure is bounded by the SQL function
 * returning name, city, state, type and member count and nothing else).
 */
export const IS_PUBLIC_KEY = "ses:isPublic";

export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
