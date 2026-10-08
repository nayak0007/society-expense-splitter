import { Module } from "@nestjs/common";
import { systemClock } from "@ses/domain";

import { DatabaseModule } from "../../infrastructure/database/database.module";
import { StorageModule } from "../../infrastructure/storage/storage.module";
import { AttachmentsModule } from "../attachments/attachments.module";
import { SOCIETY_REPOSITORY } from "../societies/application/society.tokens";
import { SocietiesModule } from "../societies/societies.module";
import { ExpenseCategoryOperations } from "./application/expense-category.operations";
import {
  EXPENSE_CATEGORY_REPOSITORY,
  EXPENSE_REFERENCE_READER,
} from "./application/expense-category.tokens";
import { ParticipantResolverService } from "./application/participant-resolver.service";
import {
  EXPENSE_PARTICIPANT_READER,
  EXPENSE_SOCIETY_READER,
} from "./application/participant.tokens";
import {
  EXPENSE_APPROVAL_POLICY_READER,
  EXPENSE_CLOCK,
  EXPENSE_COMMENT_REPOSITORY,
  EXPENSE_EVENT_PUBLISHER,
  EXPENSE_GST_DETAILS_REPOSITORY,
  EXPENSE_MEMBER_NAME_READER,
  EXPENSE_REPOSITORY,
  EXPENSE_REVISION_REPOSITORY,
  EXPENSE_SPLIT_REPOSITORY,
  EXPENSE_SPLITS_READER,
} from "./application/expense.tokens";
import { AddCommentUseCase } from "./application/use-cases/add-comment.use-case";
import { ApproveExpenseUseCase } from "./application/use-cases/approve-expense.use-case";
import { CreateExpenseUseCase } from "./application/use-cases/create-expense.use-case";
import { DeleteCommentUseCase } from "./application/use-cases/delete-comment.use-case";
import { ListCommentsUseCase } from "./application/use-cases/list-comments.use-case";
import { UpsertGstDetailsUseCase } from "./application/use-cases/upsert-gst-details.use-case";
import { DeleteDraftUseCase } from "./application/use-cases/delete-draft.use-case";
import { GetExpenseUseCase } from "./application/use-cases/get-expense.use-case";
import { ListApprovalQueueUseCase } from "./application/use-cases/list-approval-queue.use-case";
import { ListExpensesUseCase } from "./application/use-cases/list-expenses.use-case";
import { ListRevisionsUseCase } from "./application/use-cases/list-revisions.use-case";
import { ListSplitsUseCase } from "./application/use-cases/list-splits.use-case";
import { PreviewSplitUseCase } from "./application/use-cases/preview-split.use-case";
import { PublishExpenseUseCase } from "./application/use-cases/publish-expense.use-case";
import { RecalculateExpenseUseCase } from "./application/use-cases/recalculate-expense.use-case";
import { RejectExpenseUseCase } from "./application/use-cases/reject-expense.use-case";
import { UpdateExpenseUseCase } from "./application/use-cases/update-expense.use-case";
import { VoidExpenseUseCase } from "./application/use-cases/void-expense.use-case";
import { ExpenseCategoryRepositoryPostgres } from "./infrastructure/category.repository";
import { ExpenseCommentRepositoryPostgres } from "./infrastructure/comment.repository";
import { LoggingExpenseEventPublisher } from "./infrastructure/expense-event.publisher";
import { ExpenseGstDetailsRepositoryPostgres } from "./infrastructure/gst-details.repository";
import { ExpenseRepositoryPostgres } from "./infrastructure/expense.repository";
import { ExpenseParticipantRepositoryPostgres } from "./infrastructure/participant.repository";
import { ExpenseRevisionRepositoryPostgres } from "./infrastructure/revision.repository";
import { ExpenseSplitsReaderPostgres } from "./infrastructure/split-reader.repository";
import { ExpenseSplitRepositoryPostgres } from "./infrastructure/split.repository";
import { ExpenseCategoriesController } from "./presentation/categories.controller";
import { ExpensesController } from "./presentation/expenses.controller";

