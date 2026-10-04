import { createParamDecorator, type ExecutionContext } from "@nestjs/common";

import { readRequestHeader } from "../http/http-access";

/**
 * `@HeaderParam("idempotency-key", new ZodPipe(idempotencyKeySchema))` — one request
 * header as a handler parameter, validated by pipes like every other parameter.
 *
 * ## Why this exists instead of `@Headers("idempotency-key", …)`
 *
 * Nest's `@Headers` is declared `(property?: string) => ParameterDecorator`, so it
 * has no slot for a pipe: `@Headers("x", new ZodPipe(schema))` does not compile
 * (`TS2554: Expected 0-1 arguments, but got 2`). A header that is *required* and
 * *shaped* — SAD §7.7's `Idempotency-Key` — therefore needs a decorator of its own,
 * or the route has to hand-roll the validation the pipe already does for `@Body`,
 * `@Param` and `@Query`.
 *
 * `createParamDecorator`'s returned decorator does accept pipes (`(...dataOrPipes)`),
 * and the framework applies them to CUSTOM parameters exactly as it does to the
 * built-in ones. So a header refused here is refused with the same two-stage
 * classification as any other input (SAD §7.8): absent or wrong-typed → `400`,
 * present but out of range → `422`, both carrying the same `ErrorPayload` shape.
 *
 * ## The header name is also the field
 *
 * `ArgumentMetadata.data` for a parameter decorator is whatever it was given, so a
 * `ZodPipe` on a scalar schema — whose issue path is empty, because a string has no
 * field to name — reports the *header name* as `field`. Those are lowercase wire
 * names (`"idempotency-key"`), which is the convention this codebase already uses for
 * the one other required header: `SocietyGuard` reports a missing society as
 * `field: "x-society-id"` (see `SOCIETY_HEADER`).
 *
 * ## One read, defensively
 *
 * The value comes from `readRequestHeader`, so it is the header as either adapter
 * spells it, an empty header counts as absent (rather than an empty string the schema
 * would then have to reject separately), and a request object of an unexpected shape
 * yields `undefined` instead of throwing inside argument resolution.
 */
export const HeaderParam = createParamDecorator(
  (name: string, context: ExecutionContext): string | undefined =>
    readRequestHeader(context.switchToHttp().getRequest(), name),
);
