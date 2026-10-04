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

/**
 * The error responses T064's preview route can return.
 *
 * The 404 description is the same three indistinguishable cases the category routes
 * name, and the preview adds a fourth of the same kind: a building, wing or excluded
 * apartment the selector names that this society does not have is answered by the
 * resolver as `not_found` for exactly the same reason — a distinguishable answer would
 * let a caller enumerate another tenant's structure (PRD T041). The 403 is narrow: the
 * caller is an active member, and the only thing a 403 can mean is a role that does not
 * hold `expense.create` (Admin, Treasurer or Committee Member — the matrix's delegated
 * cell for composing an expense, which is what a preview is).
 *
 * A preview performs no write, so no state can conflict and no 409 is produced; the
 * `conflict` copy says so rather than documenting a status a client might retry on.
 */
export function ApiExpensePreviewErrors(): ClassDecorator & MethodDecorator {
  return ApiErrorResponses({
    notFound:
      "No such society, no such category, building or apartment — or one the caller is not an active member of. This API deliberately does not distinguish these (PRD T041).",
    forbidden:
      "An active member whose role does not hold `expense.create`: Admin, Treasurer or Committee Member (the Committee Member's grant is draft-only, which is what a preview composes).",
    conflict:
      "Not produced by this route: a preview performs no write, so no state can conflict.",
  });
}

/**
 * The error responses T065's draft routes can return.
 *
 * The 404 copy is the module's usual three-indistinguishable-cases sentence, with an
 * expense added to the list. The 403 names both narrowed cells explicitly, because
 * the difference between them is the whole content of the routes: `expense.create`
 * is Admin/Treasurer/Committee (draft-only for the Committee Member), `expense.void`
 * is Admin/Treasurer or a Committee Member's **own drafts** — and deleting is
 * narrower still, creator only. A client that rendered the same disabled state for
 * all of them would hide which rule refused it.
 *
 * The 409 carries two refusals: the optimistic lock (`VERSION_MISMATCH`, whose
 * `details[0].current` is the row's current version — the SAD §7.11 shape) and an
 * expense that already has splits, which must be voided rather than deleted. A
 * `published`/`void` edit or a non-draft delete is `INVALID_TRANSITION`, also 409,
 * documented on the operations themselves.
 */
export function ApiExpenseDraftErrors(): ClassDecorator & MethodDecorator {
  return ApiErrorResponses({
    notFound:
      "No such society, expense or category — or one the caller is not an active member of. This API deliberately does not distinguish these (PRD T041).",
    forbidden:
      "An active member whose role does not hold the needed action: `expense.create` to add (Admin, Treasurer, or a Committee Member's draft-only cell), `expense.void` to edit or delete (Admin/Treasurer, or a Committee Member's own drafts), `expense.view` to read (every role but Guest). Deleting a draft is creator-only.",
    conflict:
      "The expense moved since the caller last read it (`VERSION_MISMATCH`, with `details[0].current` carrying the current version), or it already has splits and must be voided rather than deleted.",
  });
}
