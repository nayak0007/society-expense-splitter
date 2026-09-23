import { SetMetadata } from "@nestjs/common";

/**
 * Marks a handler whose response must not be wrapped in the success envelope.
 *
 * The envelope (SAD §7.9) says a successful response always carries `data` and
 * `meta`. That rule has exactly one honest exception: a `204 No Content` — a
 * delete, which has nothing to say — where a `data` member would have to be
 * invented and would then be false. The alternative, returning `200` with a
 * meaningless body, keeps the rule literally true while making it useless.
 *
 * An explicit marker rather than a status-code check inside the interceptor: the
 * status is set by `@HttpCode`, which an interceptor cannot read before the
 * handler runs, so inferring it there would mean importing Nest's internal
 * `HTTP_CODE_METADATA` key and depending on its spelling.
 */
export const NO_ENVELOPE_KEY = "ses:noEnvelope";

export const NoEnvelope = (): MethodDecorator & ClassDecorator =>
  SetMetadata(NO_ENVELOPE_KEY, true);
