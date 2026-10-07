import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  asExpenseError,
  canOnResource,
  expenseError,
  memberSnapshotOf,
} from "@ses/domain";
import type {
  AttachmentRepository,
  ExpenseId,
  ExpenseMembershipReader,
  ExpenseRepository,
  SocietyId,
  StorageProvider,
  UserId,
} from "@ses/domain";

import { MEMBERSHIP_READER } from "../../../../common/authorization/membership-reader";
import { STORAGE_PROVIDER } from "../../../../infrastructure/storage/storage.tokens";
import { ATTACHMENT_REPOSITORY } from "../../../attachments/application/attachment.tokens";
import { toAppError } from "../expense-category-error.mapper";
import { EXPENSE_REPOSITORY } from "../expense.tokens";
import {
  DELETE_FORBIDDEN,
  loadExpenseOrNotFound,
  loadMembershipOrNotFound,
  snapshotOf,
} from "./expense-draft.support";

/**
 * Hard-delete a draft — Roadmap T065, PRD §3.5's one delete.
 *
 * ## Creator only, and that is narrower than the matrix's ✅ cell on purpose
 *
 * The Roadmap's acceptance is "Drafts hard-deletable by their creator only" — not
 * "by their creator or a manager". A Treasurer who could delete somebody's draft
 * would erase their work rather than refuse it, and the PRD's own sentence names the
 * creator. So the flow is two gates: `canOnResource("expense.void", snapshot)` — the
 * 🟡 narrowing site the route inventory requires, which already refuses a Committee
 * Member another member's draft — and then an explicit `createdBy === membership.id`
 * check that narrows Admin and Treasurer too. The definer function enforces the same
 * thing inside the database; this layer's version exists to answer with a typed
 * refusal rather than a SQLSTATE.
 *
 * ## Hard, not soft
 *
 * There is no void event, no tombstone and no `deleted_at`: `expenses` has no such
 * columns (SAD §8.1's "never deleted — voided instead" tier), `DELETE` is not
 * granted, and the one path is `expense_draft_delete()` (migration
 * `20261004120000`, extended by `20261011120000`), which locks the row and checks
 * creator, draft-ness and the absence of splits before removing it. A published
 * expense is refused with `invalid_transition` — its door is T069's void.
 *
 * ## Its attachments, and why the objects are removed here — T071 (ADR-0012 D6.5)
 *
 * The polymorphic `(entity_type, entity_id)` pair cannot carry a foreign key, so
 * nothing at the table level stops an attachment row outliving the draft it points
 * at. T071 therefore extends the authoritative draft-deletion path: the definer
 * function removes the draft's attachment **rows** inside the same transaction that
 * locks and removes the draft, so a draft can never be observed gone with live
 * child rows — and this use case removes the **objects**, after the rows, best-effort.
 *
 * The order is the ADR's row-first/object-second philosophy (D6.3), and the failure
 * handling is the established one: a storage failure never resurrects the deleted
 * draft or its rows, is never reported as a failed transaction, and is logged with
 * enough to sweep. A stranded object is invisible; a surviving row pointing at a
 * deleted draft is a broken live reference.
 *
 * The keys are read **before** the delete, because after it there is nothing to
 * read: the rows are gone by design. A row inserted between the read and the delete
 * is removed by the function but its object is not swept by this call — which is the
 * accepted abandoned-object obligation the ADR records, not a gap introduced here.
 *
 * Note what this deliberately does **not** do: it does not re-implement the
 * attachment-delete authorization path. The caller has already passed creator-only,
 * draft-only and no-splits to reach this point, and the rows being removed are
 * children of the row being deleted — there is no per-attachment decision to make and
 * no route that could be used to delete one attachment of somebody else's draft.
 */
@Injectable()
export class DeleteDraftUseCase {
  private readonly logger = new Logger(DeleteDraftUseCase.name);

  constructor(
    @Inject(EXPENSE_REPOSITORY)
    private readonly expenses: ExpenseRepository,
    @Inject(MEMBERSHIP_READER)
    private readonly memberships: ExpenseMembershipReader,
    @Inject(ATTACHMENT_REPOSITORY)
    private readonly attachments: AttachmentRepository,
    @Inject(STORAGE_PROVIDER)
    private readonly storage: StorageProvider,
  ) {}

  async delete(
    actor: UserId,
    societyId: SocietyId,
    expenseId: ExpenseId,
  ): Promise<void> {
    const membership = await loadMembershipOrNotFound(
      this.memberships,
      actor,
      societyId,
    );

    const record = await loadExpenseOrNotFound(
      this.expenses,
      actor,
      societyId,
      expenseId,
    );

    const allowed = canOnResource(
      memberSnapshotOf(membership),
      "expense.void",
      snapshotOf(record),
    );
    if (!allowed || record.createdBy !== membership.id) {
      throw toAppError(expenseError("forbidden", DELETE_FORBIDDEN));
    }

    if (record.status !== "draft") {
      throw toAppError(
        expenseError(
          "invalid_transition",
          "Only a draft can be deleted. A published expense is voided instead.",
          { from: record.status },
        ),
      );
    }

    // The objects' keys, read before the rows disappear. A failure here is logged
    // and treated as "no keys": the user's intent is to delete the draft, and
    // blocking that on a metadata read would trade a recoverable orphan for an
    // operation the caller cannot complete. The rows still go (the definer function
    // removes them), so what remains is exactly the sweepable-object case D6.3
    // already accepts.
    const storageKeys = await this.readAttachmentKeys(
      record.id,
      societyId,
      actor,
    );

    try {
      await this.expenses.deleteDraft(record.id, societyId, actor);
    } catch (error: unknown) {
      throw toAppError(asExpenseError(error));
    }

    await this.deleteAttachmentObjects(storageKeys);
  }

  /**
   * The draft's attachment keys, or an empty list.
   *
   * Deliberately tolerant: an empty answer is a legitimate one (a draft with no
   * attachments), and a failed read is reported rather than thrown so the deletion
   * still runs. See the class note.
   */
  private async readAttachmentKeys(
    expenseId: ExpenseId,
    societyId: SocietyId,
    actor: UserId,
  ): Promise<readonly string[]> {
    try {
      return await this.attachments.listStorageKeysForExpense(
        expenseId,
        societyId,
        actor,
      );
    } catch (error: unknown) {
      this.logger.warn(
        `Could not read the attachment keys of draft expense ${expenseId} before ` +
          `deleting it. Its attachment rows will still be removed; any objects they ` +
          `named need the abandoned-object sweep. Cause: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
      return [];
    }
  }

  /**
   * Best-effort object removal, per the ADR's ordering.
   *
   * Each key is attempted independently: one failure must not stop the rest, and no
   * failure is allowed to make the caller believe the draft survived. The log line
   * carries the key, which SAD §10.3's own layout makes self-describing (society,
   * entity type, entity id, attachment id) — so a sweeper can act on the line alone.
   */
  private async deleteAttachmentObjects(
    storageKeys: readonly string[],
  ): Promise<void> {
    for (const storageKey of storageKeys) {
      try {
        await this.storage.delete(storageKey);
      } catch (error: unknown) {
        this.logger.warn(
          `Orphaned storage object after draft delete: key=${storageKey}. The draft ` +
            `and its attachment rows are gone and the object is unreachable through ` +
            `the API; it needs the abandoned-object sweep. Cause: ${
              error instanceof Error ? error.message : String(error)
            }`,
        );
      }
    }
  }
}
