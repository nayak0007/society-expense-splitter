import { randomUUID } from "node:crypto";

import type { Params } from "nestjs-pino";

import type { AppConfig } from "../config/app-config";

/**
 * Structured JSON logging — SAD §17.4 and §13.7.
 *
 * `pino` rather than Nest's built-in logger because §13.7 makes a **log
 * deny-list with a unit test asserting every forbidden key is redacted** a
 * requirement, and pino's `redact` performs that on the serialisation path, so a
 * value cannot reach the transport by being logged from an unexpected place.
 * Building the same guarantee on `ConsoleLogger` would mean hand-writing
 * structured output, redaction and request-id binding.
 *
 * JSON in every environment, including development. The `transport` option is
 * deliberately unused: pino transports spawn worker threads through a dynamic
 * `require`, which fights the single-file bundle (see
 * `apps/api/rspack.config.js` — the bundler Nest 12 requires, since it is
 * ESM-only) and would put a runtime dependency inside the image that the bundle
 * otherwise would not need. Development readability comes from piping stdout
 * through `pino-pretty` in the npm script instead.
 */

/**
 * Keys that must never reach a log line, from SAD §13.7: passwords, tokens,
 * OTPs, full phone numbers, email addresses, and payment signatures.
 */
export const SENSITIVE_LOG_KEYS = [
  "password",
  "currentPassword",
  "newPassword",
  "token",
  "accessToken",
  "refreshToken",
  "access_token",
  "refresh_token",
  "otp",
  "otpCode",
  "phone",
  "email",
  "signature",
  "razorpaySignature",
  "cardNumber",
  "cvv",
] as const;

/**
 * Redaction paths.
 *
 * Generated from the key list rather than written twice, so a key can never be
 * added to the deny-list without its nested forms being covered too — the
 * `req.headers.*` and `req.body.*` variants are the shapes an HTTP log line
 * actually has, while the bare key covers ad-hoc structured logging.
 *
 * Each wildcard-free path is what pino supports; deep arbitrary nesting is
 * handled by the fact that pino serialises the request itself, and anything
 * logged outside that shape goes through `req.body.<key>` or the bare key.
 */
export const LOG_REDACT_PATHS: readonly string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  ...SENSITIVE_LOG_KEYS,
  ...SENSITIVE_LOG_KEYS.map((key) => `req.body.${key}`),
  ...SENSITIVE_LOG_KEYS.map((key) => `body.${key}`),
];

export const LOG_REDACTION_CENSOR = "[Redacted]";

/**
 * Resolves the correlation id for a request: the caller's `X-Request-Id` if it
 * sent a usable one, otherwise a fresh UUID.
 *
 * Exported because it has two call sites that must agree — the Fastify adapter
 * (which is authoritative, see `main.ts`) and pino's `genReqId` (the fallback for
 * adapters that do not set one). Two copies of this logic would mean a request
 * whose id differs between its access log and its response header, which is worse
 * than having no id at all: support would quote a string that matches nothing.
 */
export function resolveRequestId(
  inbound: string | string[] | undefined,
): string {
  if (typeof inbound === "string" && inbound.trim() !== "") {
    return inbound.trim();
  }
  return randomUUID();
}

/**
 * Health probes run every few seconds; logging them buries everything else in
 * the stream and inflates ingest cost for no diagnostic value.
 */
const QUIET_PATHS = new Set(["/v1/health/live", "/v1/health/ready"]);

/**
 * Builds the `nestjs-pino` module parameters.
 *
 * No custom serializers on purpose: pino-http's defaults already log method, URL
 * and status code, and — importantly — never log the request body. SAD §13.7
 * forbids logging full bodies on financial endpoints, so the safest
 * configuration is the one that has no body to redact.
 */
export function buildLoggerParams(config: AppConfig): Params {
  return {
    pinoHttp: {
      level: config.logLevel,
      redact: {
        paths: [...LOG_REDACT_PATHS],
        censor: LOG_REDACTION_CENSOR,
      },
      /**
       * Fallback only. On Fastify, `request.id` is already set by the adapter's
       * own `genReqId` (see `main.ts`) before pino-http runs, and pino-http
       * respects an existing id — so this applies to adapters that set none. It
       * is kept rather than omitted so a future adapter swap does not silently
       * fall back to pino-http's incrementing `req-N` counter.
       */
      genReqId: (req) => resolveRequestId(req.headers["x-request-id"]),
      customProps: () => ({
        service: "ses-api",
        env: config.environment,
      }),
      autoLogging: {
        ignore: (req) => QUIET_PATHS.has(req.url ?? ""),
      },
    },
  };
}
