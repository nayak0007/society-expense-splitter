import { applyDecorators } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from "@nestjs/swagger";
import { errorEnvelopeSchema, successEnvelopeSchema } from "@ses/contracts";
import { z } from "zod";
import type { SchemaObject } from "@nestjs/swagger";

/**
 * Zod → OpenAPI, once, for every module.
 *
 * Moved here from the society module's `presentation/openapi.ts` when the
 * building module needed the same bridge. The reason it exists at all is worth
 * restating, because it is the reason it must not be copied:
 * `@nestjs/swagger` has no Zod bridge (it documents `@ApiProperty` classes), and
 * hand-writing a `schema` object per route would create a **third** definition of
 * each response shape — alongside the contract schema the client parses and the
 * mapper that fills it. Three definitions is one too many, and the hand-written
 * copy is the one no test catches drifting.
 *
 * Zod 4 can emit JSON Schema directly, and `target: "openapi-3.0"` is what makes
 * the output valid for the document this project commits: 3.0 has no `const`, no
 * `type` arrays and no `$defs`, and Zod translates accordingly
 * (`z.literal("IN")` becomes `enum: ["IN"]`).
 *
 * What is *not* shared is the prose: each module's 404 means something slightly
 * different (a society the caller is not in, a building that is not in that
 * society), and a generated document that describes both identically is worse
 * than one that describes neither. `ApiErrorResponses` takes the copy.
 */

/** Bounds Zod attaches to every `z.number().int()`; noise in a document. */
const SAFE_INT_MIN = Number.MIN_SAFE_INTEGER;
const SAFE_INT_MAX = Number.MAX_SAFE_INTEGER;

export function jsonSchemaOf(schema: z.ZodType): SchemaObject {
  return z.toJSONSchema(schema, {
    target: "openapi-3.0",
    // Two of Zod's faithful-but-useless emissions: the regex it attaches to
    // `z.iso.datetime()` (a leap-year-correct monster, whereas `format:
    // date-time` already says what a client needs) and the ±2^53 bounds on every
    // integer. Both are true; neither helps a reader of the committed document.
    override: (context) => {
      const { jsonSchema } = context as { jsonSchema: Record<string, unknown> };
      if (jsonSchema.format === "date-time" && "pattern" in jsonSchema) {
        delete jsonSchema.pattern;
      }
      if (
        jsonSchema.type === "integer" &&
        jsonSchema.minimum === SAFE_INT_MIN &&
        jsonSchema.maximum === SAFE_INT_MAX
      ) {
        delete jsonSchema.minimum;
        delete jsonSchema.maximum;
      }
    },
  }) as unknown as SchemaObject;
}

/** The SAD §7.9 envelope around a `data` schema. */
export function envelopeSchemaOf(data: z.ZodType): SchemaObject {
  return jsonSchemaOf(successEnvelopeSchema(data));
}

/** The SAD §7.10 failure body — identical for every route in the API. */
export function errorEnvelopeJsonSchema(): SchemaObject {
  return jsonSchemaOf(errorEnvelopeSchema);
}

/** Module-specific wording for the three refusals a tenant route can produce. */
export interface ErrorResponseCopy {
  /** What 404 means here — including the case it is deliberately hiding. */
  readonly notFound: string;
  /** What 403 means here — a member whose role is insufficient. */
  readonly forbidden: string;
  /** What 409 means here, when the module can produce one. */
  readonly conflict: string;
}

/**
 * The error responses every tenant route can return, declared once per module.
 *
 * Applied at controller level, so a new route inherits them and cannot ship with
 * an undocumented failure mode. `429` is listed even though no throttler is
 * registered yet: SAD §7.6 makes rate limiting a platform-wide guarantee, and a
 * client that builds retry behaviour from the document should already see it.
 */
export function ApiErrorResponses(
  copy: ErrorResponseCopy,
): ClassDecorator & MethodDecorator {
  const schema = errorEnvelopeJsonSchema();
  return applyDecorators(
    ApiBearerAuth("supabase-jwt"),
    ApiUnauthorizedResponse({
      description: "No session, an invalid token, or an expired one.",
      schema,
    }),
    ApiForbiddenResponse({ description: copy.forbidden, schema }),
    ApiNotFoundResponse({ description: copy.notFound, schema }),
    ApiConflictResponse({ description: copy.conflict, schema }),
    ApiBadRequestResponse({ description: "Malformed payload.", schema }),
    ApiUnprocessableEntityResponse({
      description: "Well-formed payload whose values are invalid.",
      schema,
    }),
    ApiTooManyRequestsResponse({ description: "Rate limited.", schema }),
  );
}
