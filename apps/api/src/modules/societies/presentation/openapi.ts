import { ApiErrorResponses } from "../../../common/swagger/zod-openapi";

/**
 * The society module's OpenAPI surface.
 *
 * The Zod→OpenAPI bridge and the error-response decorator now live in
 * `common/swagger/zod-openapi.ts`, because the building module needs both and a
 * second copy of a schema emitter is a second contract. They are re-exported here
 * so this module's own files keep importing the document helpers from beside the
 * controller that uses them, and so nothing else has to change.
 */
export {
  envelopeSchemaOf,
  errorEnvelopeJsonSchema,
  jsonSchemaOf,
} from "../../../common/swagger/zod-openapi";

/**
 * The error responses every society route can return.
 *
 * The 404 wording is the one that carries the most information, and it is
 * deliberately blunt about it: "no such society — or one the caller is not a
 * member of, which this API does not distinguish (PRD T041)". A client generator
 * that reads that will not write a branch that guesses.
 */
export function ApiSocietyErrors(): ClassDecorator & MethodDecorator {
  return ApiErrorResponses({
    notFound:
      "No such society — or one the caller is not a member of, which this API deliberately does not distinguish (PRD T041).",
    forbidden: "A member without the role this operation needs.",
    conflict:
      "The change conflicts with the current state, such as a sole Admin trying to leave.",
  });
}