/**
 * The expenses feature module — Roadmap T062 (categories), T063 (participant
 * resolution) and T064 (the stateless split preview), with expense CRUD, publishing,
 * recalculation and attachments still to come.
 *
 * ## The dependency direction is the module's whole content
 *
 * ```
 * controller ──▶ ExpenseCategoryOperations ──▶ ExpenseCategoryRepository  (port, @ses/domain)
 *                          │                  ExpenseReferenceReader      (port, @ses/domain)
 *                          │                              ▲
 *                          │                  ExpenseCategoryRepositoryPostgres
 *                          │                              │
 *                          │                              └─ reads `expenses` too,
 *                          │                                 until T065/T066's adapter lands
 *                          │
 *                          └──▶ MEMBERSHIP_READER ──▶ SocietyRepositoryPostgres
 *                                   (common/)              (SocietiesModule)
 *
 * (T063, no route yet)
 * ParticipantResolverService ──▶ ExpenseParticipantReader  (port, @ses/domain)
 *          │                              ▲
 *          │                  ExpenseParticipantRepositoryPostgres
 *          │                              └─ reads `apartments`, `members`, `wings`,
 *          │                                 `buildings` — a projection, never a write
 *          ├──▶ ExpenseCategoryRepository ─▶ the category's `is_owner_only`
 *          ├──▶ ExpenseSocietyReader ──────▶ SocietyRepositoryPostgres
 *          │        (port, @ses/domain)         (SocietiesModule, for `bill_vacant_flats`)
 *          └──▶ MEMBERSHIP_READER ────────▶ SocietyRepositoryPostgres
 * ```
 *
 * ## Why the resolver is a provider with no controller
 *
 * T063's row names this module and the service file, and **no route**: resolution is an
 * internal capability whose two real callers are T064's preview endpoint and T066's
 * publish path, neither of which exists yet. A controller here would be a route nobody
 * asked for, behind a permission nobody chose — so the module exposes the service and
 * the e2e suite proves the graph resolves, which is the property that matters until a
 * route needs it.
 *
 * The arrows point one way, and this file is where that is enforced rather than
 * described: the interface token is what the application layer binds to, so the adapter
 * can be swapped (the e2e suite swaps it for an in-memory fake) without any file above
 * `infrastructure/` knowing. Importing `ExpenseCategoryRepositoryPostgres` from the
 * application layer would compile perfectly and would quietly make the domain depend on
 * Drizzle — SAD §3.1's one rule, broken invisibly.
 *
 * ## Why two tokens, one instance
 *
 * `EXPENSE_CATEGORY_REPOSITORY` and `EXPENSE_REFERENCE_READER` are both provided by
 * `ExpenseCategoryRepositoryPostgres` through `useExisting`, which means they resolve to
 * the *same object* — one adapter, so a second copy of the reads cannot exist. They stay
 * two tokens because they are two ports with two owners-to-be: the reference reader is the
 * narrow read T065's expense repository will satisfy, and re-binding it then must not
 * mean changing anything in the application layer. See `expense-category.tokens.ts`.
 *
 * ## Why `SocietiesModule` is imported
 *
 * For exactly one provider: `MEMBERSHIP_READER`, the caller's role in the society — which
 * the capability evaluation needs and which is *not* an expenses concern. The
 * implementation stays in the society module because that is where a `members` row
 * becomes a `SocietyMembership`; a second translation here would be a third copy of the
 * role/status/occupancy navigation tables, and a drifted copy of that map is silent (a
 * role read as `admin` in one and `guest` in the other).
 *
 * This is the sanctioned direction for a cross-module dependency (SAD §1.2): the token is
 * shared vocabulary in `common/authorization/`, and `SocietiesModule` exports its
 * provider. Nothing reaches into the society module's internals — and this module needed
 * no change to that module to be wired, which is the property the earlier design bought.
 *
 * `MEMBERSHIP_READER` is not re-exported. The structure module exports its repositories
 * because the member module's CSV import consumes them; nothing consumes the category
 * repository, and exporting it "in case" would invite a second module to reach for a
 * category read instead of declaring the port it actually needs.
 *
 * ## T071's two edges, and why neither is an inversion
 *
 * `AttachmentsModule` is imported for `ATTACHMENT_REPOSITORY` — the draft-deletion
 * cleanup reads a draft's storage keys before the definer function removes the rows —
 * and `StorageModule` for `STORAGE_PROVIDER`, which deletes the objects afterwards.
 * Both are *capabilities* rather than features: storage is infrastructure, and the
 * attachment repository is a port this module consumes without owning. Nothing here
 * reaches into the attachments module's internals, and the attachments module does
 * not depend on this one at all — which is what keeps the graph acyclic while both
 * modules legitimately need each other's data.
 *
 * ## Why `DatabaseModule` is imported explicitly
 *
 * Rather than reached for globally, following the reasoning that module records for
 * itself: the reader of this file should be able to see that this module writes to
 * Postgres.
 */
