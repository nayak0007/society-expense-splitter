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
/**
 * The error responses T066's publish route can return.
 *
 * The 404 copy is the module's usual three-indistinguishable-cases sentence with an
 * expense added: the route is header-scoped, so a society the caller has no active
 * membership in is answered before the handler runs, and an expense id that is not in
 * the resolved society is the same invisibility as one that never existed (PRD T041).
 *
 * The 403 is `expense.publish` itself — Admin or Treasurer, no qualification — and
 * that is deliberately narrower than the draft routes' description: a Committee
 * Member who may compose a draft cannot mint a bill, which is the one cell this
 * endpoint exists to enforce.
 *
 * The 409 carries four different refusals and names all four, because a client
 * acts differently on each: `VERSION_MISMATCH` (reload — `details[0].current` has the
 * version), `INVALID_TRANSITION` (the expense is already published or void; there is
 * nothing to retry), `IDEMPOTENCY_KEY_REUSE` (the key names a different request; use
 * a new one) and — since T070 — `APPROVAL_REQUIRED` (the amount is at or above the
 * society's current approval threshold and the row carries no live approval; have an
 * Admin approve it, then publish). A 422 is the conservation/roster class:
 * `SPLIT_MISMATCH` (the allocations do not sum) and the flagged-flat refusal, whose
 * `details` list one entry per flat with nobody to charge.
 */
