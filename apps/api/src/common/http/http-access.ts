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
 * Echoes a header on the way out. `pino-http` attaches the id to the request but
 * never writes it to the response, and SAD §7.10 makes the request id the string
 * support asks a user for, so it has to be visible in the response.
 *
 * Tries Node's `setHeader` first (what `pino-http`'s own types assume) and falls
 * back to Fastify's `header`. Silent when neither exists — a missing correlation
 * header must never be the thing that fails a request.
 */
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
