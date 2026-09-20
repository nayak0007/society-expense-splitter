import {
  BadRequestException,
  Injectable,
  UnprocessableEntityException,
  type ArgumentMetadata,
  type PipeTransform,
} from "@nestjs/common";
import type { ZodError, ZodType } from "zod";

import { buildErrorPayload, type ErrorPayload } from "../errors/app-error";

/**
 * Zod validation pipe — SAD §7.8 and §7.10.
 *
 * Validation has two stages, and they are distinguishable by outcome, not by
 * where the rule was written:
 *
 *  - **Syntactic** (§7.8 stage 1): the payload's shape is wrong — a missing
 *    required field, a wrong type, or an unknown field, since contract schemas
 *    are strict so unknown input is rejected rather than silently dropped.
 *    → `400`.
 *  - **Semantic** (§7.8 stage 2): the shape is right but the values are not —
 *    percentages that do not total 100, `dateTo` before `dateFrom`. These are
 *    `refine`/`check` rules on the same schema. → `422`.
 *
 * Schemas come from `@ses/contracts`, so the client validates exactly the same
 * rules before a round trip; this pipe is the server-side enforcement of a
 * contract that already exists on both sides.
 *
 * The thrown exception carries the finished `ErrorPayload`, so the response body
 * is the SAD shape as soon as the exception filter renders it — there is no
 * second translation step where `field` or `details` can be dropped.
 */

/**
 * Zod issue codes meaning "this input should not have been here at all". Treated
 * as syntactic, per §7.8 stage 1, which names strict unknown-field rejection
 * explicitly.
 */
const SYNTACTIC_ISSUE_CODES: ReadonlySet<string> = new Set([
  "unrecognized_keys",
  "invalid_type",
]);

/** Derives the issue type from the installed Zod, so no internal import is needed. */
type ZodIssueLike = ZodError["issues"][number];

/**
 * SAD §7.10 examples use `splitConfig.percentages[2]` for array members, so
 * numeric path segments are bracketed rather than dot-joined.
 */
function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
      continue;
    }
    out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

/**
 * A schema can name its own machine code by attaching
 * `params: { code: 'OUT_OF_RANGE' }` to a `refine`, which is how the SAD's
 * catalogue codes (`OUT_OF_RANGE`, `LIMIT`, `STALE`) are produced. Without it,
 * Zod's own code is uppercased so the field is never empty — a client branching
 * on `details[].code` needs a stable value either way.
 */
function issueCodeOf(issue: ZodIssueLike): string {
  const params: unknown = (issue as { params?: unknown }).params;
  if (typeof params === "object" && params !== null) {
    const custom: unknown = (params as { code?: unknown }).code;
    if (typeof custom === "string" && custom !== "") {
      return custom;
    }
  }
  return issue.code.toUpperCase();
}

/** Zod exposes the offending value as `input` on the issue for most codes. */
function issueReceivedOf(issue: ZodIssueLike): unknown {
  return (issue as { input?: unknown }).input;
}

@Injectable()
export class ZodPipe<TOutput> implements PipeTransform<unknown, TOutput> {
  constructor(private readonly schema: ZodType<TOutput>) {}

  // `_metadata` is unused: returning the parsed value is enough. Prefixed with
  // an underscore because `noUnusedParameters` is enabled and this signature is
  // fixed by the interface.
  transform(value: unknown, _metadata: ArgumentMetadata): TOutput {
    const result = this.schema.safeParse(value);

    if (result.success) {
      return result.data;
    }

    throw this.toException(result.error);
  }

  private toException(
    error: ZodError,
  ): BadRequestException | UnprocessableEntityException {
    const issues = error.issues;

    const details = issues.map((issue) => {
      const detail = {
        field: formatPath(issue.path),
        code: issueCodeOf(issue),
        message: issue.message,
        received: issueReceivedOf(issue),
      };
      return detail.field === "" ? { ...detail, field: "(root)" } : detail;
    });

    // One classification for the whole payload: if any part of the shape is
    // wrong, "the request is malformed" is the more useful answer than "a value
    // is semantically wrong", and the details still list every individual issue.
    const isSyntactic = issues.some((issue) =>
      SYNTACTIC_ISSUE_CODES.has(issue.code),
    );

    // The first issue's message carries the specific problem; the rest are in
    // `details`, matching the SAD's example where `message` is the headline
    // ("Split percentages must total 100%") and `details` the per-field list.
    const payload: ErrorPayload = buildErrorPayload(
      "VALIDATION_ERROR",
      issues.length === 1
        ? (issues[0]?.message ?? "The request payload is invalid")
        : `${String(issues.length)} problems found in the request payload; see details`,
      { field: details[0]?.field ?? "(root)", details },
    );

    return isSyntactic
      ? new BadRequestException(payload)
      : new UnprocessableEntityException(payload);
  }
}
