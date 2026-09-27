import { applyDecorators } from "@nestjs/common";
import { ApiHeader } from "@nestjs/swagger";

/**
 * Declares `X-Society-Id` on a guarded route, for Swagger.
 *
 * Apply it wherever `@RequirePermission` is applied, and nowhere else: the two
 * describe the same thing from two directions — the guard *requires* the header,
 * and this *documents* that it does. A route that documents a header it does not
 * require is worse than one that documents nothing, because a client generator
 * will start sending it and then depend on it.
 *
 * It exists as a decorator rather than as a line of YAML in a committed spec
 * because the spec is generated (`pnpm openapi`) and a hand-edit is reverted by
 * the next run. The contract in `@ses/contracts` cannot carry it either: a
 * request header is not part of a payload schema.
 *
 * `required: true` is deliberate even though the runtime answer for an absent
 * header is a 400 rather than a validation error on a field — the alternative
 * lets a generated client omit it and discover the requirement in production.
 */
export function ApiSocietyContext(): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiHeader({
      name: "X-Society-Id",
      required: true,
      description:
        "The society this request is scoped to (UUID). Authorisation is evaluated against the caller's membership in it.",
      schema: { type: "string", format: "uuid" },
    }),
  );
}