export function ApiExpensePublishErrors(): ClassDecorator & MethodDecorator {
  return ApiErrorResponses({
    notFound:
      "No such society or expense — or one the caller is not an active member of. This API deliberately does not distinguish these (PRD T041).",
    forbidden:
      "An active member whose role does not hold `expense.publish`: Admin or Treasurer. A Committee Member's draft-only grant does not reach this route.",
    conflict:
      "The expense moved since the caller read it (`VERSION_MISMATCH`, with `details[0].current` carrying the current version); the expense is already published or void (`INVALID_TRANSITION`); the `Idempotency-Key` was already used for a different request (`IDEMPOTENCY_KEY_REUSE`); or the amount meets the society's current approval threshold and the row is not approved (`APPROVAL_REQUIRED` — an Admin must approve it before publication, ADR-0011 D4).",
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
/**
 * The error responses T068's published revision can return — ADR-0009.
 *
 * The 404 is the module's usual indistinguishable-cases sentence, and the 403 names
 * `expense.publish` explicitly: a revision moves money, so it is the **same cell**
 * publication uses (Admin or Treasurer) — a Committee Member's `expense.void`
 * draft-only grant does not reach it, which is exactly the distinction a client
 * needs to render the right disabled state.
 *
 * The 409 carries three refusals and names all three, because a client acts
 * differently on each: `VERSION_MISMATCH` (reload — `details[0].current` has the
 * version), `INVALID_TRANSITION` (the expense is not published), and
 * `DUE_PAID_EXCEEDS_NEW_AMOUNT` — the revision would put an obligation below an
 * already-verified payment, so the whole revision was refused and the office must
 * issue a credit adjustment instead (T086 owns that credit; T068 deliberately does
 * not create it).
 */
export function ApiExpenseRecalculateErrors(): ClassDecorator &
  MethodDecorator {
  return ApiErrorResponses({
    notFound:
      "No such society or expense — or one the caller is not an active member of. This API deliberately does not distinguish these (PRD T041).",
    forbidden:
      "An active member whose role does not hold `expense.publish`: Admin or Treasurer. Revising a published bill is the same capability as publishing it, so a Committee Member's draft-only grant does not reach this route.",
    conflict:
      "The expense moved since the caller read it (`VERSION_MISMATCH`, with `details[0].current` carrying the current version); the expense is not published (`INVALID_TRANSITION`); or the revision would leave an obligation below a verified payment (`DUE_PAID_EXCEEDS_NEW_AMOUNT` — issue a credit adjustment instead, which T068 does not create).",
  });
}

/**
 * The error responses T069's void route can return — ADR-0010.
 *
 * The 403 is `expense.void` for a **published** expense: Admin or Treasurer. A
 * Committee Member's grant on that cell is own-drafts-only, and a draft is not
 * voidable at all, so their request cannot succeed here — which is exactly the
 * distinction a client needs to render the right disabled state.
 *
 * The 409 carries four refusals and names all four, because a client acts
 * differently on each: `VERSION_MISMATCH` (reload — `details[0].current` has the
 * version), `INVALID_TRANSITION` (not published, or already void — void is
 * terminal, so a second attempt is a refusal and never a replay) and
 * `DUE_STATE_UNSUPPORTED` (the expense carries an obligation this version cannot
 * reverse; nothing was written). The 422 is the reason class:
 * `void_reason_too_short` for a blank/one-word reason and `VALIDATION_ERROR` for
 * control characters, both on `field: "reason"`.
 */
export function ApiExpenseVoidErrors(): ClassDecorator & MethodDecorator {
  return ApiErrorResponses({
    notFound:
      "No such society or expense — or one the caller is not an active member of. This API deliberately does not distinguish these (PRD T041).",
    forbidden:
      "An active member whose role does not hold `expense.void` for a published expense: Admin or Treasurer. A Committee Member's grant on that cell covers their own drafts only, and a draft is not voidable.",
    conflict:
      "The expense moved since the caller read it (`VERSION_MISMATCH`, with `details[0].current` carrying the current version); the expense is not published, or has already been voided (`INVALID_TRANSITION` — void is terminal and a second attempt is never treated as a replay); or an obligation of the expense is in a state this app cannot reverse (`DUE_STATE_UNSUPPORTED`, and nothing was written).",
  });
}

/**
 * The error responses T068's revision-history read can return.
 *
 * A read, so no state can conflict: the 409 copy says so rather than documenting a
 * status a client might retry on. The 403 is the catalogue's narrowest read cell —
 * `expense.view` is every role but Guest — and the history is deliberately readable
 * by the same members the expense itself is visible to: the "edited" chip and its
 * tap-through are the transparency feature (PRD §3.5.3), not an officer-only audit
 * log. An expense with no revisions answers an empty list, never a 404.
 */
/**
 * The error responses T070's approve route can return — ADR-0011.
 *
 * The 403 is `expense.approve` itself — a **full** Admin cell, no qualification —
 * and that is deliberately narrower than the draft routes' description: a Treasurer
 * or a Committee Member cannot decide an expense, and the matrix's cell says so
 * rather than a self-approval rule (an Admin **may** approve their own expense, so a
 * client that rendered "you cannot approve what you created" would be wrong).
 *
 * The 404 is the module's usual indistinguishable-cases sentence with an expense
 * added: an id outside the resolved society answers exactly as one that never
 * existed (PRD T041).
 *
 * The 409 carries two refusals and names both, because a client acts differently on
 * each: `VERSION_MISMATCH` (reload — `details[0].current` has the version) and
 * `INVALID_TRANSITION` — the row is not `pending_approval`, or it has already been
 * approved, so a second attempt is a refusal and never a quiet replay. Approval
 * writes no financial row, so no 422 class is produced here.
 */
export function ApiExpenseApproveErrors(): ClassDecorator & MethodDecorator {
  return ApiErrorResponses({
    notFound:
      "No such society or expense — or one the caller is not an active member of. This API deliberately does not distinguish these (PRD T041).",
    forbidden:
      "An active member whose role does not hold `expense.approve`: Admin only. A Treasurer or Committee Member cannot decide an expense — and an Admin may approve their own, so this is never a self-approval rule.",
    conflict:
      "The expense moved since the caller read it (`VERSION_MISMATCH`, with `details[0].current` carrying the current version); the expense is not awaiting approval, or has already been approved (`INVALID_TRANSITION` — a second approval is never treated as a replay).",
  });
}

/**
 * The error responses T070's reject route can return — ADR-0011.
 *
 * The 403 is the same **full** Admin cell the approve route enforces
 * (`expense.approve`): rejecting a high-value expense is the other half of the same
 * decision, so a role that cannot approve cannot reject either.
 *
 * The 404 is the module's usual indistinguishable-cases sentence with an expense
 * added, and the 409 carries the same pair as approve — `VERSION_MISMATCH` (reload)
 * and `INVALID_TRANSITION` (the row is not `pending_approval`, so there is nothing to
 * reject). The 422 is the reason class: `void_reason_too_short` for a reason under
 * ten characters after trimming, and `VALIDATION_ERROR` for control characters, both
 * on `field: "reason"` — the same shape the void route documents, because a
 * rejection and a void are the same kind of operator prose (ADR-0011 D2).
 */
export function ApiExpenseRejectErrors(): ClassDecorator & MethodDecorator {
  return ApiErrorResponses({
    notFound:
      "No such society or expense — or one the caller is not an active member of. This API deliberately does not distinguish these (PRD T041).",
    forbidden:
      "An active member whose role does not hold `expense.approve`: Admin only. Rejecting is the other half of the approval decision, so a Treasurer or Committee Member cannot do it either.",
    conflict:
      "The expense moved since the caller read it (`VERSION_MISMATCH`, with `details[0].current` carrying the current version); or the expense is not awaiting approval, so there is nothing to reject (`INVALID_TRANSITION`).",
  });
}

/**
 * The error responses T068's revision-history read can return.
 *
 * A read, so no state can conflict: the 409 copy says so rather than documenting a
 * status a client might retry on. The 403 is the catalogue's narrowest read cell —
 * `expense.view` is every role but Guest — and the history is deliberately readable
 * by the same members the expense itself is visible to: the "edited" chip and its
 * tap-through are the transparency feature (PRD §3.5.3), not an officer-only audit
 * log. An expense with no revisions answers an empty list, never a 404.
 */
export function ApiExpenseRevisionErrors(): ClassDecorator & MethodDecorator {
  return ApiErrorResponses({
    notFound:
      "No such society or expense — or one the caller is not an active member of. An expense that has never been revised answers an empty list rather than 404. This API deliberately does not distinguish these (PRD T041).",
    forbidden:
      "An active member whose role does not hold `expense.view`: every role but Guest.",
    conflict:
      "Not produced by this route: the history is append-only and the read cannot conflict.",
  });
}

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
