import { ApiErrorResponses } from "../../../common/swagger/zod-openapi";

/**
 * The error responses every building route can return.
 *
 * The 404 description names three cases that must stay indistinguishable, because
 * they are the ones a client is most likely to want to tell apart and must not be
 * able to: a society the caller has no membership in, a building that is not in
 * the named society, and a building that does not exist. All three answer
 * identically so a caller cannot enumerate structure they cannot see (PRD T041),
 * and the guard answers the society case before the handler ever runs.
 *
 * The 403 description is narrower than the society module's, and deliberately so:
 * by the time a building route reaches this point the caller *is* an active member
 * of the society, so the only thing a 403 can mean here is a role that does not
 * hold `structure.edit` (writes) or `structure.view` (reads).
 */
export function ApiStructureErrors(): ClassDecorator & MethodDecorator {
  return ApiErrorResponses({
    notFound:
      "No such society, no such building — or one the caller is not an active member of. This API deliberately does not distinguish these (PRD T041).",
    forbidden:
      "An active member whose role does not hold the action this operation needs: `structure.edit` for writes, `structure.view` for reads.",
    conflict:
      "A building with that name already exists in this society; or the building still has flats, so it cannot be removed (`code: BUILDING_HAS_APARTMENTS`).",
  });
}

/**
 * The error responses the flat routes can return.
 *
 * Separate from `ApiStructureErrors()` because one refusal differs and the
 * difference is the whole reason a client reads the document: a `409` here is a
 * duplicate flat number *inside one building*, which is a different thing to fix
 * (rename the flat) from a duplicate building name (rename the building). The 404
 * and 403 wording is the same and is restated rather than inherited, because
 * `ApiErrorResponses` builds one document per controller and a shared prose
 * constant would be a second place to forget when the routes change.
 */
export function ApiApartmentErrors(): ClassDecorator & MethodDecorator {
  return ApiErrorResponses({
    notFound:
      "No such society, no such flat — or one the caller is not an active member of. This API deliberately does not distinguish these (PRD T041).",
    forbidden:
      "An active member whose role does not hold the action this operation needs: `structure.edit` for writes, `structure.view` for reads.",
    conflict: "A flat with that number already exists in this building.",
  });
}