@Module({
  // `StorageModule` and `AttachmentsModule` are T071's contribution to this file,
  // and they are here for exactly one method: `DeleteDraftUseCase` removes a draft's
  // attachment **objects** after `expense_draft_delete()` has removed their rows
  // (ADR-0012 D6.5). The dependency runs one way — attachments never imports the
  // expenses module, which is why the settlement's repository reads `expenses`
  // through its own documented projection rather than through `EXPENSE_REPOSITORY`.
  imports: [DatabaseModule, SocietiesModule, StorageModule, AttachmentsModule],
  controllers: [ExpenseCategoriesController, ExpensesController],
  providers: [
    ExpenseCategoryOperations,
    ExpenseCategoryRepositoryPostgres,
    {
      provide: EXPENSE_CATEGORY_REPOSITORY,
      useExisting: ExpenseCategoryRepositoryPostgres,
    },
    {
      provide: EXPENSE_REFERENCE_READER,
      useExisting: ExpenseCategoryRepositoryPostgres,
    },
    // T063's resolver, and the three reads it composes. One instance per token, so a
    // test that swaps the participant reader cannot leave a second, real one in the
    // graph — the same reason the two category tokens exist.
    ParticipantResolverService,
    ExpenseParticipantRepositoryPostgres,
    {
      provide: EXPENSE_PARTICIPANT_READER,
      useExisting: ExpenseParticipantRepositoryPostgres,
    },
    {
      provide: EXPENSE_SOCIETY_READER,
      // The society module's own repository, borrowed through its exported token:
      // `ExpenseSocietyReader` is a structural subset of `SocietyRepository`
      // (`findById`), so this module reads `bill_vacant_flats` without owning SQL over
      // a table that is not its own.
      useExisting: SOCIETY_REPOSITORY,
    },
    // T064's preview. It composes the resolver above with `@ses/split-engine`'s
    // `computeSplit` — the same engine T066's publish will call, which is the whole
    // point of the endpoint: what the split editor previews is what the bill will be.
    PreviewSplitUseCase,
    // T065's repository and its five use cases. The adapter is bound through tokens
    // so the e2e suite can substitute an in-memory one, exactly as the category and
    // participant seams do; `EXPENSE_APPROVAL_POLICY_READER` borrows the society
    // module's own repository for the one `society_settings` field the threshold
    // rule reads, so this module owns no SQL over that table.
    ExpenseRepositoryPostgres,
    {
      provide: EXPENSE_REPOSITORY,
      useExisting: ExpenseRepositoryPostgres,
    },
    {
      provide: EXPENSE_APPROVAL_POLICY_READER,
      useExisting: SOCIETY_REPOSITORY,
    },
    { provide: EXPENSE_CLOCK, useValue: systemClock },
    CreateExpenseUseCase,
    UpdateExpenseUseCase,
    GetExpenseUseCase,
    // T070's approval queue. `ListExpensesUseCase` delegates its
    // `status=pending_approval` branch here, so the queue's one non-negotiable
    // filter lives in a single place rather than in the controller.
    ListApprovalQueueUseCase,
    ListExpensesUseCase,
    DeleteDraftUseCase,
    // T066's publication. The split repository is a second adapter (one transaction
    // around the `expense_publish()` definer function plus the retry record); the
    // member-name read borrows the participant adapter, so the module
    // still has exactly one reader of `members`; and the event publisher is the
    // post-commit seam T107 will re-bind.
    ExpenseSplitRepositoryPostgres,
    {
      provide: EXPENSE_SPLIT_REPOSITORY,
      useExisting: ExpenseSplitRepositoryPostgres,
    },
    {
      provide: EXPENSE_MEMBER_NAME_READER,
      useExisting: ExpenseParticipantRepositoryPostgres,
    },
    LoggingExpenseEventPublisher,
    {
      provide: EXPENSE_EVENT_PUBLISHER,
      useExisting: LoggingExpenseEventPublisher,
    },
    PublishExpenseUseCase,
    // T068's recalculation. It reads through the same two adapters publication uses
    // (the expense repository and the split writer, whose `expense_recalculate()`
    // transaction owns the revision, the due lifecycle and the balance deltas) and
    // re-runs the *same* resolution and engine path — there is no second split
    // algorithm in the module. The revision-history read is a third adapter, bound
    // through its own token because it is a different table with a different
    // lifetime (append-only).
    RecalculateExpenseUseCase,
    ExpenseRevisionRepositoryPostgres,
    {
      provide: EXPENSE_REVISION_REPOSITORY,
      useExisting: ExpenseRevisionRepositoryPostgres,
    },
    ListRevisionsUseCase,
    // T073's current-splits read. A second adapter over `expense_splits` — but read-only,
    // with its own token so the e2e suite substitutes it independently, and deliberately
    // separate from `EXPENSE_SPLIT_REPOSITORY` (whose adapter is the *write* path through
    // the definer transactions): a reader and a writer of one table are two capabilities
    // with two lifetimes, and a token a use case could write through would be the second
    // writer the split table must not have.
    ExpenseSplitsReaderPostgres,
    {
      provide: EXPENSE_SPLITS_READER,
      useExisting: ExpenseSplitsReaderPostgres,
    },
    ListSplitsUseCase,
    // T069's void. It reads through the same two adapters publication and
    // recalculation use — the expense repository for the row, and the split
    // writer, whose `expense_void()` transaction owns the due supersession, the
    // balance deltas and the void stamps — and dispatches `expense.voided`
    // through the same post-commit publisher, strictly after the transaction.
    VoidExpenseUseCase,
    // T070's two decisions. Both read through the expense repository, whose
    // `expense_approve()`/`expense_reject()` definer transactions own every rule
    // (Admin-only, the row lock, the lifecycle, the version, the stamps), and
    // neither touches a financial row: approval and rejection are workflow
    // decisions, and publication stays a separate act through `expense_publish()`.
    ApproveExpenseUseCase,
    RejectExpenseUseCase,
    // T072's GST details. A second table (`expense_gst_details`, 1:1 with the
    // expense) and its own adapter, bound through its own token for the reason the
    // revision and split adapters are: it is a different table with a different
    // writer, and the e2e suite substitutes it on its own. It reads the expense
    // through `EXPENSE_REPOSITORY`, so its authorisation narrowing and the amount
    // it reconciles against are the same ones every expense route uses.
    ExpenseGstDetailsRepositoryPostgres,
    {
      provide: EXPENSE_GST_DETAILS_REPOSITORY,
      useExisting: ExpenseGstDetailsRepositoryPostgres,
    },
    UpsertGstDetailsUseCase,
    // T072's comment stream. A third table and a third adapter; its reads and its
    // append are the repository's, and its one mutation is the database's
    // `expense_comment_soft_delete()` definer function.
    ExpenseCommentRepositoryPostgres,
    {
      provide: EXPENSE_COMMENT_REPOSITORY,
      useExisting: ExpenseCommentRepositoryPostgres,
    },
    AddCommentUseCase,
    ListCommentsUseCase,
    DeleteCommentUseCase,
  ],
})
export class ExpensesModule {}
