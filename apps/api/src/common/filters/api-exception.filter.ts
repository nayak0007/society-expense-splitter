import { randomUUID } from "node:crypto";

import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { ErrorCode } from "@ses/contracts";

import {
  AppError,
  buildErrorPayload,
  completeErrorBody,
  isErrorPayload,
  type ErrorPayload,
} from "../errors/app-error";
import { RequestContext } from "../context/request-context";
import { readRequestId } from "../http/http-access";
import { isHealthProbeUrl } from "../http/probe-paths";

/**
 * Renders every failure as the SAD §7.10 error envelope.
 *
 * WHY THIS EXISTS IN THE FOUNDATION SLICE: the Zod pipe can only be said to
 * *work* once its output reaches the client in the documented shape — a
 * validator whose 422 body Nest re-wraps as `{ statusCode, message }` has not
 * delivered the `code`/`field`/`details` contract clients branch on. The success
 * envelope interceptor (T020) is still outstanding; this is the error half.
 *
 * Health probes are deliberately excluded: SAD §17.5 defines them for
 * orchestrators, which read the status code, and terminus's own body carries
 * diagnostic detail an operator needs. Rewriting it into the API envelope would
 * lose that for no gain.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    // A standalone application context (the worker) has no HTTP host.
    if (host.getType() !== "http") {
      this.logger.error(
        exception instanceof Error ? exception.message : String(exception),
      );
      return;
    }

    const { httpAdapter } = this.httpAdapterHost;
    const context = host.switchToHttp();
    const request: unknown = context.getRequest();
    const response: unknown = context.getResponse();

    const requestId =
      RequestContext.requestId() ?? readRequestId(request) ?? randomUUID();
    const { status, payload } = resolve(exception);

    if (isHealthProbeUrl(httpAdapter.getRequestUrl(request))) {
      // Re-emit the original body so probe diagnostics survive.
      const original =
        exception instanceof HttpException
          ? exception.getResponse()
          : { message: payload.message };
      httpAdapter.reply(response, original, status);
      return;
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // SAD §7.10: the client gets a generic message; the detail goes to the log.
      this.logger.error(
        `${payload.code} ${payload.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`${payload.code} ${payload.message}`);
    }

    httpAdapter.reply(
      response,
      { error: completeErrorBody(payload, requestId) },
      status,
    );
  }
}

/**
 * Maps an arbitrary thrown value to a status and a catalogue payload.
 *
 * Order matters: `AppError` and our pipes carry a finished payload, so they are
 * trusted; anything else from a library is described in the SAD's vocabulary
 * rather than echoed, because a foreign body would leak internals and break the
 * client's `code`-based branching.
 */
function resolve(exception: unknown): {
  status: number;
  payload: ErrorPayload;
} {
  if (exception instanceof AppError) {
    return { status: exception.status, payload: exception.payload };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();

    if (
      typeof response === "object" &&
      response !== null &&
      isErrorPayload(response)
    ) {
      return { status, payload: response };
    }

    return {
      status,
      payload: payloadFromStatus(status, describe(response, exception.message)),
    };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    payload: buildErrorPayload(
      "INTERNAL",
      // SAD §7.10: stack traces and internal detail never reach the client.
      "Something went wrong on our side. Quote the request id when contacting support.",
    ),
  };
}

/** Extracts a human-readable message from a Nest `HttpException` body. */
function describe(response: object | string, fallback: string): string {
  if (typeof response === "string") {
    return response;
  }
  const message: unknown = (response as { message?: unknown }).message;
  if (typeof message === "string") {
    return message;
  }
  if (Array.isArray(message)) {
    const parts = message.filter(
      (part): part is string => typeof part === "string",
    );
    return parts.length > 0 ? parts.join("; ") : fallback;
  }
  return fallback;
}

/**
 * Status-to-code fallback for exceptions this API did not construct — a Nest
 * built-in guard rejection, a body-parser failure, an unmapped library error.
 *
 * Written out rather than derived from `HTTP_STATUS_BY_ERROR_CODE`, because
 * several codes share a status (409 covers `CONFLICT`, `VERSION_MISMATCH` and
 * `DUPLICATE_RESOURCE`) and inverting that map would pick one arbitrarily. An
 * exception we did not build cannot identify its own cause, so it reports the
 * most general code for the status instead of guessing.
 */
const FALLBACK_CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  422: "VALIDATION_ERROR",
  429: "RATE_LIMITED",
  500: "INTERNAL",
  503: "DEPENDENCY_UNAVAILABLE",
};

function payloadFromStatus(status: number, message: string): ErrorPayload {
  const code =
    FALLBACK_CODE_BY_STATUS[status] ??
    (status >= 500 ? "INTERNAL" : "VALIDATION_ERROR");

  // No structured `details`: an exception we did not construct has no field
  // paths, and inventing them would be worse than omitting them (SAD §7.10 says
  // `details` is present only for multi-field validation failures).
  return buildErrorPayload(code, message);
}
