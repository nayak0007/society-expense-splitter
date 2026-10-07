import {
  asAttachmentError,
  attachmentError,
  canOnResource,
  isAttachableExpenseStatus,
  memberSnapshotOf,
} from "@ses/domain";
import type {
  AttachmentExpenseSnapshot,
  AttachmentMembershipReader,
  AttachmentRepository,
  ExpenseId,
  ExpenseResourceSnapshot,
  SocietyId,
  SocietyMembership,
  UserId,
} from "@ses/domain";

import { toAppError } from "../attachment-error.mapper";

/**
 * The pieces every attachment use case repeats — the two loaders, the lifecycle
 * gate and the resource snapshot — in one place, so three files cannot drift.
 *
 * A support file beside the three use cases the Roadmap names, and deliberately
 * *not* a fourth use case: nothing here orchestrates. Each function is one rule with
 * one owner, stated once rather than three times.
 *
 * ## The vocabulary is the expense module's, not a new one
 *
 * `canOnResource` is called with an `ExpenseResourceSnapshot` and the existing
 * `expense.create`/`expense.void` cells (ADR-0012 D5). There is no `attachment.*`
 * action anywhere — `ACTIONS` has none and PRD §2.1 has no attachment row, so
 * inventing one would mean fabricating a product decision, and
 * `docs/guides/AUTHORIZATION.md` §4 forbids the inline role check that would
 * replace it.
 */

/** No membership and a removed one are one answer — PRD T041's 404-not-403. */
export const ATTACHMENT_SOCIETY_NOT_FOUND =
  "That society is not available to you.";

/** The refusal a caller reads when `canOnResource` says no to a create. */
export const ATTACHMENT_CREATE_FORBIDDEN =
  "Only a society Admin, Treasurer or Committee Member can add a bill to this expense.";

/** The refusal a caller reads when narrowing says no to a delete. */
export const ATTACHMENT_DELETE_FORBIDDEN =
  "Only the member who uploaded this file, or a member who can manage this expense, can delete it.";

/** Why an expense cannot acquire an attachment (ADR-0012 D6.1). */
export const ATTACHMENT_VOID_EXPENSE =
  "A void expense is a closed record and cannot take new bills.";

/** The caller's membership, or `not_found`. */
export async function loadMembershipOrNotFound(
  memberships: AttachmentMembershipReader,
  actor: UserId,
  societyId: SocietyId,
): Promise<SocietyMembership> {
  let membership: SocietyMembership | null;
  try {
    membership = await memberships.findMembership(societyId, actor);
  } catch (error: unknown) {
    throw toAppError(asAttachmentError(error));
  }

  if (membership === null || membership.status === "removed") {
    throw toAppError(
      attachmentError("not_found", ATTACHMENT_SOCIETY_NOT_FOUND),
    );
  }
  return membership;
}

/** One expense of the caller's society, or `not_found`. */
export async function loadExpenseOrNotFound(
  attachments: AttachmentRepository,
  actor: UserId,
  societyId: SocietyId,
  expenseId: ExpenseId,
): Promise<AttachmentExpenseSnapshot> {
  let snapshot: AttachmentExpenseSnapshot | null;
  try {
    snapshot = await attachments.findExpenseForAttachment(
      expenseId,
      societyId,
      actor,
    );
  } catch (error: unknown) {
    throw toAppError(asAttachmentError(error));
  }

  if (snapshot === null) {
    throw toAppError(
      attachmentError("not_found", "That expense is not available to you."),
    );
  }
  return snapshot;
}

/**
 * ADR-0012 D6.1's lifecycle gate: `draft`, `pending_approval` and `published` may
 * acquire attachments; `void` may not.
 *
 * **Fail closed on anything else.** The comparison is against a closed list
 * (`isAttachableExpenseStatus`) rather than against `status !== "void"`, because a
 * status this module has never heard of — a future enum value, a hand-edited row —
 * must be refused rather than admitted. The `status` field on the projection is the
 * raw stored string for exactly this reason: the gate can see a novel value and say
 * no, where a typed union would have coerced it away.
 *
 * The refusal is `invalid_transition` and it **mutates nothing on the expense**.
 * A voided expense is immutable historical financial evidence, so the correct
 * answer is a refusal, not a repair.
 */
export function assertExpenseAcceptsAttachments(
  expense: AttachmentExpenseSnapshot,
): void {
  if (isAttachableExpenseStatus(expense.status)) return;

  throw toAppError(
    attachmentError("invalid_transition", ATTACHMENT_VOID_EXPENSE, {
      from: expense.status,
    }),
  );
}

/**
 * The stored expense, reduced to the facts authorisation reads.
 *
 * `published` is `status !== "draft"`, exactly as `expense-draft.support.ts` defines
 * it — the matrix's two states as the PRD's own cells draw them, and the *stricter*
 * reading for the 🟡 "own drafts" cell: a `pending_approval` expense is not a draft,
 * so a Committee Member's `expense.void` grant does not cover it. Admin and
 * Treasurer hold both cells outright, so the field never narrows them.
 */
export function snapshotOf(
  expense: AttachmentExpenseSnapshot,
): ExpenseResourceSnapshot {
  return {
    kind: "expense",
    societyId: expense.societyId,
    createdByMembershipId: expense.createdBy,
    published: expense.status !== "draft",
  };
}

/**
 * The 🟡 narrowing site every mutating route needs, or a `forbidden` refusal.
 *
 * Returns the verdict rather than throwing for *creates* (which need the caller to
 * pick the message) and is used directly for deletes; both go through
 * `canOnResource`, so there is one definition of "may this member do this to this
 * record". The route inventory's `NARROWED_ROUTES` list names every route that
 * calls this, and that suite fails on purpose if a scoped route is declared without
 * one.
 */
export function mayOnExpense(
  membership: SocietyMembership,
  action: "expense.create" | "expense.void" | "expense.view",
  expense: AttachmentExpenseSnapshot,
): boolean {
  return canOnResource(
    memberSnapshotOf(membership),
    action,
    snapshotOf(expense),
  );
}
