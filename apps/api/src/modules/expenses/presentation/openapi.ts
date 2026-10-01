import { ApiErrorResponses } from "../../../common/swagger/zod-openapi";

/**
 * The error responses every expense-category route can return.
 *
 * The 404 description names three cases that must stay indistinguishable, because they
 * are the ones a client is most likely to want to tell apart and must not be able to: a
 * society the caller has no membership in, a category that is not in the named society,
 * and a category that does not exist. All three answer identically so a caller cannot
 * enumerate vocabulary they cannot see (PRD T041), and the guard answers the society
 * case before the handler ever runs.
 *
 * The 403 description is narrower than the society module's, and deliberately so: by the
 * time a category route reaches this point the caller *is* an active member of the
 * society, so the only thing a 403 can mean here is a role that does not hold
 * `expense.publish` (writes) or `expense.view` (reads). Both are green cells, so there
 * is no "own records only" qualification to mention — a category has no owner and no
 * draft state.
 *
 * The 409 carries two different refusals and names both, because the difference is the
 * whole reason a client reads the document: a duplicate name (rename the category) and a
 * category an expense still references (deactivate it instead). A client that could not
 * tell them apart would have to match on message text.
 */
export function ApiExpenseCategoryErrors(): ClassDecorator & MethodDecorator {
  return ApiErrorResponses({
    notFound:
      "No such society, no such category — or one the caller is not an active member of. This API deliberately does not distinguish these (PRD T041).",
    forbidden:
      "An active member whose role does not hold the action this operation needs: `expense.publish` for writes (Admin or Treasurer), `expense.view` for reads (every role but Guest).",
    conflict:
      "A live category of this society already carries that name (`code: CATEGORY_NAME_TAKEN`); or an expense references the category, so it cannot be removed (`code: CATEGORY_HAS_EXPENSES`).",
  });
}
