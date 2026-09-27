import type { Society, SocietyMembership } from "@ses/domain";

import { REQUEST_ACTOR_KEY, type VerifiedActor } from "../auth/actor";
import {
  REQUEST_MEMBERSHIP_KEY,
  REQUEST_SOCIETY_KEY,
  type SocietyAuthorizationContext,
} from "../authorization/society-authorization";

/**
 * Narrow accessors for the two places this codebase has to touch the HTTP
 * objects generically.
 *
 * WHY NOT A CAST TO `any` OR TO A FRAMEWORK TYPE: the API runs on the Fastify
 * adapter, but `pino-http` attaches `id` to the request in a way that is only
 * typed for Express, and `FastifyReply` exposes `header()` where Node's
 * `ServerResponse` exposes `setHeader()`. Reaching for either framework's type
 * would hard-code the adapter into code that does not otherwise care about it,
 * and `no-explicit-any` is an error here for good reason. So both are read
 * defensively from `unknown`, and the behaviour degrades to a no-op rather than
 * throwing inside request handling.
 */

/** The id `pino-http` assigns via `genReqId`, if this is the adapter that ran. */
export function readRequestId(request: unknown): string | undefined {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  const id: unknown = (request as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** Reads a header from either adapter's request object. */
export function readRequestHeader(
  request: unknown,
  name: string,
): string | undefined {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  const headers: unknown = (request as { headers?: unknown }).headers;
  if (typeof headers !== "object" || headers === null) {
    return undefined;
  }
  const value: unknown = (headers as Record<string, unknown>)[
    name.toLowerCase()
  ];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Extracts the bearer token from the `Authorization` header, or `undefined`.
 *
 * The scheme match is case-insensitive because RFC 7235 makes it so, and real
 * clients (`fetch`, `axios`, `supabase-js`) differ in how they spell it. A
 * malformed value yields `undefined` rather than a partial token: the guard's
 * answer for "no token" and "a token that cannot be parsed" is the same 401, and
 * a half-parsed token would only reach the verifier to fail there.
 */
export function readBearerToken(request: unknown): string | undefined {
  const header = readRequestHeader(request, "authorization");
  if (header === undefined) return undefined;

  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  return token === undefined || token === "" ? undefined : token;
}

/**
 * The actor `SupabaseAuthGuard` verified, if this request passed it.
 *
 * Stored on the request object (the guard runs before the async context exists,
 * so it has nowhere else to put it), then read back by `@Ctx()` and the request
 * context interceptor. Read defensively: a request that never reached the guard
 * — a `@Public()` route, a unit test calling a handler directly — simply has no
 * actor, and this must not throw inside request handling.
 */
export function readRequestActor(request: unknown): VerifiedActor | undefined {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  const actor: unknown = (request as Record<string, unknown>)[
    REQUEST_ACTOR_KEY
  ];
  if (typeof actor !== "object" || actor === null) {
    return undefined;
  }
  const userId: unknown = (actor as { userId?: unknown }).userId;
  return typeof userId === "string" && userId !== ""
    ? (actor as VerifiedActor)
    : undefined;
}

/** Attaches the verified actor to the request for the rest of the pipeline. */
export function writeRequestActor(
  request: unknown,
  actor: VerifiedActor,
): void {
  if (typeof request !== "object" || request === null) {
    return;
  }
  (request as Record<string, unknown>)[REQUEST_ACTOR_KEY] = actor;
}

/**
 * Echoes a header on the way out. `pino-http` attaches the id to the request but
 * never writes it to the response, and SAD §7.10 makes the request id the string
 * support asks a user for, so it has to be visible in the response.
 *
 * Tries Node's `setHeader` first (what `pino-http`'s own types assume) and falls
 * back to Fastify's `header`. Silent when neither exists — a missing correlation
 * header must never be the thing that fails a request.
 */
/**
 * The society `SocietyGuard` resolved for this request, if the route asked for
 * one.
 *
 * Written by the guard (which runs before the async context exists) and read back
 * by `@Ctx()`, the request-context interceptor and anything that needs the tenant
 * without taking it as a parameter. Absent on every route that declares no
 * permission, which is most of them — this is not "the society of this request"
 * so much as "the society this route said it needed".
 */
export function readRequestSociety(request: unknown): Society | undefined {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  const society: unknown = (request as Record<string, unknown>)[
    REQUEST_SOCIETY_KEY
  ];
  return typeof society === "object" && society !== null
    ? (society as Society)
    : undefined;
}

/**
 * The caller's membership in that society. The guard for the permissions that
 * depend on it and the repositories for the tenant it scopes — never a source of
 * authority on its own beyond what `can()` grants.
 */
export function readRequestMembership(
  request: unknown,
): SocietyMembership | undefined {
  if (typeof request !== "object" || request === null) {
    return undefined;
  }
  const membership: unknown = (request as Record<string, unknown>)[
    REQUEST_MEMBERSHIP_KEY
  ];
  return typeof membership === "object" && membership !== null
    ? (membership as SocietyMembership)
    : undefined;
}

/**
 * Attaches the resolved society context for the rest of the request.
 *
 * Both halves at once, from one call: the two are always produced by the same
 * read (`society_snapshot`), and letting them be written separately would allow a
 * request whose membership belongs to a different society than its
 * `currentSociety` — an inconsistency no later layer would notice.
 */
export function writeRequestSocietyContext(
  request: unknown,
  context: SocietyAuthorizationContext,
): void {
  if (typeof request !== "object" || request === null) {
    return;
  }
  const target = request as Record<string, unknown>;
  target[REQUEST_SOCIETY_KEY] = context.society;
  target[REQUEST_MEMBERSHIP_KEY] = context.membership;
}

export function writeResponseHeader(
  response: unknown,
  name: string,
  value: string,
): void {
  if (typeof response !== "object" || response === null) {
    return;
  }
  const target = response as {
    setHeader?: (headerName: string, headerValue: string) => void;
    header?: (headerName: string, headerValue: string) => void;
  };
  if (typeof target.setHeader === "function") {
    target.setHeader(name, value);
    return;
  }
  if (typeof target.header === "function") {
    target.header(name, value);
  }
}
